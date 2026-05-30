#!/usr/bin/env python
"""Build the windowed TL-DPS-Meter exe + installer.

Run from backend/:  uv run python build.py [--no-installer]
Outputs:            backend/dist/TL-DPS-Meter.exe
                    backend/dist/TL-DPS-Meter-Setup.exe   (if Inno Setup is present)

The OLD repo-root TL-DPS-Meter.exe (the parity oracle) is NEVER touched — this only
writes under backend/dist/ and backend/build/. The previous exe is kept as
dist/TL-DPS-Meter.prev.exe for rollback (N-1).

Installed app data: the frozen exe reads/writes its JSON state + rotating log under
%LOCALAPPDATA%\\TL-DPS-Meter (see main.app_dir), so it works even when installed to
a read-only location (the per-user installer puts it in %LOCALAPPDATA%\\Programs).

Signing is intentionally skipped for now: an Authenticode/EV cert (~$100-400/yr)
would remove the Windows SmartScreen "unknown publisher" warning but is not required
to run. To add it later, sign EXE before building the installer and sign the
resulting Setup.exe (signtool sign /fd sha256 /tr <timestamp> /td sha256 ...).
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Optional

HERE = Path(__file__).resolve().parent
SPEC = HERE / "TL-DPS-Meter.spec"
ISS = HERE / "installer" / "TL-DPS-Meter.iss"
DIST = HERE / "dist"
BUILD = HERE / "build"
EXE = DIST / "TL-DPS-Meter.exe"
PREV = DIST / "TL-DPS-Meter.prev.exe"
SETUP = DIST / "TL-DPS-Meter-Setup.exe"


def build_exe() -> int:
    if not SPEC.is_file():
        print(f"spec not found: {SPEC}", file=sys.stderr)
        return 2

    # Preserve the prior build for rollback before PyInstaller overwrites it.
    if EXE.is_file():
        shutil.copy2(EXE, PREV)
        print(f"kept previous build -> {PREV}")

    cmd = [
        sys.executable, "-m", "PyInstaller", str(SPEC),
        "--noconfirm",
        "--distpath", str(DIST),
        "--workpath", str(BUILD),
    ]
    print("running:", " ".join(cmd))
    proc = subprocess.run(cmd)
    if proc.returncode != 0:
        print("BUILD FAILED", file=sys.stderr)
        return proc.returncode
    if not EXE.is_file():
        print(f"build reported success but {EXE} is missing", file=sys.stderr)
        return 1

    print(f"BUILD OK -> {EXE} ({EXE.stat().st_size / 1_000_000:.1f} MB)")
    return 0


def _find_iscc() -> Optional[str]:
    """Locate the Inno Setup command-line compiler (ISCC.exe)."""
    local = os.environ.get("LOCALAPPDATA", "")
    candidates = [
        os.environ.get("ISCC"),
        shutil.which("ISCC"),
        r"C:\Program Files (x86)\Inno Setup 6\ISCC.exe",
        r"C:\Program Files\Inno Setup 6\ISCC.exe",
        os.path.join(local, "Programs", "Inno Setup 6", "ISCC.exe") if local else None,
    ]
    for c in candidates:
        if c and Path(c).is_file():
            return c
    return None


def build_installer() -> int:
    """Compile the per-user installer. Non-fatal (skips cleanly) if Inno is absent."""
    if not ISS.is_file():
        print(f"installer script not found: {ISS}", file=sys.stderr)
        return 0
    iscc = _find_iscc()
    if not iscc:
        print("Inno Setup (ISCC.exe) not found — skipping installer.\n"
              "  Install it with:  winget install -e --id JRSoftware.InnoSetup")
        return 0
    cmd = [iscc, str(ISS)]
    print("running:", " ".join(cmd))
    proc = subprocess.run(cmd)
    if proc.returncode != 0:
        print("INSTALLER BUILD FAILED", file=sys.stderr)
        return proc.returncode
    if SETUP.is_file():
        print(f"INSTALLER OK -> {SETUP} ({SETUP.stat().st_size / 1_000_000:.1f} MB)")
    return 0


def main(argv: list[str]) -> int:
    rc = build_exe()
    if rc != 0:
        return rc
    if "--no-installer" in argv:
        print("(--no-installer) skipping installer build")
        return 0
    return build_installer()


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
