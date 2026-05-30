"""Phase 7 gate (headless slice): the windowed app's backend orchestration.

The full DoD — ``python main.py`` opens one native window, the UI connects, every
tab populates, closing exits cleanly — is a GUI gate that must be verified
interactively (it cannot run in CI). What IS automatable, and is covered here, is
everything *except* ``webview.start()``:

  * the asyncio backend (server + Phase-4 watcher + Phase-5 hotkey) spins up on a
    DAEMON thread while the test (standing in for the main GUI thread) stays free;
  * :meth:`main.Backend.start` blocks until the WS is actually bound, then the
    9-command init burst — the exact set ``index.html`` fires on connect — answers
    over a real cross-thread websocket client;
  * closing down (``Backend.stop``) unwinds the loop and joins the watcher thread,
    leaving NO lingering threads and raising no traceback.

The server binds an EPHEMERAL port here (never the live 8765 a running frontend
might hold). The hotkey is disabled via config so the test never grabs a global
ctrl+tab, and the watcher is pointed at a temp dir so it touches no machine state.
"""
from __future__ import annotations

import asyncio
import json
import threading
from pathlib import Path

import websockets

from main import Backend

# The 9 commands index.html fires on connect, with each expected reply ``type``.
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


def _make_data_dir(tmp_path: Path) -> tuple[Path, Path]:
    """Minimal, hermetic data dir: hotkey off + a temp log dir (kept empty)."""
    data = tmp_path / "data"
    data.mkdir()
    logs = tmp_path / "logs"
    logs.mkdir()
    (data / "config.json").write_text(
        json.dumps({"hotkey_enabled": False, "log_path": str(logs)}),
        encoding="utf-8")
    return data, logs


async def _recv_until(ws, pred, *, timeout=5.0):
    """Read frames until ``pred(msg)`` holds, skipping periodic `stats` broadcasts."""
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
        if pred(msg):
            return msg


async def _init_burst(port: int) -> dict:
    uri = f"ws://localhost:{port}"
    responses: dict[str, dict] = {}
    async with websockets.connect(uri, max_size=None) as ws:
        for cmd, want in INIT_COMMANDS:
            await ws.send(json.dumps({"command": cmd}))
            msg = await _recv_until(ws, lambda m: m.get("type") == want, timeout=5.0)
            assert msg is not None, f"{cmd}: no {want} reply before timeout"
            responses[cmd] = msg
    return responses


def test_backend_binds_and_answers_init_burst(tmp_path):
    """The windowed orchestration binds ephemerally, answers all 9 inits, tears
    down clean — the headless-verifiable core of the Phase 7 gate."""
    data, logs = _make_data_dir(tmp_path)
    before = threading.active_count()

    backend = Backend(str(data), host="localhost", port=0, log_dir=str(logs)).start()
    try:
        # Bound on a real ephemeral port (not the placeholder 0, not the live 8765).
        assert backend.port not in (0, 8765)
        assert backend.server is not None

        responses = asyncio.run(_init_burst(backend.port))

        # All 9 answered, each with its expected non-error type.
        assert len(responses) == 9
        for cmd, want in INIT_COMMANDS:
            assert responses[cmd]["type"] == want
        assert all(r.get("type") != "error" for r in responses.values())
    finally:
        backend.stop()

    # Clean teardown: the named loop thread is gone and we are back to baseline
    # (the watcher's observer thread was joined inside _run_app's finally).
    assert not any(
        t.name == "dps-backend" and t.is_alive() for t in threading.enumerate())
    assert threading.active_count() <= before


def test_stop_is_idempotent(tmp_path):
    """Calling stop() twice (e.g. window close then atexit) must not raise."""
    data, logs = _make_data_dir(tmp_path)
    backend = Backend(str(data), host="localhost", port=0, log_dir=str(logs)).start()
    backend.stop()
    backend.stop()  # no-op, no traceback
    assert not any(
        t.name == "dps-backend" and t.is_alive() for t in threading.enumerate())
