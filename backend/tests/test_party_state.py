"""Phase 6 gate: PartyState lifecycle + ``party_live_hit`` over a real WS client.

Two layers:

  * Unit — :class:`PartyState` record/stop/reset numbers (duration floor, rates,
    per-target dps, status vs results shapes) match the old backend exactly.
  * Integration — a real ``DPSMeterServer`` on an EPHEMERAL port (never 8765):
    drive ``party_start_recording`` → status, feed hits via ``ingest_lines`` and
    observe ``party_live_hit`` frames while active, then ``party_stop_recording``
    → results + ``party_stats_reset``. Also checks the live ``stats`` envelope's
    ``party_status`` reflects the real state, and that hits ingested while NOT
    recording emit nothing.

The response envelopes are the gold-captured shapes from
``fixtures/gold_command_probes.json`` (``status`` from ``get_status``; ``results``
from ``get_results``).
"""
from __future__ import annotations

import asyncio
import json

import pytest
import websockets

from dps_meter_server import DPSMeterServer
from party_state import PartyState


# --- log-line helper (grammar per SCHEMAS.md) ------------------------------
def _line(ts: str, skill: str, dmg: int, crit: bool, heavy: bool,
          target: str, caster: str = "Hero") -> str:
    """A DamageDone CSV row: ts,DamageDone,skill,id,dmg,crit,heavy,type,caster,target."""
    return (f"{ts},DamageDone,{skill},1,{dmg},{int(crit)},{int(heavy)},"
            f"kHit,{caster},{target}")


# Two targets, three hits; first hit at :00, last at :02 -> duration 2.0s.
HITS = [
    _line("20260530-12:00:00:000", "Fireball", 1000, True, False, "Goblin"),
    _line("20260530-12:00:01:000", "Slash", 500, False, False, "Goblin"),
    _line("20260530-12:00:02:000", "Smash", 800, False, True, "Orc"),
]


# ===========================================================================
# Unit: PartyState numbers + lifecycle.
# ===========================================================================
def test_partystate_lifecycle_numbers():
    ps = PartyState()
    # Fresh state: nothing recorded, not active.
    assert ps.get_status() == {
        "encounter_active": False, "party_code": None,
        "total_damage": 0, "target_count": 0,
    }
    assert ps.get_results() == {"targets": [], "total_damage": 0, "duration": 0, "fight_ts": None}

    # Hits before recording are ignored (record_hit no-ops when inactive).
    from combat_log_parser import parse_line
    parts = [parse_line(line) for line in HITS]
    for partial in parts:
        ps.record_hit(partial["target"], partial["damage"],
                      partial["is_crit"], partial["is_heavy"], partial["_timestamp"])
    assert ps.get_status()["total_damage"] == 0

    # Arm, record the three hits.
    ps.start_recording("ABCD")
    assert ps.encounter_active is True
    assert ps.party_code == "ABCD"
    for partial in parts:
        ps.record_hit(partial["target"], partial["damage"],
                      partial["is_crit"], partial["is_heavy"], partial["_timestamp"])

    status = ps.get_status()
    assert status == {
        "encounter_active": True, "party_code": "ABCD",
        "total_damage": 2300, "target_count": 2,
    }

    # Stop returns final results and disarms.
    results = ps.stop_recording()
    assert ps.encounter_active is False
    assert results["total_damage"] == 2300
    assert results["duration"] == 2.0
    # fight_ts = epoch ms of the first recorded hit (for the party relay post_fight).
    assert results["fight_ts"] == int(parts[0]["_timestamp"].timestamp() * 1000)
    by_target = {t["target"]: t for t in results["targets"]}
    assert set(by_target) == {"Goblin", "Orc"}
    g = by_target["Goblin"]
    assert g["total_damage"] == 1500 and g["hits"] == 2
    assert g["crit_rate"] == 50.0 and g["heavy_rate"] == 0.0
    assert g["dps"] == round(1500 / 2.0, 1)
    o = by_target["Orc"]
    assert o["total_damage"] == 800 and o["hits"] == 1
    assert o["heavy_rate"] == 100.0 and o["crit_rate"] == 0.0

    # Reset clears accumulators but leaves encounter_active alone.
    ps.reset_stats()
    assert ps.get_status()["total_damage"] == 0
    assert ps.get_status()["target_count"] == 0
    assert ps.encounter_active is False


def test_duration_floors_at_one_second():
    """A single instantaneous hit still reports a >=1.0s duration (no div-by-zero)."""
    ps = PartyState()
    ps.start_recording()
    from combat_log_parser import parse_line
    p1 = parse_line(_line("20260530-12:00:00:000", "Fireball", 1000, False, False, "Goblin"))
    ps.record_hit(p1["target"], p1["damage"], p1["is_crit"], p1["is_heavy"], p1["_timestamp"])
    res = ps.get_results()
    assert res["duration"] == 1.0
    assert res["targets"][0]["dps"] == 1000.0


def test_c1b_full_hit_retention_and_rotation_slice():
    """C1b: every hit is retained in the solo-hit shape; the final post
    (``include_hits=True``) emits them as ``rotation`` while the live default stays
    byte-identical, and the retained hits drop straight into the solo aggregators."""
    from combat_log_parser import parse_line
    from combat_stats import _skills, _targets
    ps = PartyState()
    ps.start_recording("ROOM")
    parts = [parse_line(line) for line in HITS]
    for p in parts:
        # Mirror the server call: thread skill + clock through (A3/C1b).
        ps.record_hit(p["target"], p["damage"], p["is_crit"], p["is_heavy"],
                      p["_timestamp"], skill=p["skill"], time=p["time"])

    # Default (live-tick) path is unchanged — no rotation key leaks in.
    assert "rotation" not in ps.get_results()

    # Final post carries the full hit-by-hit slice, in solo-hit shape.
    full = ps.get_results(include_hits=True)
    rot = full["rotation"]
    assert len(rot) == 3
    assert [h["skill"] for h in rot] == ["Fireball", "Slash", "Smash"]
    assert [h["target"] for h in rot] == ["Goblin", "Goblin", "Orc"]
    assert [h["damage"] for h in rot] == [1000, 500, 800]
    # relative_time = seconds from the encounter's first hit (1 dp); first = 0.0.
    assert [h["relative_time"] for h in rot] == [0.0, 1.0, 2.0]
    assert rot[0]["is_crit"] is True and rot[2]["is_heavy"] is True
    assert rot[0]["time"] == parts[0]["time"]
    # Keys match the solo hit shape so the solo renderers drop in unchanged.
    assert set(rot[0]) == {"time", "relative_time", "skill", "target",
                           "damage", "is_crit", "is_heavy"}

    # The retained hits feed the solo aggregators directly (no transform = no drift).
    skills = _skills(rot, full["total_damage"])
    assert {s["name"] for s in skills} == {"Fireball", "Slash", "Smash"}
    assert next(s for s in skills if s["name"] == "Fireball")["crits"] == 1
    targets = _targets(rot, full["total_damage"])
    assert {t["name"]: t["damage"] for t in targets} == {"Goblin": 1500, "Orc": 800}

    # stop_recording is a final post → carries the slice; the bare default stays light.
    assert len(ps.stop_recording(include_hits=True)["rotation"]) == 3
    ps2 = PartyState()
    ps2.start_recording()
    for p in parts:
        ps2.record_hit(p["target"], p["damage"], p["is_crit"], p["is_heavy"], p["_timestamp"])
    assert "rotation" not in ps2.stop_recording()
    # Empty encounter still yields an empty list (not a missing key) when asked.
    assert PartyState().get_results(include_hits=True)["rotation"] == []


def test_c1b_rotation_scoped_per_encounter():
    """Each PartyEncounter retains only its OWN hits; a boundary (leader id) starts a
    fresh slice with relative_time re-zeroed."""
    from combat_log_parser import parse_line
    ps = PartyState()
    ps.start_recording()
    a = parse_line(_line("20260530-12:00:00:000", "Fireball", 1000, False, False, "BossA"))
    ps.record_hit(a["target"], a["damage"], a["is_crit"], a["is_heavy"], a["_timestamp"],
                  encounter_id="E1", skill=a["skill"], time=a["time"])
    b = parse_line(_line("20260530-12:05:00:000", "Slash", 700, False, False, "BossB"))
    ps.record_hit(b["target"], b["damage"], b["is_crit"], b["is_heavy"], b["_timestamp"],
                  encounter_id="E2", skill=b["skill"], time=b["time"])
    assert len(ps.encounters) == 2
    e1 = ps.get_results(encounter_id="E1", include_hits=True)
    e2 = ps.get_results(encounter_id="E2", include_hits=True)
    assert [h["skill"] for h in e1["rotation"]] == ["Fireball"]
    assert [h["skill"] for h in e2["rotation"]] == ["Slash"]
    assert e2["rotation"][0]["relative_time"] == 0.0


# ===========================================================================
# Integration: real WS client.
# ===========================================================================
async def _recv_until(ws, pred, *, timeout=4.0):
    """Read frames until ``pred(msg)`` is true (or timeout -> None)."""
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


def _run(coro):
    return asyncio.run(coro)


def test_party_recording_over_ws(tmp_path):
    _run(_party_flow(tmp_path))


async def _party_flow(tmp_path):
    data = tmp_path / "data"
    data.mkdir()
    holder = _Server(data)
    async with holder as srv:
        async with websockets.connect(holder.uri(), max_size=None) as ws:
            # 1. Start recording -> party_recording_started + active status.
            started = await _request(ws, "party_start_recording", "party_recording_started",
                                     party_code="ROOM1")
            assert started is not None
            assert started["status"] == {
                "encounter_active": True, "party_code": "ROOM1",
                "total_damage": 0, "target_count": 0,
            }
            assert srv.party.encounter_active is True

            # 2. Feed hits (on the loop) -> one party_live_hit per hit, in order.
            srv.ingest_lines(HITS)
            seen = []
            for _ in HITS:
                frame = await _recv_until(ws, lambda m: m.get("type") == "party_live_hit")
                assert frame is not None, "expected a party_live_hit frame"
                seen.append(frame)
            # hit payload shape + order
            assert [f["hit"]["target"] for f in seen] == ["Goblin", "Goblin", "Orc"]
            assert seen[0]["hit"] == {"target": "Goblin", "damage": 1000,
                                      "is_crit": True, "is_heavy": False}
            # totals ride along and converge to the full encounter
            assert seen[-1]["totals"]["total_damage"] == 2300
            assert seen[-1]["totals"]["duration"] == 2.0

            # 3. party_status is surfaced in the live stats envelope.
            stats = await _recv_until(ws, lambda m: m.get("type") == "stats")
            assert stats is not None
            assert stats["party_status"] == {
                "encounter_active": True, "party_code": "ROOM1",
                "total_damage": 2300, "target_count": 2,
            }

            # 4. Stop -> results + disarmed status.
            stopped = await _request(ws, "party_stop_recording", "party_recording_stopped")
            assert stopped is not None
            assert stopped["results"]["total_damage"] == 2300
            assert stopped["results"]["duration"] == 2.0
            assert stopped["status"]["encounter_active"] is False
            assert srv.party.encounter_active is False

            # 5. Hits ingested while NOT recording emit no party_live_hit.
            srv.ingest_lines(HITS)
            none_frame = await _recv_until(
                ws, lambda m: m.get("type") == "party_live_hit", timeout=0.6)
            assert none_frame is None, "no party_live_hit should fire while stopped"

            # 6. Reset -> party_stats_reset with zeroed status.
            reset = await _request(ws, "party_reset_stats", "party_stats_reset")
            assert reset is not None
            assert reset["status"]["total_damage"] == 0
            assert reset["status"]["target_count"] == 0
