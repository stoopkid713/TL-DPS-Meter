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

Packaging note (Phase 8): :func:`resolve_index_html` uses the dev layout
(``<repo>/index.html`` with this file at ``<repo>/backend/main.py``). Phase 8 will
switch the app root to ``sys.executable``'s parent for the frozen build.
"""
from __future__ import annotations

import asyncio
import logging
import os
import threading
from pathlib import Path
from typing import Optional

from dps_meter_server import HOST, PORT, _run_app

log = logging.getLogger("tldps.main")


def resolve_index_html() -> Path:
    """Locate the frontend ``index.html`` (dev layout).

    Dev: ``<repo>/index.html`` while this module is ``<repo>/backend/main.py``.
    Phase 8 handles the packaged ``APP_DIR = sys.executable`` parent case.
    """
    repo_root = Path(__file__).resolve().parent.parent
    index = repo_root / "index.html"
    if not index.is_file():
        raise FileNotFoundError(f"index.html not found at {index}")
    return index


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
    logging.basicConfig(level=logging.INFO)
    data_dir = os.environ.get("TLDPS_DATA_DIR", str(Path.cwd()))
    index = resolve_index_html()

    # Bind the WS (port 8765) BEFORE opening the window so the init burst answers.
    backend = Backend(data_dir, host=HOST, port=PORT).start()
    log.info("backend bound on ws://%s:%s -> opening window at %s",
             backend.host, backend.port, index)

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
