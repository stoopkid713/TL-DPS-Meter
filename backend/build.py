#!/usr/bin/env python
"""Build the windowed TL-DPS-Meter exe + installer.

Run from backend/:  uv run python build.py [--no-installer]
Outputs:            backend/dist/TL-DPS-Meter.exe
                    backend/dist/TL-DPS-Meter-portable.zip          (exe + portable marker)
                    backend/dist/TL-DPS-Meter-Setup.exe             (if Inno Setup is present)

The two production packages share ONE onefile exe. The portable zip also ships an
empty ``TL-DPS-Meter.portable`` marker next to the exe; main.app_dir() sees it and
keeps JSON state + log beside the exe (USB-movable). The installer omits the marker,
so the installed app stores state under %LOCALAPPDATA%.

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
import zipfile
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
PORTABLE_ZIP = DIST / "TL-DPS-Meter-portable.zip"
PORTABLE_MARKER = "TL-DPS-Meter.portable"  # must match main.PORTABLE_MARKER
HOWTO = HERE.parent / "HOW-TO-USE.txt"
OVERLAY_DIR = HERE.parent / "overlay" / "src-tauri"  # Tauri party overlay (Rust)


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


def _find_cargo() -> Optional[str]:
    """Locate cargo (PATH, then the default rustup install dir)."""
    c = shutil.which("cargo")
    if c:
        return c
    cand = Path(os.path.expanduser("~")) / ".cargo" / "bin" / "cargo.exe"
    return str(cand) if cand.is_file() else None


def build_overlay() -> int:
    """Build the Tauri party overlay (release). The spec bundles the resulting
    tldps-overlay.exe into the app (-> _MEIPASS) so open_overlay can launch it.

    Non-fatal: warns and continues if the overlay project or cargo is missing, or if
    the Rust build fails — the main app still builds, just without a bundled overlay."""
    if not (OVERLAY_DIR / "Cargo.toml").is_file():
        print(f"overlay project not found — skipping overlay build: {OVERLAY_DIR}", file=sys.stderr)
        return 0
    cargo = _find_cargo()
    if not cargo:
        print("cargo not found — skipping overlay build (overlay won't be bundled).\n"
              "  Install Rust:  winget install -e --id Rustlang.Rustup")
        return 0
    cmd = [cargo, "build", "--release"]
    print("running:", " ".join(cmd), f"(cwd: {OVERLAY_DIR})")
    proc = subprocess.run(cmd, cwd=str(OVERLAY_DIR))
    if proc.returncode != 0:
        print("OVERLAY BUILD FAILED — continuing without a bundled overlay", file=sys.stderr)
        return 0  # non-fatal
    rel = OVERLAY_DIR / "target" / "release" / "tldps-overlay.exe"
    if rel.is_file():
        print(f"OVERLAY OK -> {rel} ({rel.stat().st_size / 1_000_000:.1f} MB)")
    return 0


def build_portable_zip() -> int:
    """Bundle the PORTABLE package: the onefile exe + the empty ``.portable`` marker
    (+ HOW-TO-USE.txt if present). The marker is what makes the portable build keep
    its data next to the exe. Non-fatal: skips if the exe is missing."""
    if not EXE.is_file():
        print(f"exe not found — skipping portable zip: {EXE}", file=sys.stderr)
        return 0
    with zipfile.ZipFile(PORTABLE_ZIP, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.write(EXE, EXE.name)
        if HOWTO.is_file():
            zf.write(HOWTO, HOWTO.name)
        zf.writestr(PORTABLE_MARKER, "")  # empty sentinel -> data lives beside the exe
    print(f"PORTABLE OK -> {PORTABLE_ZIP} ({PORTABLE_ZIP.stat().st_size / 1_000_000:.1f} MB)")
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
    rc = build_overlay()   # build + bundle the Tauri overlay first (non-fatal)
    if rc != 0:
        return rc
    rc = build_exe()
    if rc != 0:
        return rc
    rc = build_portable_zip()
    if rc != 0:
        return rc
    if "--no-installer" in argv:
        print("(--no-installer) skipping installer build")
        return 0
    return build_installer()


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
