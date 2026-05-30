"""Phase 4 gate: log watcher + async pipeline.

Covers the pure tail/rotation logic (``poll`` called directly — deterministic, no
watchdog timing), the thread-safety guarantee (the observer-thread path only
marshals onto the loop and never mutates state), and a real end-to-end watchdog +
WebSocket test (appending to a temp ``.txt`` drives increasing ``total_damage``
over a live WS client).
"""
from __future__ import annotations

import asyncio
import json
import pathlib

import websockets

from dps_meter_server import DPSMeterServer
from log_watcher import LogWatcher

HEADER = "CombatLogVersion,4\n"


def _dmg(i: int, dmg: int, *, skill="Star Destroyer", target="Practice Dummy") -> str:
    ss = i % 60
    return (f"20260530-01:00:{ss:02d}:000,DamageDone,{skill},123,{dmg},"
            f"1,0,kMaxDamageByCriticalDecision,Player,{target}")


def _dmg_at(dt, dmg: int, *, skill="Star Destroyer", target="Practice Dummy") -> str:
    """A damage line stamped at a specific wall time (for reset_after_timestamp tests)."""
    return (f"{dt.strftime('%Y%m%d-%H:%M:%S')}:000,DamageDone,{skill},123,{dmg},"
            f"1,0,kMaxDamageByCriticalDecision,Player,{target}")


def _write(path: pathlib.Path, text: str) -> None:
    with open(path, "a", encoding="utf-8") as f:
        f.write(text)
        f.flush()


def _total(server) -> int:
    return sum(h["damage"] for h in server.stats.hits)


# ===========================================================================
# Unit: tail / rotation / position (poll() called directly, no watchdog, no loop)
# ===========================================================================
def test_read_new_lines_tails(tmp_path):
    logdir = tmp_path / "logs"
    logdir.mkdir()
    f = logdir / "TLCombatLog-1.txt"
    _write(f, HEADER + _dmg(1, 100) + "\n")
    server = DPSMeterServer(tmp_path, port=0)
    w = LogWatcher(server, log_dir=logdir)
    w._attach(f, from_start=True)

    first = w.read_new_lines()
    assert first[0].startswith("CombatLogVersion")
    assert len(first) == 2  # header + 1 damage line
    pos_after = w.file_position
    assert w.read_new_lines() == []  # nothing new
    assert w.file_position == pos_after

    _write(f, _dmg(2, 200) + "\n")
    nxt = w.read_new_lines()
    assert len(nxt) == 1 and "200" in nxt[0]


def test_find_latest_log_picks_newest_by_name(tmp_path):
    logdir = tmp_path / "logs"
    logdir.mkdir()
    for name in ("TLCombatLog-220000.txt", "TLCombatLog-230000.txt", "other.log"):
        _write(logdir / name, HEADER)
    w = LogWatcher(DPSMeterServer(tmp_path, port=0), log_dir=logdir)
    assert w._find_latest_log().name == "TLCombatLog-230000.txt"


def test_poll_ingests_and_advances(tmp_path):
    logdir = tmp_path / "logs"
    logdir.mkdir()
    f = logdir / "TLCombatLog-1.txt"
    _write(f, HEADER)
    server = DPSMeterServer(tmp_path, port=0)
    w = LogWatcher(server, log_dir=logdir)
    w._attach(f, from_start=True)
    assert w.poll() == 1  # just the header line (no damage yet)
    assert _total(server) == 0

    _write(f, _dmg(1, 100) + "\n" + _dmg(2, 250) + "\n")
    assert w.poll() == 2
    assert _total(server) == 350
    assert len(server.stats.hits) == 2
    assert w.poll() == 0  # idempotent: nothing new


def test_rotation_switches_to_newer_file(tmp_path):
    logdir = tmp_path / "logs"
    logdir.mkdir()
    a = logdir / "TLCombatLog-100000.txt"
    _write(a, HEADER + _dmg(1, 100) + "\n")
    server = DPSMeterServer(tmp_path, port=0)
    w = LogWatcher(server, log_dir=logdir)
    w._attach(a, from_start=True)
    w.poll()
    assert _total(server) == 100

    # A newer file appears (rotation).
    b = logdir / "TLCombatLog-200000.txt"
    _write(b, HEADER + _dmg(2, 500) + "\n")
    w.poll()  # should switch to b and read from its start
    assert w.current_file == b
    assert _total(server) == 600  # 100 from a + 500 from b


def test_attach_tail_skips_existing(tmp_path):
    logdir = tmp_path / "logs"
    logdir.mkdir()
    f = logdir / "TLCombatLog-1.txt"
    _write(f, HEADER + _dmg(1, 100) + "\n")
    server = DPSMeterServer(tmp_path, port=0)
    w = LogWatcher(server, log_dir=logdir)
    w._attach(f, from_start=False)  # tail: ignore existing content
    assert w.poll() == 0
    assert _total(server) == 0
    _write(f, _dmg(2, 999) + "\n")
    assert w.poll() == 1
    assert _total(server) == 999


# ===========================================================================
# Thread-safety: the observer-thread entry point only marshals onto the loop.
# ===========================================================================
def test_observer_thread_only_marshals(tmp_path):
    logdir = tmp_path / "logs"
    logdir.mkdir()
    f = logdir / "TLCombatLog-1.txt"
    _write(f, HEADER + _dmg(1, 100) + "\n")
    server = DPSMeterServer(tmp_path, port=0)
    w = LogWatcher(server, log_dir=logdir)
    w._attach(f, from_start=True)

    calls = []

    class _RecordingLoop:
        def call_soon_threadsafe(self, cb, *args):
            calls.append((cb, args))

    w.loop = _RecordingLoop()
    before_pos, before_file, before_hits = w.file_position, w.current_file, len(server.stats.hits)

    # Simulate a watchdog event arriving on the observer thread.
    w._on_event(str(f))

    # It must have marshalled poll() onto the loop and changed NOTHING else.
    assert calls == [(w.poll, ())]
    assert w.file_position == before_pos
    assert w.current_file == before_file
    assert len(server.stats.hits) == before_hits


# ===========================================================================
# Integration: watchdog -> loop -> ingest -> WS broadcast (end-to-end).
# ===========================================================================
def test_watchdog_drives_total_damage_over_ws(tmp_path):
    asyncio.run(_watchdog_e2e(tmp_path))


async def _watchdog_e2e(tmp_path):
    logdir = tmp_path / "logs"
    logdir.mkdir()
    f = logdir / "TLCombatLog-001.txt"
    _write(f, HEADER)  # header only; watcher attaches, 0 damage

    server = DPSMeterServer(tmp_path, port=0, broadcast_interval=0.1)
    await server.start()
    watcher = LogWatcher(server, log_dir=logdir)
    watcher.start()
    try:
        uri = f"ws://localhost:{server.port}"
        async with websockets.connect(uri, max_size=None) as ws:
            # First batch of hits.
            _write(f, _dmg(1, 1000) + "\n" + _dmg(2, 1500) + "\n")
            first = await _wait_for_total(ws, at_least=1, timeout=4.0)
            assert first >= 2500, f"expected >=2500, saw {first}"

            # Second batch must drive it higher (watcher keeps tailing).
            _write(f, _dmg(3, 4000) + "\n")
            second = await _wait_for_total(ws, at_least=first + 1, timeout=4.0)
            assert second >= 6500, f"expected >=6500, saw {second}"
    finally:
        watcher.stop()
        await server.stop()


async def _wait_for_total(ws, *, at_least, timeout):
    """Wait until a stats broadcast reports total_damage >= at_least; return it."""
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    best = 0
    while loop.time() < deadline:
        try:
            raw = await asyncio.wait_for(ws.recv(), deadline - loop.time())
        except asyncio.TimeoutError:
            break
        msg = json.loads(raw)
        if msg.get("type") == "stats":
            best = max(best, msg["data"]["total_damage"])
            if best >= at_least:
                return best
    return best


# ===========================================================================
# Regression: reset must draw a line in the sand (2026-05-30 clipped-run bug).
#
# The bug: on reset, stats.reset() cleared the buffer but file_position was left
# lagging behind EOF, so the next poll re-ingested the unread backlog of pre-reset
# combat and the 60s window clipped to it. The fix wires watcher.skip_to_end() into
# both reset paths so the read cursor jumps to EOF and old lines can't re-enter.
# ===========================================================================
def test_skip_to_end_discards_unread_backlog(tmp_path):
    logdir = tmp_path / "logs"
    logdir.mkdir()
    f = logdir / "TLCombatLog-1.txt"
    _write(f, HEADER + _dmg(1, 100) + "\n")
    server = DPSMeterServer(tmp_path, port=0)
    w = LogWatcher(server, log_dir=logdir)
    w._attach(f, from_start=True)
    w.poll()
    assert _total(server) == 100

    # Backlog: more OLD combat lands in the file but is never polled (the lag).
    _write(f, _dmg(2, 7777) + "\n" + _dmg(3, 8888) + "\n")

    # Reset draws the line: clear stats AND skip the unread backlog.
    server.stats.reset()
    w.skip_to_end()
    assert _total(server) == 0

    # NEW combat after the line — only THIS may enter the buffer.
    _write(f, _dmg(4, 500) + "\n")
    assert w.poll() == 1                 # the new line only, NOT the 2 backlog lines
    assert _total(server) == 500
    assert len(server.stats.hits) == 1


def test_reset_command_drops_lagged_pre_reset_combat(tmp_path):
    """The reset COMMAND (_h_reset) records reset_after_timestamp and ignores combat
    from before it — even when TL flushes that combat to the file AFTER the reset.
    This is the real clipped-run bug: file-position skipping alone can't fix it
    because the log lags; the timestamp filter is the guarantee."""
    from datetime import datetime, timedelta
    from dps_meter_server import _h_reset

    logdir = tmp_path / "logs"
    logdir.mkdir()
    f = logdir / "TLCombatLog-1.txt"
    _write(f, HEADER)
    server = DPSMeterServer(tmp_path, port=0)
    w = LogWatcher(server, log_dir=logdir)
    server.watcher = w
    w._attach(f, from_start=True)
    w.poll()

    now = datetime.now()
    _h_reset(server, {})                                   # draw the line at `now`
    assert server.reset_after_timestamp is not None

    # TL flushes PRE-reset combat (5 min ago) to the file only now (the lag)...
    _write(f, _dmg_at(now - timedelta(minutes=5), 9999) + "\n")
    # ...then the real POST-reset test lands.
    _write(f, _dmg_at(now + timedelta(seconds=2), 500) + "\n")
    w.poll()

    assert _total(server) == 500         # 9999 dropped by timestamp, not file position
    assert len(server.stats.hits) == 1


def test_reset_hotkey_drops_lagged_pre_reset_combat(tmp_path):
    """The reset HOTKEY path (trigger_reset) must apply the same timestamp filter."""
    asyncio.run(_reset_hotkey_e2e(tmp_path))


async def _reset_hotkey_e2e(tmp_path):
    from datetime import datetime, timedelta

    logdir = tmp_path / "logs"
    logdir.mkdir()
    f = logdir / "TLCombatLog-1.txt"
    _write(f, HEADER)
    server = DPSMeterServer(tmp_path, port=0)
    await server.start()
    w = LogWatcher(server, log_dir=logdir)
    server.watcher = w
    w._attach(f, from_start=True)
    w.poll()
    try:
        now = datetime.now()
        await server.trigger_reset()                       # hotkey path
        assert server.reset_after_timestamp is not None
        _write(f, _dmg_at(now - timedelta(minutes=5), 9999) + "\n")   # late backlog
        _write(f, _dmg_at(now + timedelta(seconds=2), 500) + "\n")    # real test
        w.poll()
        assert _total(server) == 500     # backlog dropped by timestamp
        assert len(server.stats.hits) == 1
    finally:
        await server.stop()
