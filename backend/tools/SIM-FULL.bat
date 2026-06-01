@echo off
REM SIM-FULL.bat — convenience launcher for sim_party.py (CURRENT PROTOCOL).
REM
REM Default run: crit-heavy-parity scenario (self-contained, no log needed, no WS needed)
REM followed by merge-two-players dry-run.
REM
REM Usage:
REM   SIM-FULL.bat                         run default self-contained scenarios
REM   SIM-FULL.bat MYCODE --live           live-tail mode, 4 bots
REM   SIM-FULL.bat MBTEST --multiboss      3-encounter harness
REM   SIM-FULL.bat --dry-run               frame-inspection only (no WS)
REM
REM Requires: backend/.venv must exist (created by setup / bootstrap).

setlocal
set "REPO_ROOT=%~dp0..\.."
set "VENV_PY=%REPO_ROOT%\backend\.venv\Scripts\python.exe"
set "SIM=%REPO_ROOT%\backend\tools\sim_party.py"

if not exist "%VENV_PY%" (
    echo ERROR: venv python not found at %VENV_PY%
    echo        Create it with: python -m venv backend/.venv ^&^& backend/.venv/Scripts/pip install -r backend/requirements.txt
    exit /b 1
)

if "%~1"=="" (
    echo.
    echo === crit-heavy-parity scenario (parity check, dry-run) ===
    "%VENV_PY%" "%SIM%" --scenario crit-heavy-parity --dry-run
    echo.
    echo === merge-two-players scenario (merge regression, dry-run) ===
    "%VENV_PY%" "%SIM%" --scenario merge-two-players --dry-run
    echo.
    echo === list-scenarios ===
    "%VENV_PY%" "%SIM%" --list-scenarios
    echo.
    echo Done. Pass a party code and args to run live (e.g. SIM-FULL.bat MYCODE --live).
) else (
    "%VENV_PY%" "%SIM%" %*
)

endlocal
