"""GUI / system commands restored in the Phase-8 interactive pass.

`open_logs_folder` and `purge_log` were mis-bucketed as silent GUI no-ops in
Phase 3, but the old exe actually handled both (disasm L18610-18729). The
"Open Logs Folder" button doing nothing surfaced the regression. These tests
exercise the handlers directly (they are pure ``(server, msg) -> dict|None``
functions) with a tiny stub standing in for the server's ``_log_dir``.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

import dps_meter_server as srv


class _Stub:
    """Minimal stand-in: the two handlers only touch ``_log_dir()``."""

    def __init__(self, log_dir):
        self._dir = Path(log_dir) if log_dir is not None else None

    def _log_dir(self):
        return self._dir


# --- parity: no longer silently dropped ------------------------------------
def test_commands_are_registered_not_ignored():
    assert "open_logs_folder" in srv.HANDLERS
    assert "purge_log" in srv.HANDLERS
    assert "open_logs_folder" not in srv.SILENTLY_IGNORED
    assert "purge_log" not in srv.SILENTLY_IGNORED


# --- open_logs_folder ------------------------------------------------------
def test_open_logs_folder_opens_existing_dir(tmp_path, monkeypatch):
    calls = []
    # The handler imports `os`/`subprocess` locally, but they are the same module
    # objects, so patching them here intercepts the real call (no Explorer window).
    if sys.platform.startswith("win"):
        monkeypatch.setattr(os, "startfile", lambda p: calls.append(p),
                            raising=False)
    else:
        import subprocess
        monkeypatch.setattr(subprocess, "run", lambda *a, **k: calls.append(a))

    result = srv._h_open_logs_folder(_Stub(tmp_path), {})
    assert result is None              # old exe sends NO reply on success
    assert len(calls) == 1            # platform open invoked exactly once


def test_open_logs_folder_missing_dir_errors(tmp_path):
    missing = tmp_path / "does_not_exist"
    result = srv._h_open_logs_folder(_Stub(missing), {})
    assert result == {"type": "error", "message": "Logs folder not found"}


def test_open_logs_folder_none_dir_errors():
    result = srv._h_open_logs_folder(_Stub(None), {})
    assert result == {"type": "error", "message": "Logs folder not found"}


# --- purge_log -------------------------------------------------------------
def test_purge_log_truncates_active_file(tmp_path):
    older = tmp_path / "CombatLog_2026-01-01.txt"
    active = tmp_path / "CombatLog_2026-01-02.txt"  # newest by name = active
    older.write_text("old data\n", encoding="utf-8")
    active.write_text("line1\nline2\nline3\n", encoding="utf-8")

    result = srv._h_purge_log(_Stub(tmp_path), {})
    assert result == {"type": "log_purged"}
    # Only the active (newest) file is cleared; the older one is untouched.
    assert active.read_text(encoding="utf-8") == ""
    assert older.read_text(encoding="utf-8") == "old data\n"


def test_purge_log_no_files_errors(tmp_path):
    result = srv._h_purge_log(_Stub(tmp_path), {})
    assert result == {"type": "error", "message": "No log file found to purge"}


def test_purge_log_missing_dir_errors(tmp_path):
    result = srv._h_purge_log(_Stub(tmp_path / "nope"), {})
    assert result == {"type": "error", "message": "No log file found to purge"}
