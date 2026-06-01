"""Lane D gate tests (Build-Agent contract verification).

Task 1: Assert that the per-member/per-target stat dict carried in every
        ``party_live_hit`` frame's ``totals.targets`` entry contains
        ``crit_heavy_rate`` (float 0-100) and ``crit_heavy_count`` (int).

Task 2: Assert that the name-re-detect mechanism in
        ``DPSMeterServer._maybe_reemit_suggested_names`` fires when the
        active log file first appears (current_file transitions None → value)
        and re-emits a ``suggested_names`` message via ``_emit``.
"""
from __future__ import annotations

from datetime import datetime
from pathlib import Path

import pytest

from dps_meter_server import DPSMeterServer
from party_state import PartyState


# ---------------------------------------------------------------------------
# Helpers shared by both test groups
# ---------------------------------------------------------------------------
def _line(ts: str, skill: str, dmg: int, crit: bool, heavy: bool,
          target: str, caster: str = "Hero") -> str:
    """Build a minimal DamageDone CSV row."""
    return (f"{ts},DamageDone,{skill},1,{dmg},{int(crit)},{int(heavy)},"
            f"kHit,{caster},{target}")


def _armed_server(tmp_path, assignments=None):
    """Return (server, emitted_list) with _emit monkey-patched for capture."""
    srv = DPSMeterServer(str(tmp_path), port=0)
    emitted: list[dict] = []
    srv._emit = lambda payload: emitted.append(payload)
    if assignments is not None:
        srv._party_assignments = assignments
    srv.party.start_recording("ROOM")
    return srv, emitted


# ===========================================================================
# Task 1 — crit_heavy_rate / crit_heavy_count in the posted per-member dict
# ===========================================================================

class TestCritHeavyInPostedDict:
    """Verify both crit_heavy_* fields are present in every per-target entry
    of the party_live_hit totals dict — the dict the worker reads to render
    the scoreboard."""

    def test_crit_heavy_fields_present_in_live_hit_totals(self, tmp_path):
        """Every target entry in party_live_hit.totals.targets must carry
        crit_heavy_rate (float) and crit_heavy_count (int)."""
        srv, emitted = _armed_server(tmp_path, {"Boss": "raid_boss"})
        lines = [
            _line("20260601-10:00:00:000", "Slash",    1000, True,  True,  "Boss"),
            _line("20260601-10:00:01:000", "Fireball",  500, True,  False, "Boss"),
            _line("20260601-10:00:02:000", "Smash",     800, False, True,  "Boss"),
        ]
        srv.ingest_lines(lines)
        live_hits = [e for e in emitted if e.get("type") == "party_live_hit"]
        assert live_hits, "expected at least one party_live_hit"

        # Check the last frame (totals include all accumulated hits).
        last = live_hits[-1]
        targets = last["totals"]["targets"]
        assert targets, "totals.targets must not be empty"
        for entry in targets:
            assert "crit_heavy_rate" in entry, (
                f"crit_heavy_rate missing from target entry: {entry}"
            )
            assert "crit_heavy_count" in entry, (
                f"crit_heavy_count missing from target entry: {entry}"
            )
            assert isinstance(entry["crit_heavy_rate"], (int, float)), (
                f"crit_heavy_rate must be numeric, got {type(entry['crit_heavy_rate'])}"
            )
            assert isinstance(entry["crit_heavy_count"], int), (
                f"crit_heavy_count must be int, got {type(entry['crit_heavy_count'])}"
            )

    def test_crit_heavy_values_correct(self, tmp_path):
        """Validate the computed values, not just presence.

        3 hits on Boss: 1 crit+heavy, 1 crit-only, 1 heavy-only.
          crit_heavy_count = 1
          crit_heavy_rate  = 1/3 * 100 = 33.3%
        """
        srv, emitted = _armed_server(tmp_path, {"Boss": "raid_boss"})
        lines = [
            _line("20260601-10:00:00:000", "Slash",    1000, True,  True,  "Boss"),
            _line("20260601-10:00:01:000", "Fireball",  500, True,  False, "Boss"),
            _line("20260601-10:00:02:000", "Smash",     800, False, True,  "Boss"),
        ]
        srv.ingest_lines(lines)
        live_hits = [e for e in emitted if e.get("type") == "party_live_hit"]
        last = live_hits[-1]
        boss = next(t for t in last["totals"]["targets"] if t["target"] == "Boss")
        assert boss["crit_heavy_count"] == 1
        assert boss["crit_heavy_rate"] == round(1 / 3 * 100, 1)

    def test_crit_heavy_zero_when_no_combined_hit(self, tmp_path):
        """Hits with only crit OR only heavy must yield crit_heavy_count=0."""
        srv, emitted = _armed_server(tmp_path, {"Mob": "other"})
        lines = [
            _line("20260601-10:00:00:000", "Hit1", 100, True,  False, "Mob"),
            _line("20260601-10:00:01:000", "Hit2", 200, False, True,  "Mob"),
        ]
        srv.ingest_lines(lines)
        live_hits = [e for e in emitted if e.get("type") == "party_live_hit"]
        mob = next(t for t in live_hits[-1]["totals"]["targets"] if t["target"] == "Mob")
        assert mob["crit_heavy_count"] == 0
        assert mob["crit_heavy_rate"] == 0.0

    def test_crit_heavy_in_stop_recording_results(self, tmp_path):
        """The stop_recording results dict (the final POST payload) also carries
        crit_heavy_* in each per-target entry."""
        ps = PartyState()
        ps.start_recording("R1")
        from combat_log_parser import parse_line as _parse
        hits_raw = [
            _line("20260601-10:00:00:000", "A", 1000, True,  True,  "Boss"),
            _line("20260601-10:00:01:000", "B",  500, True,  False, "Boss"),
        ]
        for raw in hits_raw:
            p = _parse(raw)
            ps.record_hit(p["target"], p["damage"], p["is_crit"], p["is_heavy"],
                          p["_timestamp"], skill=p["skill"], time=p["time"])
        results = ps.stop_recording(include_hits=True)
        targets = results["targets"]
        assert targets
        for entry in targets:
            assert "crit_heavy_rate" in entry
            assert "crit_heavy_count" in entry
        boss = targets[0]
        assert boss["crit_heavy_count"] == 1
        assert boss["crit_heavy_rate"] == 50.0  # 1/2 * 100


# ===========================================================================
# Task 2 — display-name re-detect (#13)
# ===========================================================================

class TestNameRedetect:
    """Verify the _maybe_reemit_suggested_names mechanism."""

    def test_reemit_fires_when_log_file_first_appears(self, tmp_path):
        """Transition from current_file=None to a real filename causes
        _maybe_reemit_suggested_names to emit a suggested_names message.

        Note: _maybe_reemit_suggested_names guards on self.clients (non-empty)
        so the broadcast path fires only when at least one WS client is connected
        — consistent with production behaviour where the frontend is always present.
        Tests add a sentinel object to self.clients to satisfy this guard."""
        data_dir = tmp_path / "data"
        data_dir.mkdir()
        log_dir = tmp_path / "logs"
        log_dir.mkdir()

        srv = DPSMeterServer(str(data_dir), port=0)
        emitted: list[dict] = []
        srv._emit = lambda payload: emitted.append(payload)
        # Satisfy the `self.clients` guard (production always has >= 1 client).
        srv.clients = {object()}

        # Override _log_info to simulate "no file yet".
        srv._log_info = lambda: {"current_file": None, "file_count": 0,
                                 "file_size": "0 B", "folder_size": "0 B"}
        # First call — no file, no emit.
        srv._maybe_reemit_suggested_names()
        suggested = [e for e in emitted if e.get("type") == "suggested_names"]
        assert suggested == [], "no emit when current_file is None"

        # Simulate a log file appearing.
        log_file = log_dir / "CombatLog_20260601.txt"
        log_file.write_text("", encoding="utf-8")
        srv._log_info = lambda: {"current_file": log_file.name,
                                 "file_count": 1,
                                 "file_size": "0 B", "folder_size": "0 B"}

        # Second call — file appeared; should emit suggested_names.
        srv._maybe_reemit_suggested_names()
        suggested = [e for e in emitted if e.get("type") == "suggested_names"]
        assert len(suggested) == 1, "should emit exactly one suggested_names on first appearance"
        assert "names" in suggested[0]

    def test_reemit_does_not_fire_again_for_same_file(self, tmp_path):
        """After the initial emit, repeated calls with the same filename must
        NOT re-emit (no spam on every broadcast tick)."""
        data_dir = tmp_path / "data"
        data_dir.mkdir()
        log_dir = tmp_path / "logs"
        log_dir.mkdir()
        log_file = log_dir / "CombatLog_20260601.txt"
        log_file.write_text("", encoding="utf-8")

        srv = DPSMeterServer(str(data_dir), port=0)
        emitted: list[dict] = []
        srv._emit = lambda payload: emitted.append(payload)
        srv.clients = {object()}  # satisfy self.clients guard
        srv._log_info = lambda: {"current_file": log_file.name, "file_count": 1,
                                 "file_size": "0 B", "folder_size": "0 B"}

        # First call — emit.
        srv._maybe_reemit_suggested_names()
        # Second and third calls — same file, no additional emits.
        srv._maybe_reemit_suggested_names()
        srv._maybe_reemit_suggested_names()

        suggested = [e for e in emitted if e.get("type") == "suggested_names"]
        assert len(suggested) == 1, "only one emit per unique log file, no repeated spam"

    def test_reemit_fires_again_when_log_file_rotates(self, tmp_path):
        """If the active log file rotates to a new filename, re-detect fires once more."""
        data_dir = tmp_path / "data"
        data_dir.mkdir()
        log_dir = tmp_path / "logs"
        log_dir.mkdir()

        srv = DPSMeterServer(str(data_dir), port=0)
        emitted: list[dict] = []
        srv._emit = lambda payload: emitted.append(payload)
        srv.clients = {object()}  # satisfy self.clients guard

        # Establish an initial file.
        srv._log_info = lambda: {"current_file": "CombatLog_A.txt", "file_count": 1,
                                 "file_size": "0 B", "folder_size": "0 B"}
        srv._maybe_reemit_suggested_names()
        before = len([e for e in emitted if e.get("type") == "suggested_names"])
        assert before == 1

        # Log rotates to a new file.
        srv._log_info = lambda: {"current_file": "CombatLog_B.txt", "file_count": 2,
                                 "file_size": "0 B", "folder_size": "0 B"}
        srv._maybe_reemit_suggested_names()
        after = [e for e in emitted if e.get("type") == "suggested_names"]
        assert len(after) == 2, "should re-emit once when log rotates to a new filename"

    def test_get_suggested_names_command_is_on_demand(self, tmp_path):
        """The get_suggested_names command (on-demand path) returns the right
        type and a names list the UI can call at any time."""
        from dps_meter_server import _h_get_suggested_names
        srv = DPSMeterServer(str(tmp_path), port=0)
        result = _h_get_suggested_names(srv, {"command": "get_suggested_names"})
        assert result["type"] == "suggested_names"
        assert isinstance(result["names"], list)

    def test_reemit_parses_dominant_caster_from_log(self, tmp_path):
        """When the log file contains damage lines, the dominant caster appears
        in the re-emitted suggested_names payload."""
        from constants import IDX_CASTER, IDX_DAMAGE, IDX_LOG_TYPE, LOG_TYPE_DAMAGE
        data_dir = tmp_path / "data"
        data_dir.mkdir()
        log_dir = tmp_path / "logs"
        log_dir.mkdir()
        log_file = log_dir / "CombatLog_20260601.txt"

        # Write minimal damage lines for a dominant caster "PlayerOne".
        # Format: ts,DamageDone,skill,id,dmg,crit,heavy,type,caster,target
        lines = [
            "20260601-10:00:00:000,DamageDone,Slash,1,5000,0,0,kHit,PlayerOne,Boss\n",
            "20260601-10:00:01:000,DamageDone,Slash,1,4000,0,0,kHit,PlayerOne,Boss\n",
            "20260601-10:00:02:000,DamageDone,Slash,1,1000,0,0,kHit,PlayerTwo,Boss\n",
        ]
        log_file.write_text("".join(lines), encoding="utf-8")

        srv = DPSMeterServer(str(data_dir), port=0)
        # Point _log_dir to our fake log dir.
        srv._log_dir = lambda: log_dir

        emitted: list[dict] = []
        srv._emit = lambda payload: emitted.append(payload)
        srv.clients = {object()}  # satisfy self.clients guard
        # Simulate no previous file seen.
        srv._last_log_file = None
        # Simulate current_file pointing to our file.
        srv._log_info = lambda: {"current_file": log_file.name, "file_count": 1,
                                 "file_size": "100 B", "folder_size": "100 B"}

        srv._maybe_reemit_suggested_names()
        suggested = [e for e in emitted if e.get("type") == "suggested_names"]
        assert len(suggested) == 1
        names = suggested[0]["names"]
        assert "PlayerOne" in names, (
            f"dominant caster 'PlayerOne' should appear in names, got {names}"
        )
