"""Combat-log file watcher (rebuild, Workstream A — Phase 4).

Bridges the on-disk Throne-and-Liberty combat log to the live ``DPSMeterServer``:
a watchdog observer fires on file changes, the new bytes are read, parsed, and
fed to :meth:`DPSMeterServer.ingest_lines`, and a stats broadcast is scheduled.

Thread-safety is the whole point of this module (the classic silent-corruption
bug for log tailers). The watchdog observer runs on its OWN thread; it must never
touch shared state. So the observer-thread path does exactly one thing —
``loop.call_soon_threadsafe(self.poll)`` — and ALL state mutation (current file,
file position, the ``CombatStats`` accumulator) happens inside :meth:`poll`, which
only ever runs on the asyncio event loop. See ``tests/test_log_watcher.py``.

Behaviour mirrors the old backend (disasm ``read_new_lines`` /
``reset_file_position`` / ``find_latest_log`` / ``is_valid_log_dir``):
  * Logs are ``*.txt``; the newest by filename is the active file.
  * Reads tail from a saved byte ``file_position`` to EOF; the position advances
    by the number of bytes read.
  * On first attach the existing file is read from the start (``from_start=True``),
    matching the old exe, which loads the current log's contents into stats at
    launch and then tails. Rotation to a newly-created file also reads from start.
"""
from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from typing import Optional

from watchdog.events import FileSystemEventHandler
from watchdog.observers import Observer

from debug import trace

log = logging.getLogger(__name__)


class LogWatcher:
    """Watch a directory of ``*.txt`` combat logs and stream new lines to the server."""

    def __init__(self, server, log_dir: str | Path | None = None) -> None:
        self.server = server
        self.log_dir: Optional[Path] = Path(log_dir) if log_dir is not None else None
        self.current_file: Optional[Path] = None
        self.file_position: int = 0
        self.loop: Optional[asyncio.AbstractEventLoop] = None
        self._observer: Optional[Observer] = None

    # --- lifecycle ---------------------------------------------------------
    def start(self) -> "LogWatcher":
        """Capture the running loop, attach to the latest log, start the observer.

        Must be called from within the asyncio event loop (so ``poll`` callbacks
        marshalled from the observer thread land on the right loop).
        """
        self.loop = asyncio.get_running_loop()
        if self.log_dir is None:
            self.log_dir = self._resolve_log_dir()
        if self.log_dir is None or not self.log_dir.is_dir():
            log.warning("LogWatcher: log dir %s not present; watcher idle", self.log_dir)
            return self
        # Load the current log's existing contents, then tail.
        latest = self._find_latest_log()
        if latest is not None:
            self._attach(latest, from_start=True)
            self.poll()  # ingest whatever already exists
        self._observer = Observer()
        self._observer.schedule(_LogEventHandler(self), str(self.log_dir), recursive=False)
        self._observer.start()
        log.info("LogWatcher watching %s (current=%s)", self.log_dir, self.current_file)
        return self

    def stop(self) -> None:
        if self._observer is not None:
            self._observer.stop()
            self._observer.join(timeout=2.0)
            self._observer = None

    # --- on-loop core (the ONLY mutator of watcher/stats state) ------------
    def poll(self) -> int:
        """Read new lines from the active log and feed them to the server.

        Runs ON the event loop. Handles rotation (a newer ``*.txt`` appearing) by
        switching to it and reading from the start. Returns the number of lines
        ingested (handy for tests).
        """
        latest = self._find_latest_log()
        reattach = latest is not None and latest != self.current_file
        if reattach:
            trace("watcher.reattach", latest=str(latest), prev=str(self.current_file))
            self._attach(latest, from_start=True)
        pos_before = self.file_position
        lines = self.read_new_lines()
        if lines:
            self.server.ingest_lines(lines)
            self.server.schedule_broadcast()
        if reattach or lines:
            trace("watcher.poll", reattach=reattach, pos_before=pos_before,
                  pos_after=self.file_position, lines=len(lines))
        return len(lines)

    def read_new_lines(self) -> list[str]:
        """Read from ``file_position`` to EOF (binary -> decode), advancing position.

        Binary mode keeps ``file_position`` an unambiguous byte offset (text-mode
        ``tell``/``seek`` is unreliable on Windows with CRLF translation).
        """
        if self.current_file is None:
            return []
        try:
            with open(self.current_file, "rb") as f:
                f.seek(self.file_position)
                chunk = f.read()
                self.file_position = f.tell()
        except OSError as exc:
            log.warning("LogWatcher: error reading %s: %s", self.current_file, exc)
            return []
        if not chunk:
            return []
        return chunk.decode("utf-8", errors="replace").splitlines()

    # --- observer-thread entry point (marshal only — NO state mutation) ----
    def _on_event(self, src_path: str) -> None:
        """Called on the watchdog observer thread. Only marshals onto the loop."""
        if self.loop is not None:
            self.loop.call_soon_threadsafe(self.poll)

    # --- helpers (called on the loop) --------------------------------------
    def _attach(self, path: Path, *, from_start: bool) -> None:
        """Make ``path`` the active file. ``from_start`` reads from byte 0, else tails.

        Tail (``from_start=False``) mirrors the old ``reset_file_position`` =
        ``st_size`` ("ignore old data"); kept for completeness / future
        ``reset_file`` wiring.
        """
        self.current_file = path
        if from_start:
            self.file_position = 0
        else:
            try:
                self.file_position = path.stat().st_size
            except OSError:
                self.file_position = 0
        trace("watcher.attach", path=str(path), from_start=from_start,
              file_position=self.file_position)

    def skip_to_end(self) -> None:
        """Reset's line-in-the-sand: jump the read cursor to the current EOF so the
        unread backlog is discarded and only NEW lines are tailed from here.

        Wired into both reset paths (hotkey + command). Without it, a reset clears
        the stats buffer but leaves ``file_position`` lagging, so the next poll
        re-ingests pre-reset combat and the 60s window clips to it. Runs on the event
        loop (same as poll/_attach; the reset handlers are loop-side), so there is no
        cross-thread race on ``file_position``.
        """
        latest = self._find_latest_log()
        if latest is None:
            return
        before = self.file_position
        self._attach(latest, from_start=False)
        trace("watcher.skip_to_end", pos_before=before, pos_after=self.file_position)

    def _find_latest_log(self) -> Optional[Path]:
        """Newest ``*.txt`` in the watched dir by filename (TL names sort by time)."""
        if self.log_dir is None or not self.log_dir.is_dir():
            return None
        txts = list(self.log_dir.glob("*.txt"))
        if not txts:
            return None
        return max(txts, key=lambda f: f.name)

    def _resolve_log_dir(self) -> Optional[Path]:
        """Use the server's configured/default log directory."""
        getter = getattr(self.server, "_log_dir", None)
        if callable(getter):
            d = getter()
            if d is not None:
                return d
        default = getattr(__import__("dps_meter_server"), "_default_log_dir", None)
        return default() if callable(default) else None


class _LogEventHandler(FileSystemEventHandler):
    """Routes ``*.txt`` file events to the watcher (runs on the observer thread)."""

    def __init__(self, watcher: LogWatcher) -> None:
        self._watcher = watcher

    def _maybe(self, event) -> None:
        if event.is_directory:
            return
        path = getattr(event, "dest_path", "") or event.src_path
        if str(path).endswith(".txt"):
            self._watcher._on_event(str(path))

    def on_modified(self, event) -> None:
        self._maybe(event)

    def on_created(self, event) -> None:
        self._maybe(event)

    def on_moved(self, event) -> None:
        self._maybe(event)
