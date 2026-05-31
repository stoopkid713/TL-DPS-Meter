"""Multi-client party simulator (dev tool, gitignored).

Mimic N party members hitting the LIVE Cloudflare room from ONE machine, fed by a real
combat log — so we can test the merged board + live hydration without a second PC.

Three modes (all feed the bots from a real combat log; members are scaled so they rank
distinctly):
  --live    LIVE-tail your log: while the run is active the bots post your GROWING totals as
            TL flushes new lines — so data lands when YOUR fights do. Closest to real players
            fighting alongside you. (Recommended.)
  (default) reactive: replay a one-time log snapshot in climbing slices when the leader Starts.
  --now     post a snapshot immediately, ignoring leader Start/Stop (quick board check).

Watch it: open the real app (or the overlay) joined to the SAME party code → Bot1..BotN
appear alongside you and hydrate as you fight (live mode) or on Start (reactive).

Usage (with the venv python; create the party in the app first, then pass its code):
  backend/.venv/Scripts/python.exe backend/tools/sim_party.py <PARTY_CODE> --live
      [--members 4] [--log PATH] [--delay 1.5] [--rounds 5] [--host wss://...]

If --log is omitted it auto-picks the newest TLCombatLog-*.txt under
%LOCALAPPDATA%\\TL\\Saved\\CombatLogs.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from pathlib import Path

import websockets

# Allow running from tools/ — put backend/ on the path for the shared modules.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from combat_log_parser import parse_line  # noqa: E402
from party_state import PartyState  # noqa: E402

DEFAULT_HOST = "wss://tldps-party.kyle-526.workers.dev"
FIGHT_TS = 1_700_000_000_000  # fixed encounter id so all rounds key to one fight


def find_default_log() -> Path | None:
    base = os.environ.get("LOCALAPPDATA", "")
    if not base:
        return None
    folder = Path(base) / "TL" / "Saved" / "CombatLogs"
    if not folder.is_dir():
        return None
    logs = sorted(folder.glob("TLCombatLog-*.txt"), key=lambda p: p.stat().st_mtime, reverse=True)
    return logs[0] if logs else None


def base_targets(log_path: Path) -> list[dict]:
    """Parse the whole log into the post_fight targets[] shape (real parser + PartyState)."""
    ps = PartyState()
    ps.start_recording("SIM")
    n = 0
    with open(log_path, "r", encoding="utf-8", errors="replace") as f:
        for line in f:
            p = parse_line(line)
            if p is None:
                continue
            ps.record_hit(p["target"], p["damage"], p["is_crit"], p["is_heavy"], p["_timestamp"])
            n += 1
    res = ps.stop_recording()
    print(f"  parsed {n} hits -> {len(res['targets'])} targets, total {res['total_damage']:,}")
    return res["targets"]


def line_count(log_path: Path) -> int:
    """Current number of lines in the log (used to mark the run start cutoff)."""
    try:
        return len(log_path.read_text(encoding="utf-8", errors="replace").splitlines())
    except OSError:
        return 0


def parse_run(log_path: Path, cutoff_line: int) -> list[dict]:
    """Re-parse the log from line `cutoff_line` to EOF into the current running targets[].

    Rebuilt from scratch each call — robust to the file being actively written by the game
    (a mid-write partial last line just fails to parse and is picked up on the next poll).
    This is the LIVE-tail path: as you fight and TL flushes new lines, the running total grows."""
    ps = PartyState()
    ps.start_recording("SIM")
    try:
        lines = log_path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return []
    for line in lines[cutoff_line:]:
        p = parse_line(line)
        if p is not None:
            ps.record_hit(p["target"], p["damage"], p["is_crit"], p["is_heavy"], p["_timestamp"])
    return ps.get_results()["targets"]


def scaled(targets: list[dict], frac: float, mult: float) -> list[dict]:
    """A round slice: `frac` of the fight so far, member damage `mult`. dps ~ constant."""
    out = []
    for t in targets:
        out.append({
            "target": t["target"],
            "total_damage": int(t["total_damage"] * frac * mult),
            "dps": round(t["dps"] * mult, 1),
            "duration": round(t["duration"] * frac, 1),
            "hits": int(t["hits"] * frac),
            "crit_rate": t["crit_rate"],
            "heavy_rate": t["heavy_rate"],
        })
    return out


async def member(host: str, code: str, idx: int, base: list[dict], rounds: int,
                 delay: float, mode: str, log_path: Path, run: dict):
    """A persistent simulated member that behaves like a real client.

    Modes:
      live      — mirror YOUR real combat: while the run is active, Bot1 re-tails the log
                  (parse_run) and the bots post the GROWING totals as TL flushes new lines.
                  This is "other players fighting alongside you" — data lands when your fights do.
      reactive  — replay a one-time snapshot of the log in climbing slices (no live tail).
      now       — post the full snapshot immediately, ignoring leader Start/Stop (quick check).

    live/reactive react to the leader's encounter_start/encounter_end (relayed by the room);
    `run` is shared state (the live running totals + cutoff). Ctrl+C to remove the bots."""
    uid = f"sim{idx}"
    name = f"Bot{idx}"
    mult = round(1.0 - 0.15 * (idx - 1), 3)  # Bot1 hardest, descending
    url = f"{host}/party/{code}?user_id={uid}&username={name}&leader=0"
    st = {"active": False, "frac": 0.0}  # per-bot state (reactive mode)
    try:
        async with websockets.connect(url, max_size=None) as ws:
            tail = " (LIVE-tailing your log)" if mode == "live" else ""
            wait = "" if mode == "now" else " - waiting for leader Start..."
            print(f"  {name} connected (x{mult}){tail}{wait}")

            async def post(targets):
                # F2 protocol v2 envelope: targets (boss-detection input) + opaque summary.
                summary = {"total_damage": sum(t.get("total_damage", 0) for t in targets),
                           "duration": max((t.get("duration", 0) for t in targets), default=0)}
                await ws.send(json.dumps({"type": "post_fight", "v": 2, "fight_ts": FIGHT_TS,
                                          "targets": targets, "summary": summary,
                                          "skills": None, "rotation": None}))

            async def reader():
                async for raw in ws:
                    try:
                        m = json.loads(raw)
                    except Exception:
                        continue
                    t = m.get("type")
                    if mode == "now":
                        continue
                    started = t == "encounter_start" or (t == "welcome" and m.get("encounter_active"))
                    if started:
                        if mode == "live":
                            if idx == 1:
                                run["cutoff_line"] = line_count(log_path)
                                run["targets"] = []
                                run["active"] = True
                                print("  >> leader started - bots now tailing your live combat")
                        else:
                            st["active"], st["frac"] = True, 0.0
                            if idx == 1:
                                print("  >> leader started - bots hydrating")
                    elif t == "encounter_end":
                        if mode == "live":
                            if idx == 1:
                                run["active"] = False
                                run["targets"] = parse_run(log_path, run["cutoff_line"])  # final
                                print("  >> leader ended - bots posted final")
                        else:
                            st["active"] = False
                            await post(scaled(base, 1.0, mult))
                            if idx == 1:
                                print("  >> leader ended - bots posted final")

            async def poster():
                while True:
                    await asyncio.sleep(delay)
                    if mode == "now":
                        await post(scaled(base, 1.0, mult))
                    elif mode == "live":
                        if idx == 1 and run["active"]:
                            run["targets"] = parse_run(log_path, run["cutoff_line"])
                        if run["targets"]:
                            await post(scaled(run["targets"], 1.0, mult))
                    else:  # reactive snapshot
                        if st["active"] and st["frac"] < 1.0:
                            st["frac"] = min(1.0, st["frac"] + 1.0 / rounds)
                            await post(scaled(base, st["frac"], mult))

            await asyncio.gather(reader(), poster())
    except (asyncio.CancelledError, KeyboardInterrupt):
        pass
    except Exception as exc:
        print(f"  {name} error: {exc}", file=sys.stderr)


async def main_async(args) -> int:
    log_path = Path(args.log) if args.log else find_default_log()
    if not log_path or not log_path.is_file():
        print("No combat log found. Pass --log <path to a TLCombatLog-*.txt>.", file=sys.stderr)
        return 2
    print(f"log: {log_path}")

    mode = "now" if args.now else ("live" if args.live else "reactive")
    base: list[dict] = []
    if mode != "live":
        base = base_targets(log_path)  # snapshot the log once
        if not base:
            print("No DamageDone hits parsed from that log.", file=sys.stderr)
            return 2

    blurb = {"live": "LIVE - mirror your real combat as the log flushes",
             "reactive": "REACTIVE - replay a log snapshot in climbing slices on Start",
             "now": "NOW - post immediately, ignoring leader"}[mode]
    print(f"connecting {args.members} members -> {args.host}/party/{args.code.upper()}  [{blurb}]")
    if mode != "now":
        print("  Hit Start in the app to begin; play normally; hit Stop to finalize. Ctrl+C here to remove bots.")

    run = {"active": False, "cutoff_line": 0, "targets": []}  # shared live-tail state
    try:
        await asyncio.gather(*[
            member(args.host, args.code.upper(), i, base, args.rounds, args.delay, mode, log_path, run)
            for i in range(1, args.members + 1)
        ])
    except KeyboardInterrupt:
        pass
    print("done.")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="Simulate N party members against the live room.")
    ap.add_argument("code", help="party code to join (create/join it in the app first)")
    ap.add_argument("--members", type=int, default=4)
    ap.add_argument("--log", default="")
    ap.add_argument("--rounds", type=int, default=5, help="reactive mode: slices to climb over")
    ap.add_argument("--delay", type=float, default=1.5, help="seconds between posts / live polls")
    ap.add_argument("--host", default=DEFAULT_HOST)
    ap.add_argument("--live", action="store_true",
                    help="LIVE-tail the log: bots mirror your real combat as it flushes (most realistic)")
    ap.add_argument("--now", action="store_true",
                    help="post a snapshot immediately, ignoring leader Start/Stop (quick board check)")
    args = ap.parse_args()
    try:
        return asyncio.run(main_async(args))
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
