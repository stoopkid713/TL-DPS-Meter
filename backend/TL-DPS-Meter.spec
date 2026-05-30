# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec for TL-DPS-Meter (rebuild backend, Phase 8).

Windowed (``console=False``) single-file GUI build — double-click to launch, no
terminal window (matches the old exe). Bundles the frontend ``index.html`` as a
read-only ``datas`` asset (loaded from ``sys._MEIPASS`` at runtime via
``main.resolve_index_html``); the writable JSON state lives NEXT TO the exe (see
``main.app_dir`` / ``main.resolve_data_dir``).

Build (from backend/):  uv run pyinstaller TL-DPS-Meter.spec --noconfirm
Output:                 backend/dist/TL-DPS-Meter.exe

The repo-root TL-DPS-Meter.exe (the parity oracle) is never touched — output
goes to backend/dist/.
"""
import os

from PyInstaller.utils.hooks import collect_submodules

HERE = SPECPATH                       # backend/ (dir containing this spec)
REPO_ROOT = os.path.dirname(HERE)     # repo root (holds index.html)
INDEX_HTML = os.path.join(REPO_ROOT, "index.html")
ICON = os.path.join(HERE, "assets", "icon.ico")
VERSION_FILE = os.path.join(HERE, "version_info.txt")

# pywebview chooses a GUI backend at runtime (winforms/WebView2 on Windows);
# pull in all its submodules so the chosen backend is present in the frozen app.
hiddenimports = collect_submodules("webview")

a = Analysis(
    ["main.py"],
    pathex=[HERE],
    binaries=[],
    datas=[(INDEX_HTML, ".")],        # -> _MEIPASS/index.html at runtime
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=["tkinter"],
    noarchive=False,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="TL-DPS-Meter",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    runtime_tmpdir=None,
    console=False,                    # windowed GUI: no console window
    disable_windowed_traceback=False,
    icon=ICON,                        # taskbar / Start Menu / ARP / Properties icon
    version=VERSION_FILE,             # Properties -> Details metadata
)
