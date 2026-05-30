"""Off-by-default structured tracer for TL-DPS-Meter internals.

Enable with env ``TLDPS_DEBUG=1`` (or call :func:`enable`). When OFF, :func:`trace`
is a one-bool no-op — zero file I/O, safe to leave in hot paths. When ON, every
call appends one JSONL line to ``<data_dir>/tldps-debug.jsonl`` stamped with a
**monotonic sequence number, wall clock, and thread name**, and (if a live sink is
registered) forwards the same record to that sink — the WS broadcast, so an
observer sees internals in real time.

The seq# + thread name are the whole point: the reset/auto-queue bugs live in the
interleaving between the hotkey thread, the asyncio loop, and the watchdog observer
thread. A flat log can't show a race; a seq-ordered, thread-stamped trace can.
"""
from __future__ import annotations

import itertools
import json
import os
import threading
from datetime import datetime
from pathlib import Path
from typing import Callable, Optional

_TRUTHY = {"1", "true", "yes", "on"}

_enabled: bool = os.environ.get("TLDPS_DEBUG", "").strip().lower() in _TRUTHY
_seq = itertools.count(1)
_logfile: Optional[Path] = None
_file_lock = threading.Lock()
_sink: Optional[Callable[[dict], None]] = None


def enabled() -> bool:
    return _enabled


def enable(on: bool = True) -> None:
    global _enabled
    _enabled = on


def configure(data_dir=None, sink: Optional[Callable[[dict], None]] = None) -> None:
    """Point the trace log at ``data_dir`` and/or register a live sink (WS broadcast)."""
    global _logfile, _sink
    if data_dir is not None:
        _logfile = Path(data_dir) / "tldps-debug.jsonl"
        if _enabled:
            # mark a session boundary so successive runs are easy to separate
            _write({"seq": 0, "ts": datetime.now().isoformat(timespec="milliseconds"),
                    "thread": threading.current_thread().name, "event": "session.start",
                    "logfile": str(_logfile)})
    if sink is not None:
        _sink = sink


def logfile() -> Optional[Path]:
    return _logfile


def _write(rec: dict) -> None:
    if _logfile is None:
        return
    try:
        with _file_lock:
            with open(_logfile, "a", encoding="utf-8") as f:
                f.write(json.dumps(rec, default=str) + "\n")
    except OSError:
        pass


def trace(event: str, **fields) -> None:
    """Record one internal event. No-op unless tracing is enabled."""
    if not _enabled:
        return
    rec = {
        "seq": next(_seq),
        "ts": datetime.now().strftime("%H:%M:%S.%f")[:-3],
        "thread": threading.current_thread().name,
        "event": event,
        **fields,
    }
    _write(rec)
    if _sink is not None:
        try:
            _sink(rec)
        except Exception:
            pass  # a debug sink must never break the app
