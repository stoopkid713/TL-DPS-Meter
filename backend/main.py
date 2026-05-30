"""TL-DPS-Meter — native window entry point (rebuild, Phase 7).

Wraps the headless backend (``DPSMeterServer`` + Phase-4 log watcher + Phase-5
global hotkey) in a single native window so the tool stops feeling like "a server
plus a browser tab."

The hard constraint pywebview imposes: ``webview.start()`` runs a blocking native
GUI loop and MUST own the **main** thread. asyncio therefore cannot live there —
it runs on a **daemon** thread (:class:`Backend`). The window is opened only after
the WebSocket is bound (``ws://localhost:8765``) so the frontend's 9-command init
burst — fired the instant ``index.html`` connects — answers without a stall.

Shutdown is deterministic: closing the window returns from ``webview.start()``,
which signals the backend's asyncio ``stop_event``; that unwinds
``dps_meter_server._run_app``'s ``finally`` (stop hotkey -> stop watcher -> stop
broadcast loop + WS server), the loop thread exits, and we join it. No orphaned
threads, no traceback.

Packaging (Phase 8): two path resolutions that diverge once frozen and are the
classic invisible-until-packaged trap —

* ``index.html`` is a BUNDLED read-only asset. In the frozen app PyInstaller
  extracts it under ``sys._MEIPASS``; in dev it lives at ``<repo>/index.html``.
  :func:`resolve_index_html` returns the right one.
* The 8 user JSON files are WRITABLE state and must persist NEXT TO the exe so the
  user can see them — ``APP_DIR = Path(sys.executable).parent`` when frozen, NOT
  ``_MEIPASS`` (a temp dir wiped on exit). :func:`resolve_data_dir` returns that
  (``$TLDPS_DATA_DIR`` still overrides; dev keeps the CWD default).

Because the windowed build runs with ``console=False`` (stdout is discarded),
:func:`setup_logging` routes diagnostics to a rotating JSON-lines file next to the
exe so there is still a record without a console.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import sys
import threading
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Optional

from dps_meter_server import HOST, PORT, _run_app

log = logging.getLogger("tldps.main")


# --- packaging-aware path resolution ---------------------------------------
APP_NAME = "TL-DPS-Meter"


def _is_frozen() -> bool:
    """True when running inside a PyInstaller-frozen build."""
    return bool(getattr(sys, "frozen", False))


def app_dir() -> Path:
    """Directory that holds WRITABLE state (the 8 user JSON files + rotating log).

    Frozen: a per-user dir under ``%LOCALAPPDATA%\\TL-DPS-Meter`` (created if
    missing), so the app works even when installed to a read-only location like
    Program Files. NOT ``sys.executable``'s parent (read-only under an installer)
    and NOT ``sys._MEIPASS`` (the temp extract dir, wiped on exit). Dev: the repo
    root (this file is ``<repo>/backend/main.py``).
    """
    if _is_frozen():
        base = os.environ.get("LOCALAPPDATA") or str(Path.home())
        d = Path(base) / APP_NAME
        d.mkdir(parents=True, exist_ok=True)
        return d
    return Path(__file__).resolve().parent.parent


def _index_html_path() -> Path:
    """Pure resolver for the BUNDLED read-only ``index.html`` (no fs check)."""
    if _is_frozen():
        # PyInstaller extracts `datas` under _MEIPASS at runtime.
        return Path(getattr(sys, "_MEIPASS")) / "index.html"
    return Path(__file__).resolve().parent.parent / "index.html"


def resolve_index_html() -> Path:
    """Locate the frontend ``index.html``, asserting it exists."""
    index = _index_html_path()
    if not index.is_file():
        raise FileNotFoundError(f"index.html not found at {index}")
    return index


def resolve_data_dir() -> Path:
    """Where persistence reads/writes the JSON state files.

    ``$TLDPS_DATA_DIR`` always wins. Otherwise: next to the exe when frozen, the
    CWD in dev (preserves the Phase-7 dev behaviour).
    """
    override = os.environ.get("TLDPS_DATA_DIR")
    if override:
        return Path(override)
    if _is_frozen():
        return app_dir()
    return Path.cwd()


# --- logging ----------------------------------------------------------------
class _JsonFormatter(logging.Formatter):
    """Minimal structured JSON-lines formatter for the rotating file log."""

    def format(self, record: logging.LogRecord) -> str:
        payload = {
            "ts": self.formatTime(record, "%Y-%m-%dT%H:%M:%S"),
            "level": record.levelname,
            "logger": record.name,
            "msg": record.getMessage(),
        }
        if record.exc_info:
            payload["exc"] = self.formatException(record.exc_info)
        return json.dumps(payload, ensure_ascii=False)


def setup_logging() -> Optional[Path]:
    """Configure root logging. Returns the log-file path when file logging is on.

    Frozen windowed builds have no console (``console=False`` discards stdout), so
    route to a rotating JSON file next to the exe. In dev a console exists, so log
    there as before (no repo clutter).
    """
    root = logging.getLogger()
    root.setLevel(logging.INFO)
    if _is_frozen():
        log_path = app_dir() / "tl-dps-meter.log"
        handler = RotatingFileHandler(
            log_path, maxBytes=1_000_000, backupCount=3, encoding="utf-8")
        handler.setFormatter(_JsonFormatter())
        root.addHandler(handler)
        return log_path
    logging.basicConfig(level=logging.INFO)
    return None


class Backend:
    """The asyncio backend (server + watcher + hotkey) on a daemon thread.

    :meth:`start` blocks until the WS is bound (so the window can open knowing the
    9-init burst will answer); :meth:`stop` signals a clean shutdown and joins the
    thread. Pass ``port=0`` for an ephemeral bind in tests.
    """

    def __init__(
        self,
        data_dir: str | Path,
        *,
        host: str = HOST,
        port: int = PORT,
        log_dir: str | Path | None = None,
        ready_timeout: float = 15.0,
        stop_timeout: float = 5.0,
    ) -> None:
        self.data_dir = str(data_dir)
        self.host = host
        self.port = port  # resolved to the actual bound port once ready
        self.log_dir = log_dir
        self.ready_timeout = ready_timeout
        self.stop_timeout = stop_timeout

        self.server: Optional[object] = None
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._stop_event: Optional[asyncio.Event] = None
        self._thread: Optional[threading.Thread] = None
        self._ready = threading.Event()
        self._error: Optional[BaseException] = None

    # --- lifecycle ---------------------------------------------------------
    def start(self) -> "Backend":
        """Launch the loop thread and block until the WS is bound. Returns self."""
        self._thread = threading.Thread(
            target=self._thread_main, name="dps-backend", daemon=True)
        self._thread.start()
        if not self._ready.wait(self.ready_timeout):
            raise RuntimeError(
                f"backend did not bind within {self.ready_timeout}s")
        if self._error is not None:
            raise self._error
        return self

    def stop(self) -> None:
        """Signal shutdown and join the loop thread. Idempotent."""
        loop, stop_event, thread = self._loop, self._stop_event, self._thread
        if loop is not None and stop_event is not None and not loop.is_closed():
            # _stop_event lives on the loop thread; set it from there.
            try:
                loop.call_soon_threadsafe(stop_event.set)
            except RuntimeError:
                pass  # loop already stopped/closed — nothing to signal
        if thread is not None:
            thread.join(self.stop_timeout)
            if thread.is_alive():
                log.warning("backend thread did not exit within %ss",
                            self.stop_timeout)
            self._thread = None

    # --- loop thread internals ---------------------------------------------
    def _thread_main(self) -> None:
        self._loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self._loop)
        try:
            self._loop.run_until_complete(self._serve())
        except BaseException as exc:  # noqa: BLE001 - surface bind failures to start()
            self._error = exc
            self._ready.set()  # unblock start() so it can re-raise
            log.exception("backend loop crashed")
        finally:
            try:
                self._loop.run_until_complete(self._loop.shutdown_asyncgens())
            except Exception:  # noqa: BLE001 - best effort
                pass
            self._loop.close()

    async def _serve(self) -> None:
        self._stop_event = asyncio.Event()
        await _run_app(
            self.data_dir,
            host=self.host,
            port=self.port,
            log_dir=self.log_dir,
            on_ready=self._on_ready,
            stop_event=self._stop_event,
        )

    def _on_ready(self, server) -> None:
        self.server = server
        self.port = server.port  # the real bound port (matters when port==0)
        self._ready.set()


def main() -> None:
    log_path = setup_logging()
    data_dir = resolve_data_dir()
    index = resolve_index_html()
    if log_path is not None:
        log.info("logging to %s", log_path)

    # Bind the WS (port 8765) BEFORE opening the window so the init burst answers.
    backend = Backend(str(data_dir), host=HOST, port=PORT).start()
    log.info("backend bound on ws://%s:%s -> window=%s data_dir=%s",
             backend.host, backend.port, index, data_dir)

    import webview  # lazy: keeps the module headless-importable for tests

    webview.create_window(
        "TL-DPS-Meter",
        url=index.as_uri(),  # file:// URI to the local frontend
        width=1280,
        height=800,
    )
    try:
        webview.start()  # BLOCKS the main thread until the window is closed
    finally:
        backend.stop()
        log.info("backend stopped — exiting")


if __name__ == "__main__":
    main()
