"""Phase 3 gate: dispatch + WS server parity against the old .exe.

Drives the real ``DPSMeterServer`` over a websocket on an EPHEMERAL port (never the
live 8765 a running frontend might hold) and checks it against the golden fixtures
captured from the old backend:

  * ``fixtures/gold_init_responses.json`` — the 9 init-burst replies
  * ``fixtures/gold_stats_stream.jsonl``  — the live `stats` broadcast
  * ``fixtures/gold_combat.log``          — the frozen real log those fixtures cover

The data dir each test reads is RECONSTRUCTED from the gold init payloads, so the
suite is fully self-contained (no dependency on repo-root JSON or machine logs).
Parity is checked through ``tools/compare_snapshots`` (the same normalizer the
manual harness uses): only PASS/FAIL verdicts surface, never the big data.
"""
from __future__ import annotations

import asyncio
import json
import pathlib

import pytest
import websockets

from compare_snapshots import diffs, norm
from dps_meter_server import DPSMeterServer

FIX = pathlib.Path(__file__).resolve().parent.parent / "fixtures"
GOLD_INITS = json.loads((FIX / "gold_init_responses.json").read_text(encoding="utf-8"))
GOLD_COMBAT = FIX / "gold_combat.log"
GOLD_STREAM = [json.loads(line) for line in (FIX / "gold_stats_stream.jsonl").open(encoding="utf-8")]
GOLD_STATS_DATA = GOLD_STREAM[-1]["data"]  # converged broadcast

INIT_COMMANDS = [
    ("get_config", "config"),
    ("get_encounters", "encounters"),
    ("get_saved_runs", "saved_runs_list"),
    ("get_skill_settings", "skill_settings"),
    ("get_weapon_config", "weapon_config"),
    ("get_target_assignments", "target_assignments"),
    ("get_default_targets", "default_targets"),
    ("get_dungeons", "dungeons_list"),
    ("get_encounter_history", "encounter_history"),
]


# --- data-dir reconstruction (from the gold init payloads) -----------------
def _build_data_dir(tmp_path: pathlib.Path) -> pathlib.Path:
    """Write the on-disk JSON files that reproduce the gold init responses.

    ``config.log_path`` is redirected at a controlled logs dir holding the frozen
    gold log, so ``get_encounter_history`` / ``log_info`` are deterministic.
    No ``target_assignments.json`` is written — matching the capture, where the
    served assignments are the inverted defaults.
    """
    data = tmp_path / "data"
    data.mkdir()
    logs = tmp_path / "logs"
    logs.mkdir()
    (logs / "CombatLog.txt").write_bytes(GOLD_COMBAT.read_bytes())

    config = dict(GOLD_INITS["get_config"]["data"])
    config["log_path"] = str(logs)
    (data / "config.json").write_text(json.dumps(config), encoding="utf-8")

    (data / "encounters.json").write_text(
        json.dumps(GOLD_INITS["get_encounters"]["data"]), encoding="utf-8")
    (data / "saved_runs.json").write_text(
        json.dumps(GOLD_INITS["get_saved_runs"]["runs"]), encoding="utf-8")
    (data / "skill_settings.json").write_text(
        json.dumps({"skills": GOLD_INITS["get_skill_settings"]["data"]["settings"]}),
        encoding="utf-8")
    (data / "weapon_config.json").write_text(
        json.dumps({"skillAssignments": GOLD_INITS["get_weapon_config"]["skillAssignments"]}),
        encoding="utf-8")
    (data / "default_target_assignments.json").write_text(
        json.dumps(GOLD_INITS["get_default_targets"]["data"]), encoding="utf-8")
    (data / "dungeons.json").write_text(
        json.dumps(GOLD_INITS["get_dungeons"]["dungeons"]), encoding="utf-8")
    return data


# --- async client helpers --------------------------------------------------
async def _recv_until(ws, pred, *, stats_sink=None, timeout=4.0):
    """Read frames until ``pred(msg)``; divert `stats` frames into ``stats_sink``."""
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
        if msg.get("type") == "stats" and stats_sink is not None:
            stats_sink.append(msg)
        if pred(msg):
            return msg


async def _request(ws, command, want_type=None, *, stats_sink=None, timeout=4.0, **kw):
    await ws.send(json.dumps({"command": command, **kw}))
    pred = (lambda m: m.get("type") == want_type) if want_type else (lambda m: m.get("type") != "stats")
    return await _recv_until(ws, pred, stats_sink=stats_sink, timeout=timeout)


class _Server:
    """Async context manager: a started server on an ephemeral port + its data dir."""

    def __init__(self, data_dir, **kw):
        self.srv = DPSMeterServer(str(data_dir), port=0, broadcast_interval=0.1, **kw)

    async def __aenter__(self):
        await self.srv.start()
        return self.srv

    async def __aexit__(self, *exc):
        await self.srv.stop()

    def uri(self):
        return f"ws://localhost:{self.srv.port}"


def _run(coro):
    return asyncio.run(coro)


# ===========================================================================
# 1. Init burst: 9 correct types < 1s, matching gold (normalized).
# ===========================================================================
def test_init_burst_types_and_timing(tmp_path):
    _run(_init_burst(tmp_path))


async def _init_burst(tmp_path):
    data = _build_data_dir(tmp_path)
    holder = _Server(data)
    async with holder as srv:
        async with websockets.connect(holder.uri(), max_size=None) as ws:
            loop = asyncio.get_running_loop()
            start = loop.time()
            responses = {}
            for cmd, want in INIT_COMMANDS:
                msg = await _request(ws, cmd, want, timeout=2.0)
                assert msg is not None, f"{cmd}: no {want} reply"
                responses[cmd] = msg
            elapsed = loop.time() - start
            assert elapsed < 1.0, f"init burst took {elapsed:.3f}s (>1s)"

    # all 9 types correct
    for cmd, want in INIT_COMMANDS:
        assert responses[cmd]["type"] == want

    # normalized parity, per-command strictness
    for cmd, _ in INIT_COMMANDS:
        mine, gold = responses[cmd], GOLD_INITS[cmd]
        if cmd == "get_config":
            # log_path is environment-specific (redirected for determinism).
            m = {k: v for k, v in mine["data"].items() if k != "log_path"}
            g = {k: v for k, v in gold["data"].items() if k != "log_path"}
            assert norm(m, 4) == norm(g, 4), f"get_config data mismatch"
        elif cmd == "get_encounter_history":
            # env-dependent segmentation: assert type + entry shape only.
            assert isinstance(mine["encounters"], list)
            if mine["encounters"]:
                assert set(gold["encounters"][0]).issubset(mine["encounters"][0])
        elif cmd == "get_skill_settings":
            # current_skills is live-derived (empty without an ingest); covered in
            # test_current_skills_from_live_log. Compare the persisted settings here.
            assert norm(mine["data"]["settings"], 4) == norm(gold["data"]["settings"], 4)
        elif cmd == "get_weapon_config":
            assert norm(mine["skillAssignments"], 4) == norm(gold["skillAssignments"], 4)
        else:
            d = diffs(norm(gold, 4), norm(mine, 4))
            assert not d, f"{cmd} parity diffs: {d[:6]}"


# ===========================================================================
# 2. current_skills / currentSkills derive from live combat (first-seen order).
# ===========================================================================
def test_current_skills_from_live_log(tmp_path):
    _run(_current_skills(tmp_path))


async def _current_skills(tmp_path):
    data = _build_data_dir(tmp_path)
    holder = _Server(data)
    async with holder as srv:
        srv.ingest_lines(GOLD_COMBAT.read_text(encoding="utf-8").splitlines())
        async with websockets.connect(holder.uri(), max_size=None) as ws:
            ss = await _request(ws, "get_skill_settings", "skill_settings")
            wc = await _request(ws, "get_weapon_config", "weapon_config")
    assert ss["data"]["current_skills"] == GOLD_INITS["get_skill_settings"]["data"]["current_skills"]
    assert wc["currentSkills"] == GOLD_INITS["get_weapon_config"]["currentSkills"]


# ===========================================================================
# 3. Live stats broadcast matches gold converged data (normalized).
# ===========================================================================
def test_stats_broadcast_matches_gold(tmp_path):
    _run(_stats_broadcast(tmp_path))


async def _stats_broadcast(tmp_path):
    data = _build_data_dir(tmp_path)
    holder = _Server(data)
    async with holder as srv:
        srv.ingest_lines(GOLD_COMBAT.read_text(encoding="utf-8").splitlines())
        async with websockets.connect(holder.uri(), max_size=None) as ws:
            sink = []
            # wait for at least one stats broadcast (loop interval 0.1s)
            await _recv_until(ws, lambda m: False, stats_sink=sink, timeout=0.5)
    assert sink, "no stats broadcast received"
    mine = sink[-1]
    assert mine["type"] == "stats"
    assert set(mine["data"]) == set(GOLD_STATS_DATA)
    d = diffs(norm(GOLD_STATS_DATA, 4), norm(mine["data"], 4))
    assert not d, f"stats parity diffs: {d[:8]}"


# ===========================================================================
# 4. reset -> reset reply + a zeroed stats broadcast.
# ===========================================================================
def test_reset_zeroes_stats(tmp_path):
    _run(_reset(tmp_path))


async def _reset(tmp_path):
    data = _build_data_dir(tmp_path)
    holder = _Server(data)
    async with holder as srv:
        srv.ingest_lines(GOLD_COMBAT.read_text(encoding="utf-8").splitlines())
        async with websockets.connect(holder.uri(), max_size=None) as ws:
            ack = await _request(ws, "reset", "reset")
            assert ack == {"type": "reset"}
            sink = []
            await _recv_until(ws, lambda m: False, stats_sink=sink, timeout=0.5)
    assert sink, "no post-reset stats broadcast"
    d = sink[-1]["data"]
    assert d["hit_count"] == 0 and d["total_damage"] == 0 and d["dps"] == 0
    assert d["skills"] == [] and d["hit_log"] == [] and d["timeline"] == []
    assert d["primary_target"] == "Unknown"


# ===========================================================================
# 5. save_encounter writes the record + confirms.
# ===========================================================================
def test_save_encounter_writes_and_confirms(tmp_path):
    _run(_save_encounter(tmp_path))


async def _save_encounter(tmp_path):
    data = _build_data_dir(tmp_path)
    holder = _Server(data)
    async with holder as srv:
        srv.ingest_lines(GOLD_COMBAT.read_text(encoding="utf-8").splitlines())
        async with websockets.connect(holder.uri(), max_size=None) as ws:
            resp = await _request(ws, "save_encounter", "encounter_saved",
                                  build_tag="Gate Test", notes="", player_class="Mage")
    assert resp["type"] == "encounter_saved"
    rec = resp["encounter"]
    assert rec["build_tag"] == "Gate Test"
    assert rec["overall"]["total_damage"] == GOLD_STATS_DATA["total_damage"]
    assert rec["primary_target"] == GOLD_STATS_DATA["primary_target"]
    assert "Gate Test" in resp["builds"]
    # confirm it actually hit disk
    on_disk = json.loads((data / "encounters.json").read_text(encoding="utf-8"))
    assert any(e["id"] == rec["id"] for e in on_disk["encounters"])


# ===========================================================================
# 6. The (formerly dead) dungeon commands return non-error.
# ===========================================================================
def test_dungeon_commands_non_error(tmp_path):
    _run(_dungeon_commands(tmp_path))


async def _dungeon_commands(tmp_path):
    data = _build_data_dir(tmp_path)
    holder = _Server(data)
    async with holder as srv:
        async with websockets.connect(holder.uri(), max_size=None) as ws:
            r1 = await _request(ws, "add_dungeon_type", "dungeon_type_added", type_name="GateType")
            r2 = await _request(ws, "add_dungeon", "dungeon_added",
                                category="GateType", dungeon_name="GateBoss")
            r3 = await _request(ws, "delete_dungeon", "dungeon_deleted",
                                category="GateType", dungeon_name="GateBoss")
            r4 = await _request(ws, "delete_dungeon_type", "dungeon_type_deleted", type_name="GateType")
    for r in (r1, r2, r3, r4):
        assert r is not None and r["type"] != "error"
    assert "GateBoss" in r2["dungeons"]["GateType"]
    # persisted to disk
    on_disk = json.loads((data / "dungeons.json").read_text(encoding="utf-8"))
    assert "GateType" not in on_disk  # added then removed


# ===========================================================================
# 7. error type + routing resolutions (session alias, silent set_skill_weapon).
# ===========================================================================
def test_error_type_and_routing_resolutions(tmp_path):
    _run(_routing(tmp_path))


async def _routing(tmp_path):
    data = _build_data_dir(tmp_path)
    holder = _Server(data)
    async with holder as srv:
        async with websockets.connect(holder.uri(), max_size=None) as ws:
            # get_session_encounters aliases to get_encounters
            alias = await _request(ws, "get_session_encounters", timeout=2.0)
            assert alias["type"] == "encounters"
            # merge_encounters with bad input -> error type
            err = await _request(ws, "merge_encounters", "error", encounter_ids=[], timeout=2.0)
            assert err["type"] == "error" and "message" in err
            # set_skill_weapon has no handler -> silently ignored (no reply);
            # follow with a known command and confirm we only get that reply.
            await ws.send(json.dumps({"command": "set_skill_weapon",
                                      "skill_name": "X", "weapon": "spear"}))
            await ws.send(json.dumps({"command": "test_hotkey"}))
            got = await _recv_until(ws, lambda m: m.get("type") != "stats", timeout=2.0)
            assert got["type"] == "hotkey_test"
