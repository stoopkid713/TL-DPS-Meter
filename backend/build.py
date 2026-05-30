#!/usr/bin/env python
"""Build the windowed TL-DPS-Meter exe via PyInstaller (rebuild, Phase 8).

Run from backend/:  uv run python build.py
Output:             backend/dist/TL-DPS-Meter.exe

The OLD repo-root TL-DPS-Meter.exe (the parity oracle) is NEVER touched — this
only writes under backend/dist/ and backend/build/. The previous build is kept as
dist/TL-DPS-Meter.prev.exe for rollback (N-1).

Signing is intentionally skipped: an Authenticode cert (~$100-300/yr) would remove
the Windows SmartScreen "unknown publisher" warning but is not required to run.
Decision documented in PROGRESS.md; revisit only if distributing beyond this PC.
"""
from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
SPEC = HERE / "TL-DPS-Meter.spec"
DIST = HERE / "dist"
BUILD = HERE / "build"
EXE = DIST / "TL-DPS-Meter.exe"
PREV = DIST / "TL-DPS-Meter.prev.exe"


def main() -> int:
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

    size_mb = EXE.stat().st_size / 1_000_000
    print(f"BUILD OK -> {EXE} ({size_mb:.1f} MB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
