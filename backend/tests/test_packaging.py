"""Phase 8 — packaging path resolution (the APP_DIR trap).

A frozen build resolves two paths differently, and getting either wrong is
invisible until the exe is shipped:
  * index.html (bundled, read-only)   -> sys._MEIPASS/index.html
  * the 8 JSON state files (writable) -> sys.executable parent, NOT _MEIPASS
    (which is a temp extract dir wiped on exit)

These tests mock sys.frozen / sys._MEIPASS / sys.executable so the trap is caught
without a real PyInstaller build.
"""
from __future__ import annotations

from pathlib import Path

import main as main_mod


def _freeze(monkeypatch, exe: Path, meipass: Path) -> None:
    monkeypatch.setattr(main_mod.sys, "frozen", True, raising=False)
    monkeypatch.setattr(main_mod.sys, "_MEIPASS", str(meipass), raising=False)
    monkeypatch.setattr(main_mod.sys, "executable", str(exe), raising=False)


def test_frozen_data_dir_is_localappdata_not_meipass_or_exe(monkeypatch, tmp_path):
    exe = tmp_path / "Programs" / "TL-DPS-Meter" / "TL-DPS-Meter.exe"
    meipass = tmp_path / "_MEI12345"
    local = tmp_path / "LocalAppData"
    _freeze(monkeypatch, exe, meipass)
    monkeypatch.delenv("TLDPS_DATA_DIR", raising=False)
    monkeypatch.setenv("LOCALAPPDATA", str(local))

    expected = local / main_mod.APP_NAME
    assert main_mod._is_frozen() is True
    assert main_mod.app_dir() == expected
    assert main_mod.resolve_data_dir() == expected
    assert expected.is_dir()  # created on demand (works under read-only Program Files)
    # writable state must NOT land in the temp extract dir nor the read-only exe dir
    assert main_mod.resolve_data_dir() != meipass
    assert main_mod.resolve_data_dir() != exe.parent


def test_frozen_index_html_is_meipass(monkeypatch, tmp_path):
    exe = tmp_path / "dist" / "TL-DPS-Meter.exe"
    meipass = tmp_path / "_MEI12345"
    _freeze(monkeypatch, exe, meipass)
    assert main_mod._index_html_path() == meipass / "index.html"


def test_frozen_env_override_still_wins(monkeypatch, tmp_path):
    exe = tmp_path / "dist" / "TL-DPS-Meter.exe"
    meipass = tmp_path / "_MEI12345"
    override = tmp_path / "custom_state"
    _freeze(monkeypatch, exe, meipass)
    monkeypatch.setenv("TLDPS_DATA_DIR", str(override))
    assert main_mod.resolve_data_dir() == override


def test_dev_paths_unfrozen(monkeypatch):
    monkeypatch.setattr(main_mod.sys, "frozen", False, raising=False)
    monkeypatch.delenv("TLDPS_DATA_DIR", raising=False)
    repo_root = Path(main_mod.__file__).resolve().parent.parent
    assert main_mod._is_frozen() is False
    assert main_mod._index_html_path() == repo_root / "index.html"
    assert main_mod.resolve_data_dir() == Path.cwd()


def test_dev_env_override(monkeypatch, tmp_path):
    monkeypatch.setattr(main_mod.sys, "frozen", False, raising=False)
    monkeypatch.setenv("TLDPS_DATA_DIR", str(tmp_path))
    assert main_mod.resolve_data_dir() == tmp_path
