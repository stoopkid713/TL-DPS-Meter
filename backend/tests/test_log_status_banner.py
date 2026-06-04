"""Gate tests for #14 — logging detection contract.

Verifies the backend signals that power the Half A own-client banner:
  1. ``_stats_envelope`` always includes ``log_info.current_file`` (the log-found signal).
  2. ``_stats_envelope`` carries ``log_info.last_combat_age_s`` — the deterministic
     state-machine signal: None when no combat lines ingested, float seconds otherwise.
  3. ``_stats_envelope`` carries the ``party_live_hit`` path that sets ``lastLogActivity``
     in the frontend (retained as legacy fallback; banner state now uses last_combat_age_s).

These are contract checks, not UI tests — they confirm the Python backend emits
exactly the fields the banner JavaScript reads.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from dps_meter_server import DPSMeterServer
from party_state import PartyState


# ---------------------------------------------------------------------------
# 3. last_combat_age_s — the new deterministic log-state signal (#14 state machine)
# ---------------------------------------------------------------------------

class TestLastCombatAgeS:
    """log_info must include last_combat_age_s: None when no hits ingested,
    a non-negative float (seconds) after hits are ingested. This is what the
    frontend uses to distinguish LOGGING_ACTIVE from LOG_PRESENT_NO_RECENT_COMBAT,
    fixing the game-off stale-log false positive."""

    def test_last_combat_age_s_key_always_present(self, tmp_path):
        """log_info must always carry the last_combat_age_s key (None or float)."""
        srv, _ = _server_with_capture(tmp_path)
        info = srv._log_info()
        assert "last_combat_age_s" in info, (
            "log_info must always include last_combat_age_s for the state machine"
        )

    def test_last_combat_age_s_none_before_any_ingest(self, tmp_path):
        """Before any lines are ingested, last_combat_age_s must be None — the
        frontend interprets None as LOG_PRESENT_NO_RECENT_COMBAT (no combat seen)."""
        srv, _ = _server_with_capture(tmp_path)
        info = srv._log_info()
        assert info["last_combat_age_s"] is None, (
            "last_combat_age_s must be None when no combat lines have been ingested"
        )

    def test_last_combat_age_s_none_when_no_log_dir(self, tmp_path):
        """last_combat_age_s must be None when no log dir is configured — the
        frontend's NO_LOG_FILE state is driven by current_file=None, not age."""
        nonexistent = str(tmp_path / "nonexistent_logs")
        srv, _ = _server_with_capture(tmp_path)
        srv.config["log_path"] = nonexistent
        info = srv._log_info()
        assert info["last_combat_age_s"] is None, (
            "last_combat_age_s must be None when no log dir exists"
        )

    def test_last_combat_age_s_float_after_ingest(self, tmp_path):
        """After ingest_lines processes at least one DamageDone line,
        last_combat_age_s must be a non-negative float."""
        srv, _ = _server_with_capture(tmp_path)
        _configure_log_dir(srv, tmp_path)

        srv.ingest_lines([
            _line("20260601-10:00:00:000", "Slash", 1000, False, False, "Boss"),
        ])

        info = srv._log_info()
        age = info["last_combat_age_s"]
        assert isinstance(age, float), (
            f"last_combat_age_s must be float after ingest, got {type(age)}: {age!r}"
        )
        assert age >= 0, f"last_combat_age_s must be >= 0, got {age}"

    def test_last_combat_age_s_increases_over_time(self, tmp_path):
        """Two consecutive calls without new ingest must return increasing values,
        confirming it is wall-clock age and not a cached constant."""
        import time
        srv, _ = _server_with_capture(tmp_path)
        _configure_log_dir(srv, tmp_path)

        srv.ingest_lines([
            _line("20260601-10:00:00:000", "Slash", 1000, False, False, "Boss"),
        ])

        age1 = srv._log_info()["last_combat_age_s"]
        time.sleep(0.05)  # 50 ms — enough for a measurable delta
        age2 = srv._log_info()["last_combat_age_s"]

        assert age2 > age1, (
            f"last_combat_age_s must grow between calls: {age1} -> {age2}"
        )

    def test_last_combat_age_s_resets_on_new_ingest(self, tmp_path):
        """Ingesting a newer combat line must lower last_combat_age_s (reset the
        clock), confirming the backend updates _last_combat_ts per-hit."""
        import time
        srv, _ = _server_with_capture(tmp_path)
        _configure_log_dir(srv, tmp_path)

        # First ingest — old timestamp in log line but _last_combat_ts = datetime.now() copy
        srv.ingest_lines([
            _line("20260601-10:00:00:000", "Slash", 1000, False, False, "Boss"),
        ])
        time.sleep(0.05)
        age_before = srv._log_info()["last_combat_age_s"]

        # Second ingest — a later log line; _last_combat_ts is refreshed
        srv.ingest_lines([
            _line("20260601-10:00:01:000", "Slash", 500, False, False, "Boss"),
        ])
        age_after = srv._log_info()["last_combat_age_s"]

        assert age_after < age_before, (
            f"second ingest must reset age clock: {age_before:.3f}s -> {age_after:.3f}s"
        )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _line(ts: str, skill: str, dmg: int, crit: bool, heavy: bool,
          target: str, caster: str = "Hero") -> str:
    return (f"{ts},DamageDone,{skill},1,{dmg},{int(crit)},{int(heavy)},"
            f"kHit,{caster},{target}")


def _server_with_capture(tmp_path) -> tuple[DPSMeterServer, list[dict]]:
    srv = DPSMeterServer(str(tmp_path), port=0)
    emitted: list[dict] = []
    srv._emit = lambda payload: emitted.append(payload)
    return srv, emitted


def _configure_log_dir(srv, tmp_path) -> None:
    """Point the server at an existing (empty) log dir so _log_info() doesn't
    early-return last_combat_age_s=None on a missing dir. Without this, the
    ingest tests implicitly depend on the host having Throne & Liberty installed
    (the _default_log_dir() fallback) and fail on a clean CI runner."""
    d = tmp_path / "tl_logs"
    d.mkdir(exist_ok=True)
    srv.config["log_path"] = str(d)


# ---------------------------------------------------------------------------
# 1. _stats_envelope always carries log_info.current_file
# ---------------------------------------------------------------------------

class TestLogInfoInStatsEnvelope:
    """_stats_envelope must include log_info with a current_file key so the
    frontend banner can distinguish 'no log file' from 'log file present'."""

    def test_log_info_present_in_envelope(self, tmp_path):
        """log_info key is always present in the stats envelope."""
        srv, _ = _server_with_capture(tmp_path)
        env = srv._stats_envelope()
        assert "log_info" in env, "stats envelope must contain log_info"

    def test_log_info_has_current_file_key(self, tmp_path):
        """log_info always carries 'current_file' regardless of whether a log
        directory is configured — the frontend does ``!!lastLogFile`` on it."""
        srv, _ = _server_with_capture(tmp_path)
        env = srv._stats_envelope()
        log_info = env["log_info"]
        assert "current_file" in log_info, (
            "log_info must have 'current_file' key; frontend banner reads it"
        )

    def test_log_info_current_file_none_when_no_log_dir(self, tmp_path):
        """When no combat-log directory is configured (fresh install / logging
        off), current_file must be None so the banner shows the 'off' state."""
        # Point log_path at a directory that does NOT exist so _log_dir() returns None.
        nonexistent = str(tmp_path / "nonexistent_logs")
        srv, _ = _server_with_capture(tmp_path)
        srv.config["log_path"] = nonexistent
        env = srv._stats_envelope()
        assert env["log_info"]["current_file"] is None, (
            "current_file must be None when no log dir is present"
        )

    def test_log_info_current_file_set_when_log_present(self, tmp_path):
        """When a *.txt log file exists in the configured log_path, current_file
        must be the filename so the banner transitions to 'waiting' state."""
        log_dir = tmp_path / "logs"
        log_dir.mkdir()
        fake_log = log_dir / "20260601.txt"
        fake_log.write_text("", encoding="utf-8")

        srv, _ = _server_with_capture(tmp_path)
        # Point the server at the log dir by patching config.
        srv.config["log_path"] = str(log_dir)

        env = srv._stats_envelope()
        assert env["log_info"]["current_file"] == "20260601.txt", (
            "current_file must be the log filename when a *.txt file exists"
        )


# ---------------------------------------------------------------------------
# 2. party_live_hit is emitted (the frame that sets lastLogActivity)
# ---------------------------------------------------------------------------

class TestPartyLiveHitEmit:
    """While a party session is active, ingesting combat lines must emit at
    least one ``party_live_hit`` frame — that frame is what sets
    ``lastLogActivity`` in the frontend so the banner transitions to 'ok'."""

    def test_party_live_hit_emitted_on_ingest(self, tmp_path):
        """Ingesting a combat line while party is armed emits party_live_hit."""
        srv, emitted = _server_with_capture(tmp_path)
        srv.party.start_recording("TEST")
        srv._party_session_active = True

        srv.ingest_lines([
            _line("20260601-10:00:00:000", "Slash", 1000, False, False, "Boss"),
        ])

        types = [e["type"] for e in emitted]
        assert "party_live_hit" in types, (
            "a party_live_hit frame must be emitted when a hit is ingested; "
            "the frontend sets lastLogActivity from this frame type"
        )

    def test_no_party_live_hit_without_session(self, tmp_path):
        """Without a party session active, ingest must NOT emit party_live_hit
        (the banner's 'ok' state should only fire when the user is in a party)."""
        srv, emitted = _server_with_capture(tmp_path)
        # _party_session_active defaults to False

        srv.ingest_lines([
            _line("20260601-10:00:00:000", "Slash", 1000, False, False, "Boss"),
        ])

        types = [e["type"] for e in emitted]
        assert "party_live_hit" not in types, (
            "party_live_hit must NOT be emitted when no party session is active"
        )
