"""Regression test: party_code is nulled and status is clean after clear_party.

Root cause: party_code was never cleared on leave, so get_status() kept returning
the stale code, clobbering any freshly-generated create/join code on the frontend.

Fix: PartyState.clear_party() nulls party_code + wipes accumulators + disarms;
_h_clear_party wires it to the "clear_party" WS command.

Two layers:
  * Unit — PartyState.clear_party() unit contract.
  * Integration — "clear_party" WS command → party_cleared reply with clean status.
"""
from __future__ import annotations

import asyncio
import json

import pytest
import websockets

from dps_meter_server import DPSMeterServer
from party_state import PartyState


# ---------------------------------------------------------------------------
# Helpers shared with test_party_state (inline to keep the test self-contained)
# ---------------------------------------------------------------------------
def _line(ts: str, skill: str, dmg: int, crit: bool, heavy: bool,
          target: str, caster: str = "Hero") -> str:
    return (f"{ts},DamageDone,{skill},1,{dmg},{int(crit)},{int(heavy)},"
            f"kHit,{caster},{target}")


HITS = [
    _line("20260530-12:00:00:000", "Fireball", 1000, True, False, "Goblin"),
    _line("20260530-12:00:01:000", "Slash",    500,  False, False, "Goblin"),
    _line("20260530-12:00:02:000", "Smash",    800,  False, True,  "Orc"),
]


# ===========================================================================
# Unit: PartyState.clear_party() contract
# ===========================================================================

def test_clear_party_nulls_code_and_wipes():
    """After start + record + clear: party_code=None, no damage, disarmed."""
    from combat_log_parser import parse_line

    ps = PartyState()
    ps.start_recording("STALE_CODE")
    parts = [parse_line(line) for line in HITS]
    for p in parts:
        ps.record_hit(p["target"], p["damage"], p["is_crit"], p["is_heavy"], p["_timestamp"])

    # Confirm data is live before clear.
    assert ps.party_code == "STALE_CODE"
    assert ps.encounter_active is True
    assert ps.get_status()["total_damage"] == 2300

    # Act.
    ps.clear_party()

    # party_code is gone.
    assert ps.party_code is None

    # encounter is disarmed.
    assert ps.encounter_active is False

    # Status payload emits None, not the stale code.
    status = ps.get_status()
    assert status["party_code"] is None, (
        "get_status() must not emit the stale party_code after clear_party()"
    )
    assert status["encounter_active"] is False
    assert status["total_damage"] == 0
    assert status["target_count"] == 0

    # Results also clean.
    results = ps.get_results()
    assert results["targets"] == []
    assert results["total_damage"] == 0


def test_clear_party_on_fresh_state():
    """clear_party() on an uninitialized PartyState is a safe no-op."""
    ps = PartyState()
    ps.clear_party()
    assert ps.party_code is None
    assert ps.encounter_active is False
    assert ps.get_status() == {
        "encounter_active": False,
        "party_code": None,
        "total_damage": 0,
        "target_count": 0,
    }


def test_clear_party_allows_fresh_code():
    """After clear, a new start_recording with a different code works normally."""
    ps = PartyState()
    ps.start_recording("OLD_CODE")
    ps.clear_party()

    ps.start_recording("NEW_CODE")
    assert ps.party_code == "NEW_CODE"
    assert ps.encounter_active is True
    assert ps.get_status()["party_code"] == "NEW_CODE"


def test_status_never_emits_stale_code_after_leave():
    """Core regression: get_status() returns party_code=None, not the old value."""
    ps = PartyState()
    ps.start_recording("WILL_BE_STALE")
    ps.clear_party()

    # Simulate what the frontend status-sync loop sees.
    live_status = ps.get_status()
    assert live_status["party_code"] is None, (
        "REGRESSION: status-sync would clobber a fresh code with the stale one"
    )


# ===========================================================================
# Integration: "clear_party" WS command
# ===========================================================================

class _Server:
    def __init__(self, data_dir):
        self.srv = DPSMeterServer(str(data_dir), port=0, broadcast_interval=0.1)

    async def __aenter__(self):
        await self.srv.start()
        return self.srv

    async def __aexit__(self, *exc):
        await self.srv.stop()

    def uri(self):
        return f"ws://localhost:{self.srv.port}"


async def _recv_until(ws, pred, *, timeout=4.0):
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while True:
        remaining = deadline - loop.time()
        if remaining <= 0:
            return None
        try:
            raw = await asyncio.wait_for(ws.recv(), remaining)
        except asyncio.TimeoutError:
            return None
        msg = json.loads(raw)
        if pred(msg):
            return msg


async def _request(ws, command, want_type, **kw):
    await ws.send(json.dumps({"command": command, **kw}))
    return await _recv_until(ws, lambda m: m.get("type") == want_type)


def _run(coro):
    return asyncio.run(coro)


def test_clear_party_ws_command(tmp_path):
    _run(_clear_party_ws_flow(tmp_path))


async def _clear_party_ws_flow(tmp_path):
    data = tmp_path / "data"
    data.mkdir()
    holder = _Server(data)
    async with holder as srv:
        async with websockets.connect(holder.uri(), max_size=None) as ws:
            # 1. Start a party session with a known code.
            started = await _request(ws, "party_start_recording", "party_recording_started",
                                     party_code="STALE_CODE")
            assert started is not None
            assert started["status"]["party_code"] == "STALE_CODE"

            # 2. Ingest some hits so the accumulators have data.
            srv.ingest_lines(HITS)
            # Drain live-hit frames so they don't bleed into later assertions.
            for _ in HITS:
                await _recv_until(ws, lambda m: m.get("type") == "party_live_hit",
                                  timeout=1.0)

            # 3. Send clear_party (the leave command).
            cleared = await _request(ws, "clear_party", "party_cleared")
            assert cleared is not None, "clear_party command must reply with party_cleared"

            status = cleared["status"]
            assert status["party_code"] is None, (
                "party_cleared status must have party_code=None, not the stale code"
            )
            assert status["encounter_active"] is False
            assert status["total_damage"] == 0
            assert status["target_count"] == 0

            # 4. Server-side state is also clean.
            assert srv.party.party_code is None
            assert srv.party.encounter_active is False
            assert srv._party_session_active is False

            # 5. A subsequent start_recording with a NEW code is not clobbered.
            restarted = await _request(ws, "party_start_recording", "party_recording_started",
                                       party_code="FRESH_CODE")
            assert restarted is not None
            assert restarted["status"]["party_code"] == "FRESH_CODE", (
                "REGRESSION: fresh code must not be overwritten by the stale one"
            )
            assert restarted["status"]["encounter_active"] is True
