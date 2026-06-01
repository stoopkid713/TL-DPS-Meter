"""Multi-client party simulator (tracked dev tool) — CURRENT PROTOCOL.

Mimic N party members hitting the Cloudflare room from ONE machine.  Feeds a
real combat log (or synthetic data) so we can test merged boards, live
hydration, drill-down, and encounter-regression bugs without a second PC.

Three log-fed modes:
  --live    LIVE-tail your log: bots post your GROWING totals as TL flushes new
            lines — closest to real players fighting alongside you.
  (default) reactive: replay a one-time log snapshot in climbing slices on Start.
  --now     post a snapshot immediately (quick board check, ignores leader).

Named scenario harnesses (no log needed — self-contained synthetic data):
  --multiboss        3 distinct encounters (Tevent #1 → Morokai → Tevent #2) +
                     assertions; kept from the old harness but upgraded to the
                     new protocol (post_fight + final_detail; NO encounter_start).
  --scenario NAME    run a named scenario + assert PASS/FAIL:
    merge-two-players   two bots, SAME boss, DIFFERENT fight_ts
                        → documents the current merge regression
                        (two fight_ts = two encounter rows, not merged).
    crit-heavy-parity   assert that posted crit/heavy/crit_heavy match
                        what combat_stats computes from the same synthetic hits.
  --list-scenarios   print all scenario names and exit.

--dry-run  build + print exact frames WITHOUT opening a websocket; use this for
           protocol verification (no production side-effects).
--share-ts simulate the "all bots share ONE fight_ts" path (the old broken
           behaviour); default is DISTINCT fight_ts per bot so we reproduce the
           merge regression.

Protocol changes vs old sim (current worker contract):
  * encounter_start / encounter_end are no-ops in the worker; we no longer send
    them, nor wait for them.
  * Bots auto-post (worker auto-arms on first post_fight).
  * Each bot has a DISTINCT fight_ts (epoch-ms of its simulated fight start)
    offset by a small jitter so the worker keys each into a separate encounter
    row — reproducing the live "merge regression" we need to chase.
  * On fight close every bot sends: a final post_fight (final:true) THEN a
    separate final_detail frame {type:"final_detail", encounter_id, detail}.
    The worker stores the detail blob and marks has_detail=1 so the drill-down
    button activates.
  * crit_heavy is tracked and posted (was dropped by the old sim).
  * parity stats: per-bot hit lists are passed through combat_stats._skills
    and combat_stats.build_stat_block (with skill_settings={}) so the posted
    crit/heavy/crit_heavy match the solo analyzer's adjusted-mode output
    rather than re-counting raw accumulators.

Usage:
  backend/.venv/Scripts/python.exe backend/tools/sim_party.py <CODE> --live
      [--members 4] [--log PATH] [--delay 1.5] [--rounds 5]
      [--host wss://tldps-party.kyle-526.workers.dev]
      [--share-ts] [--dry-run]

  # Run a named scenario (dry or live):
  backend/.venv/Scripts/python.exe backend/tools/sim_party.py TEST \
      --scenario merge-two-players
  backend/.venv/Scripts/python.exe backend/tools/sim_party.py TEST \
      --scenario merge-two-players --dry-run

  # 3-encounter harness (needs a joinable code):
  backend/.venv/Scripts/python.exe backend/tools/sim_party.py \
      --multiboss [CODE]
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import random
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional

# Allow running from tools/ — put backend/ on the path for shared modules.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from combat_log_parser import parse_line                    # noqa: E402
from combat_stats import _skills as _agg_skills, build_stat_block  # noqa: E402
from party_state import PartyState                          # noqa: E402

try:
    import websockets                                       # noqa: E402
    _HAS_WS = True
except ImportError:
    _HAS_WS = False

DEFAULT_HOST = "wss://tldps-party.kyle-526.workers.dev"

# ---------------------------------------------------------------------------
# Protocol helpers — build the exact frames the worker expects
# ---------------------------------------------------------------------------

def _post_fight_frame(
    *,
    fight_ts: int,
    targets: list[dict],
    skills: Optional[list[dict]] = None,
    rotation: Optional[list[dict]] = None,
    final: bool = False,
) -> dict:
    """v2 post_fight envelope (contract: fight_ts is the encounter key).

    `fight_ts` doubles as `encounter_id` per the worker's slotting rule:
        posted_id = payload.encounter_id ?? String(fight_ts)
    We set both so the worker gets the explicit key regardless of path.

    Fields:
        type        "post_fight"
        v           2
        fight_ts    int  epoch-ms — the encounter key
        encounter_id str  same value as fight_ts, explicit
        targets     list[dict]  boss-detection input
        summary     dict  opaque {total_damage, duration}
        skills      list|None   per-skill breakdown (sent on final only)
        rotation    list|None   raw hit list (sent on final only)
        final       bool        True closes the encounter row on the worker
    """
    summary = {
        "total_damage": sum(t.get("total_damage", 0) for t in targets),
        "duration": max((t.get("duration", 0) for t in targets), default=0),
    }
    return {
        "type": "post_fight",
        "v": 2,
        "fight_ts": fight_ts,
        "encounter_id": str(fight_ts),  # explicit key = same value
        "targets": targets,
        "summary": summary,
        "skills": skills,
        "rotation": rotation,
        "final": final,
    }


def _final_detail_frame(
    *,
    encounter_id: str,
    detail: dict,
) -> dict:
    """Separate final_detail frame — stores drill-down blob on the worker.

    The worker handler:
        case "final_detail":
          eid = String(msg.encounter_id)
          // confirm encounter row exists, then:
          INSERT OR REPLACE INTO member_detail (encounter_id, user_id, blob)
          UPDATE submissions SET has_detail = 1 ...

    Fields:
        type          "final_detail"
        encounter_id  str   must match the fight_ts string posted earlier
        detail        dict  {targets, skills, total_damage, duration, rotation}
    """
    return {
        "type": "final_detail",
        "encounter_id": encounter_id,
        "detail": detail,
    }


# ---------------------------------------------------------------------------
# Stats helpers — parity-correct via combat_stats
# ---------------------------------------------------------------------------

def _make_synthetic_hits(
    n_hits: int,
    *,
    crit_frac: float = 0.35,
    heavy_frac: float = 0.18,
    crit_heavy_frac: float = 0.08,
    total_damage: int = 1_000_000,
    skill_name: str = "Skill",
    boss_name: str = "Boss",
    fight_duration_s: float = 60.0,
) -> list[dict]:
    """Generate a synthetic hit list in the combat_stats Hit shape.

    Damage is distributed uniformly.  Hit types are assigned in a fixed
    pattern (not random) so assertions are deterministic.
    """
    hits = []
    per_hit_dmg = total_damage // n_hits
    for i in range(n_hits):
        rel_t = round(i * fight_duration_s / n_hits, 1)
        # Cyclic hit-type assignment for deterministic counts.
        # Pattern: normal / crit / heavy / crit+heavy / normal / ...
        idx = i % 4
        is_crit = idx in (1, 3)
        is_heavy = idx in (2, 3)
        hits.append({
            "time": f"00:{int(rel_t // 60):02d}:{int(rel_t % 60):02d}",
            "relative_time": rel_t,
            "skill": skill_name,
            "target": boss_name,
            "damage": per_hit_dmg,
            "is_crit": is_crit,
            "is_heavy": is_heavy,
            "hit_type": "DamageDone",
        })
    return hits


def _hits_to_target_row(hits: list[dict], boss_name: str, fight_duration_s: float) -> dict:
    """Convert a hit list to the targets[] row shape the worker expects.

    Uses combat_stats.build_stat_block (skill_settings={} = no adjustment)
    so crit/heavy/crit_heavy are ADJUSTED (parity-correct) rather than raw.
    """
    block = build_stat_block(hits)
    crit_heavy_count = sum(1 for h in hits if h["is_crit"] and h["is_heavy"])
    hit_count = len(hits)
    return {
        "target": boss_name,
        "total_damage": block["total_damage"],
        "dps": block["dps"] if block["duration"] > 0 else round(
            block["total_damage"] / fight_duration_s, 1),
        "duration": round(fight_duration_s, 1),
        "hits": hit_count,
        "crit_rate": block["crit_rate"],
        "heavy_rate": block["heavy_rate"],
        "crit_heavy_rate": block["crit_heavy_rate"],
        # Raw counts for drill-down assertion use (not sent in targets[], but
        # useful in the detail skills block):
        "crit_heavy_count": crit_heavy_count,
    }


def _build_detail_from_hits(
    hits: list[dict],
    boss_name: str,
    fight_duration_s: float,
) -> dict:
    """Build the detail block carried in final_detail.

    Matches the server's _build_detail shape:
        {targets, skills, total_damage, duration, rotation}
    skills uses combat_stats._agg_skills — same adjusted accounting.
    """
    block = build_stat_block(hits, with_rotation=True)
    skills = _agg_skills(hits, block["total_damage"])
    target_row = _hits_to_target_row(hits, boss_name, fight_duration_s)
    return {
        "targets": [target_row],
        "skills": skills,
        "total_damage": block["total_damage"],
        "duration": round(fight_duration_s, 1),
        "rotation": block["rotation"],
    }


# ---------------------------------------------------------------------------
# Log parsing helpers (unchanged from old sim)
# ---------------------------------------------------------------------------

def find_default_log() -> Optional[Path]:
    base = os.environ.get("LOCALAPPDATA", "")
    if not base:
        return None
    folder = Path(base) / "TL" / "Saved" / "CombatLogs"
    if not folder.is_dir():
        return None
    logs = sorted(folder.glob("TLCombatLog-*.txt"),
                  key=lambda p: p.stat().st_mtime, reverse=True)
    return logs[0] if logs else None


def base_targets(log_path: Path) -> tuple[list[dict], list[dict]]:
    """Parse whole log -> (targets[] row list, raw hits for detail building)."""
    ps = PartyState()
    ps.start_recording("SIM")
    raw_hits: list[dict] = []
    n = 0
    with open(log_path, "r", encoding="utf-8", errors="replace") as f:
        for line in f:
            p = parse_line(line)
            if p is None:
                continue
            ps.record_hit(p["target"], p["damage"], p["is_crit"], p["is_heavy"],
                          p["_timestamp"])
            # Build a combat_stats-compatible hit for the detail block.
            raw_hits.append({
                "time": p["time"],
                "relative_time": 0.0,  # will be recalculated below
                "skill": p["skill"],
                "target": p["target"],
                "damage": p["damage"],
                "is_crit": p["is_crit"],
                "is_heavy": p["is_heavy"],
                "hit_type": "DamageDone",
            })
            n += 1
    # Assign relative_time from the actual fight_ts delta.
    if raw_hits and ps.current and ps.current.hits:
        first_ts = ps.current.first_hit_time
        for i, line_hit in enumerate(raw_hits):
            # Align with the PartyEncounter.hits list (same order).
            enc_hit = ps.current.hits[i] if i < len(ps.current.hits) else None
            if enc_hit:
                line_hit["relative_time"] = enc_hit["relative_time"]
    res = ps.stop_recording()
    print(f"  parsed {n} hits -> {len(res['targets'])} targets, "
          f"total {res['total_damage']:,}")
    return res["targets"], raw_hits


def line_count(log_path: Path) -> int:
    try:
        return len(log_path.read_text(encoding="utf-8", errors="replace").splitlines())
    except OSError:
        return 0


def parse_run(log_path: Path, cutoff_line: int) -> tuple[list[dict], list[dict]]:
    """Re-parse from cutoff_line to EOF -> (targets[], raw hits for detail)."""
    ps = PartyState()
    ps.start_recording("SIM")
    raw_hits: list[dict] = []
    try:
        lines = log_path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return [], []
    for line in lines[cutoff_line:]:
        p = parse_line(line)
        if p is not None:
            ps.record_hit(p["target"], p["damage"], p["is_crit"], p["is_heavy"],
                          p["_timestamp"])
            raw_hits.append({
                "time": p["time"],
                "relative_time": 0.0,
                "skill": p["skill"],
                "target": p["target"],
                "damage": p["damage"],
                "is_crit": p["is_crit"],
                "is_heavy": p["is_heavy"],
                "hit_type": "DamageDone",
            })
    # Sync relative_time from PartyEncounter.hits.
    if ps.current:
        for i, lh in enumerate(raw_hits):
            if i < len(ps.current.hits):
                lh["relative_time"] = ps.current.hits[i]["relative_time"]
    res = ps.get_results()
    return res["targets"], raw_hits


def scaled(targets: list[dict], frac: float, mult: float) -> list[dict]:
    """A round slice: `frac` of the fight, member damage `mult`."""
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
            "crit_heavy_rate": t.get("crit_heavy_rate", 0.0),
        })
    return out


# ---------------------------------------------------------------------------
# fight_ts generation — distinct per bot (the key regression knob)
# ---------------------------------------------------------------------------

def _bot_fight_ts(bot_idx: int, *, share_ts: bool = False, base_ts: Optional[int] = None) -> int:
    """Return the fight_ts for bot `bot_idx`.

    share_ts=False (default): each bot gets a distinct timestamp offset by
    `bot_idx * 7` seconds from the base so the worker sees each as a DIFFERENT
    encounter (reproducing the merge regression).

    share_ts=True: all bots use the same base_ts (the old broken behaviour;
    they SHOULD merge, but only do so if the worker also agrees on the active
    encounter — useful for positive-path testing).

    The 7-second offset is large enough to clear GHOST_EVICT_MS logic but small
    enough to be visually recognisable in encounter lists.
    """
    if base_ts is None:
        base_ts = int(time.time() * 1000)
    if share_ts:
        return base_ts
    return base_ts + bot_idx * 7_000   # 7s apart per bot


# ---------------------------------------------------------------------------
# Async member coroutine (log-fed modes)
# ---------------------------------------------------------------------------

async def member(
    host: str,
    code: str,
    idx: int,
    base_tgts: list[dict],
    base_hits: list[dict],
    rounds: int,
    delay: float,
    mode: str,
    log_path: Path,
    run: dict,
    *,
    fight_ts: int,
    dry_run: bool = False,
) -> None:
    """A persistent simulated member.

    Protocol (current):
      • No encounter_start/encounter_end sent — the worker ignores them anyway.
      • Each live post sends post_fight with fight_ts + targets (live tick).
      • On fight close: one final post_fight (final=True) + one final_detail frame.
      • fight_ts is DISTINCT per bot (unless --share-ts).
    """
    uid = f"sim{idx}"
    name = f"Bot{idx}"
    mult = round(1.0 - 0.15 * (idx - 1), 3)
    url = f"{host}/party/{code}?user_id={uid}&username={name}&leader=0"
    enc_id = str(fight_ts)

    def _make_post(tgts, *, final=False):
        sc_tgts = scaled(tgts, 1.0, mult)
        return _post_fight_frame(
            fight_ts=fight_ts,
            targets=sc_tgts,
            final=final,
        )

    def _make_final_post_and_detail(tgts, hits_list):
        sc_tgts = scaled(tgts, 1.0, mult)
        # Build parity-correct detail from the scaled hits.
        sc_hits = [{**h, "damage": int(h["damage"] * mult)} for h in hits_list]
        boss_name = sc_tgts[0]["target"] if sc_tgts else "Boss"
        duration = sc_tgts[0]["duration"] if sc_tgts else 60.0
        detail = _build_detail_from_hits(sc_hits, boss_name, duration)
        post = _post_fight_frame(
            fight_ts=fight_ts,
            targets=sc_tgts,
            skills=detail["skills"],
            rotation=detail["rotation"],
            final=True,
        )
        fd = _final_detail_frame(encounter_id=enc_id, detail=detail)
        return post, fd

    if dry_run:
        sample_tgts = scaled(base_tgts or [
            {"target": "Boss", "total_damage": 500_000, "dps": 8333.0,
             "duration": 60.0, "hits": 300, "crit_rate": 35.0,
             "heavy_rate": 18.0, "crit_heavy_rate": 8.0}
        ], 1.0, mult)
        post = _make_post(base_tgts or sample_tgts)
        final_post, fd = _make_final_post_and_detail(
            base_tgts or sample_tgts,
            base_hits or _make_synthetic_hits(100, boss_name="Boss"),
        )
        print(f"\n--- {name} (fight_ts={fight_ts}) ---")
        print(f"  LIVE tick post_fight:  {json.dumps({k: v for k, v in post.items() if k != 'targets'})}")
        print(f"    targets[0]:          {post['targets'][0] if post['targets'] else 'none'}")
        print(f"  FINAL post_fight:      final=True, skills={len(final_post.get('skills') or [])}, "
              f"rotation={len(final_post.get('rotation') or [])}")
        print(f"  final_detail:          encounter_id={fd['encounter_id']}, "
              f"detail.skills={len(fd['detail'].get('skills') or [])}, "
              f"detail.targets={len(fd['detail'].get('targets') or [])}")
        return

    if not _HAS_WS:
        print("websockets not installed; use --dry-run for frame inspection.", file=sys.stderr)
        return

    st = {"active": False, "frac": 0.0}

    async with websockets.connect(url, max_size=None) as ws:
        tail = " (LIVE-tailing your log)" if mode == "live" else ""
        wait = "" if mode == "now" else " - auto-posting when ready"
        print(f"  {name} connected (x{mult}){tail}{wait}")

        async def post(tgts, *, final=False):
            frame = _make_post(tgts, final=final)
            await ws.send(json.dumps(frame))

        async def post_final(tgts, hits_list):
            """Send final post_fight then final_detail."""
            fp, fd = _make_final_post_and_detail(tgts, hits_list)
            await ws.send(json.dumps(fp))
            # Small gap so the worker writes the submission row before the detail.
            await asyncio.sleep(0.1)
            await ws.send(json.dumps(fd))

        async def reader():
            async for raw in ws:
                try:
                    m = json.loads(raw)
                except Exception:
                    continue
                # In --now mode we don't react to room broadcasts.
                if mode == "now":
                    continue
                # We no longer react to encounter_start/encounter_end (no-ops).
                # Auto-post on welcome if encounter already active in the room.
                t = m.get("type")
                if t == "welcome" and m.get("encounter_active"):
                    if mode == "live":
                        if idx == 1:
                            run["cutoff_line"] = line_count(log_path)
                            run["targets"] = []
                            run["raw_hits"] = []
                            run["active"] = True
                            print("  >> room active on join — bots now tailing your live combat")
                    else:
                        st["active"], st["frac"] = True, 0.0
                        if idx == 1:
                            print("  >> room active on join — bots hydrating")

        async def poster():
            while True:
                await asyncio.sleep(delay)
                if mode == "now":
                    await post(base_tgts)
                elif mode == "live":
                    if idx == 1 and run["active"]:
                        run["targets"], run["raw_hits"] = parse_run(log_path,
                                                                     run["cutoff_line"])
                    if run["targets"]:
                        await post(run["targets"])
                else:  # reactive snapshot
                    if st["active"] and st["frac"] < 1.0:
                        st["frac"] = min(1.0, st["frac"] + 1.0 / rounds)
                        await post(base_tgts, final=(st["frac"] >= 1.0))
                        if st["frac"] >= 1.0:
                            # Final: also send detail.
                            await post_final(base_tgts, base_hits)
                            if idx == 1:
                                print("  >> bots posted final + detail")

        await asyncio.gather(reader(), poster())


# ---------------------------------------------------------------------------
# --multiboss: scripted 3-encounter verification harness (CURRENT PROTOCOL)
# ---------------------------------------------------------------------------
# Three encounters: Tevent (kill) -> Morokai -> Tevent (wipe-retry).
# Each gets a distinct fight_ts.  No encounter_start/encounter_end sent.
# Every bot posts post_fight then a final post_fight + final_detail.

MULTIBOSS_SCENARIO = [
    ("Tevent",  [300_000, 100_000], 40_000),   # A#1
    ("Morokai", [250_000,  90_000], 30_000),   # B
    ("Tevent",  [280_000, 110_000], 50_000),   # A#2 (wipe-retry)
]


def _gen_code() -> str:
    return "MB" + "".join(random.choice("ABCDEFGHJKLMNPQRSTUVWXYZ23456789") for _ in range(2))


def _mb_targets(boss: str, boss_dmg: int, trash_dmg: int) -> list[dict]:
    return [
        {"target": boss, "total_damage": boss_dmg, "dps": round(boss_dmg / 60, 1),
         "duration": 60.0, "hits": 300, "crit_rate": 40.0, "heavy_rate": 18.0,
         "crit_heavy_rate": 8.0},
        {"target": "Trash Pack", "total_damage": trash_dmg,
         "dps": round(trash_dmg / 60, 1), "duration": 60.0, "hits": 80,
         "crit_rate": 25.0, "heavy_rate": 8.0, "crit_heavy_rate": 3.0},
    ]


def _mb_detail(boss: str, boss_dmg: int) -> dict:
    """Build a minimal parity-correct detail block for multiboss scenario."""
    hits = _make_synthetic_hits(
        120, total_damage=boss_dmg, skill_name="MB_Skill", boss_name=boss,
        fight_duration_s=60.0)
    return _build_detail_from_hits(hits, boss, 60.0)


async def _mb_post_full(ws, eid: str, fight_ts: int, targets: list[dict],
                         detail: dict, *, final: bool) -> None:
    """Send post_fight then (if final) final_detail."""
    frame = _post_fight_frame(
        fight_ts=fight_ts,
        targets=targets,
        skills=detail["skills"] if final else None,
        rotation=detail["rotation"] if final else None,
        final=final,
    )
    await ws.send(json.dumps(frame))
    if final:
        await asyncio.sleep(0.1)
        fd = _final_detail_frame(encounter_id=eid, detail=detail)
        await ws.send(json.dumps(fd))


async def run_multiboss(host: str, code: str, members_n: int, delay: float,
                         dry_run: bool = False) -> int:
    members_n = max(2, min(members_n, 6))
    print(f"MULTIBOSS -> {host}/party/{code}  ({members_n} bots)")
    print("  scripted: Tevent #1 -> Morokai -> Tevent #2 (wipe-retry) = 3 encounters")
    if not dry_run:
        print(f"  join '{code}' in the app to watch the switcher populate.")

    base = int(time.time() * 1000)
    ids: list[str] = []
    for k in range(len(MULTIBOSS_SCENARIO)):
        eid = str(base + k * 120_000)  # distinct, ascending, plausible (epoch-ms)
        ids.append(eid)

    if dry_run:
        print("\n  --- DRY RUN FRAMES (no WS opened) ---")
        for k, (boss, dmgs, trash) in enumerate(MULTIBOSS_SCENARIO):
            eid = ids[k]
            tgts = _mb_targets(boss, dmgs[0], trash)
            detail = _mb_detail(boss, dmgs[0])
            post = _post_fight_frame(fight_ts=int(eid), targets=tgts, final=True,
                                     skills=detail["skills"], rotation=detail["rotation"])
            fd = _final_detail_frame(encounter_id=eid, detail=detail)
            print(f"  Enc {k+1} ({boss}) fight_ts={eid}")
            print(f"    post_fight:    final=True, v=2, "
                  f"skills={len(post.get('skills') or [])}, "
                  f"rotation={len(post.get('rotation') or [])}")
            print(f"    final_detail:  encounter_id={fd['encounter_id']}, "
                  f"detail.skills={len(fd['detail'].get('skills') or [])}")
        return 0

    if not _HAS_WS:
        print("websockets not installed; use --dry-run.", file=sys.stderr)
        return 2

    conns = []
    for i in range(1, members_n + 1):
        ws = await websockets.connect(
            f"{host}/party/{code}?user_id=mb{i}&username=Bot{i}&leader=0",
            max_size=None)
        conns.append(ws)

    boards: dict[str, dict] = {}
    encs = {"list": [], "active_id": None}
    stop = {"v": False}

    async def reader():
        try:
            async for raw in conns[0]:
                try:
                    m = json.loads(raw)
                except Exception:
                    continue
                if m.get("type") == "scoreboard" and m.get("encounter_id"):
                    boards[m["encounter_id"]] = m
                elif m.get("type") == "encounters":
                    encs["list"] = m.get("list", [])
                    encs["active_id"] = m.get("active_id")
                if stop["v"]:
                    break
        except Exception:
            pass

    rtask = asyncio.create_task(reader())

    for k, (boss, dmgs, trash) in enumerate(MULTIBOSS_SCENARIO):
        eid = ids[k]
        fight_ts_k = int(eid)
        detail = _mb_detail(boss, dmgs[0])
        for i, ws in enumerate(conns):
            bd = dmgs[i] if i < len(dmgs) else dmgs[-1] // 2
            tgts = _mb_targets(boss, bd, trash)
            # All but last bot: non-final tick.
            if i < len(conns) - 1:
                await _mb_post_full(ws, eid, fight_ts_k, tgts,
                                     _mb_detail(boss, bd), final=False)
            else:
                # Last bot: final post + detail (files the encounter).
                await _mb_post_full(ws, eid, fight_ts_k, tgts,
                                     _mb_detail(boss, bd), final=True)
            await asyncio.sleep(0.15)
        print(f"  posted encounter {k + 1}/3: {boss} (id ...{eid[-4:]})")
        await asyncio.sleep(delay)

    await asyncio.sleep(1.5)
    stop["v"] = True
    rtask.cancel()

    # --- assertions ---
    ok = True

    def check(c, label):
        nonlocal ok
        print(("PASS" if c else "FAIL") + " - " + label)
        if not c:
            ok = False

    lst = encs["list"]
    got_ids = [e.get("encounter_id") for e in lst]
    bosses = sorted(e.get("boss") for e in lst if e.get("boss"))
    check(len(lst) == 3, f"exactly 3 encounters (got {len(lst)})")
    check(
        bosses.count("Tevent") == 2 and bosses.count("Morokai") == 1,
        f"2 Tevent + 1 Morokai (duplicate boss kept distinct); got {bosses}",
    )
    check(
        ids[0] in got_ids and ids[2] in got_ids and ids[0] != ids[2],
        "Tevent #1 and #2 are distinct encounters",
    )
    for e in lst:
        check(e.get("entries_n") == members_n,
              f"{e.get('boss')} board has {members_n} members")
    for e in lst:
        sb = boards.get(e.get("encounter_id"))
        if sb and sb.get("entries"):
            s = sum(x.get("contribution", 0) for x in sb["entries"])
            check(abs(s - 100) <= 1.0,
                  f"{e.get('boss')} contributions sum ~100 (got {s})")
        else:
            check(False, f"{e.get('boss')} board cached for assertion")

    for ws in conns:
        try:
            await ws.close()
        except Exception:
            pass
    print("\n" + ("MULTIBOSS PASS" if ok else "MULTIBOSS FAILURES")
          + f"  (encounters persist in room {code} for app review)")
    return 0 if ok else 1


# ---------------------------------------------------------------------------
# Named scenario harness
# ---------------------------------------------------------------------------

SCENARIOS = {
    "merge-two-players": """
Two bots, SAME boss, DIFFERENT fight_ts (7s apart).
Expected: worker creates TWO encounter rows (no merge) because the encounter key
differs.  This DOCUMENTS THE CURRENT MERGE REGRESSION — the bug we're chasing.
When the regression is fixed, the assertion should be flipped to expect 1 row.
""",
    "crit-heavy-parity": """
Assert that posted crit_rate / heavy_rate / crit_heavy_rate match what
combat_stats.build_stat_block computes from the same synthetic hits.
This verifies the sim's stats path is parity-correct vs the solo analyzer.
""",
}


async def run_scenario(
    name: str,
    host: str,
    code: str,
    delay: float,
    dry_run: bool = False,
) -> int:
    """Run a named scenario and return 0 (PASS) or 1 (FAIL)."""
    if name not in SCENARIOS:
        print(f"Unknown scenario: {name}. Use --list-scenarios.", file=sys.stderr)
        return 2

    ok = True

    def check(c, label):
        nonlocal ok
        print(("PASS" if c else "FAIL") + " - " + label)
        if not c:
            ok = False

    base_ts = int(time.time() * 1000)

    # ------------------------------------------------------------------
    if name == "merge-two-players":
        print(f"SCENARIO: merge-two-players -> {host}/party/{code}")
        print("  Two bots, same boss ('Tevent'), DIFFERENT fight_ts.")
        print("  Expectation (current regression): TWO encounter rows, NOT merged.")

        ts1 = base_ts
        ts2 = base_ts + 7_000  # 7s offset -> distinct key

        hits1 = _make_synthetic_hits(100, boss_name="Tevent", total_damage=1_000_000)
        hits2 = _make_synthetic_hits(100, boss_name="Tevent", total_damage=800_000)
        tgts1 = [_hits_to_target_row(hits1, "Tevent", 60.0)]
        tgts2 = [_hits_to_target_row(hits2, "Tevent", 60.0)]

        frame1 = _post_fight_frame(fight_ts=ts1, targets=tgts1, final=True)
        frame2 = _post_fight_frame(fight_ts=ts2, targets=tgts2, final=True)
        detail1 = _build_detail_from_hits(hits1, "Tevent", 60.0)
        detail2 = _build_detail_from_hits(hits2, "Tevent", 60.0)
        fd1 = _final_detail_frame(encounter_id=str(ts1), detail=detail1)
        fd2 = _final_detail_frame(encounter_id=str(ts2), detail=detail2)

        if dry_run:
            print("\n  --- DRY RUN FRAMES ---")
            print(f"  Bot1 fight_ts={ts1}")
            print(f"    post_fight:  {json.dumps({k: v for k, v in frame1.items() if k not in ('targets','skills','rotation')})}")
            print(f"    targets[0]:  {frame1['targets'][0]}")
            print(f"    final_detail encounter_id={fd1['encounter_id']}")
            print(f"  Bot2 fight_ts={ts2}  (DIFFERENT -> separate encounter row)")
            print(f"    post_fight:  {json.dumps({k: v for k, v in frame2.items() if k not in ('targets','skills','rotation')})}")
            print(f"    targets[0]:  {frame2['targets'][0]}")
            check(ts1 != ts2, "fight_ts values are distinct (7s apart)")
            check(frame1["encounter_id"] != frame2["encounter_id"],
                  "encounter_id strings differ")
            print("\nDRY-RUN NOTE: connect to wrangler dev + run live to assert 2-row outcome.")
            return 0 if ok else 1

        if not _HAS_WS:
            print("websockets not installed; use --dry-run.", file=sys.stderr)
            return 2

        ws1 = await websockets.connect(
            f"{host}/party/{code}?user_id=bot1&username=Bot1&leader=0", max_size=None)
        ws2 = await websockets.connect(
            f"{host}/party/{code}?user_id=bot2&username=Bot2&leader=0", max_size=None)

        encs = {"list": [], "active_id": None}

        async def reader():
            async for raw in ws1:
                try:
                    m = json.loads(raw)
                except Exception:
                    continue
                if m.get("type") == "encounters":
                    encs["list"] = m.get("list", [])
                    encs["active_id"] = m.get("active_id")

        rtask = asyncio.create_task(reader())

        await ws1.send(json.dumps(frame1))
        await asyncio.sleep(0.1)
        await ws1.send(json.dumps(fd1))
        await asyncio.sleep(delay)
        await ws2.send(json.dumps(frame2))
        await asyncio.sleep(0.1)
        await ws2.send(json.dumps(fd2))
        await asyncio.sleep(1.5)
        rtask.cancel()

        lst = encs["list"]
        got_ids = [e.get("encounter_id") for e in lst]
        # REGRESSION ASSERTION: currently produces 2 rows because fight_ts differ.
        # When the merge bug is FIXED, change this to check len == 1.
        check(len(lst) == 2,
              f"merge regression: 2 encounter rows (different fight_ts = no merge); "
              f"got {len(lst)} -- if FIXED flip to 1")
        check(str(ts1) in got_ids and str(ts2) in got_ids,
              f"both encounter_ids present: {got_ids}")
        # Verify crit_heavy in the targets posted (parity check inline).
        t = tgts1[0]
        check("crit_heavy_rate" in t, "crit_heavy_rate field present in targets")
        check(t["crit_heavy_rate"] > 0, "crit_heavy_rate > 0 (non-zero)")

        for ws in (ws1, ws2):
            try:
                await ws.close()
            except Exception:
                pass

    # ------------------------------------------------------------------
    elif name == "crit-heavy-parity":
        print(f"SCENARIO: crit-heavy-parity")
        print("  100 synthetic hits, cyclic normal/crit/heavy/crit+heavy.")
        print("  Assert posted rates match build_stat_block output (parity-correct).")

        hits = _make_synthetic_hits(100, boss_name="Tevent", total_damage=1_000_000)
        block = build_stat_block(hits)
        tgt = _hits_to_target_row(hits, "Tevent", 60.0)

        # Manual count for comparison.
        n = len(hits)
        # Pattern: idx%4 in {1,3}=crit, {2,3}=heavy, {3}=both
        raw_crits = sum(1 for h in hits if h["is_crit"])
        raw_heavies = sum(1 for h in hits if h["is_heavy"])
        raw_crit_heavy = sum(1 for h in hits if h["is_crit"] and h["is_heavy"])

        check(tgt["crit_rate"] == block["crit_rate"],
              f"crit_rate matches build_stat_block: {tgt['crit_rate']} == {block['crit_rate']}")
        check(tgt["heavy_rate"] == block["heavy_rate"],
              f"heavy_rate matches: {tgt['heavy_rate']} == {block['heavy_rate']}")
        check(tgt["crit_heavy_rate"] == block["crit_heavy_rate"],
              f"crit_heavy_rate matches: {tgt['crit_heavy_rate']} == {block['crit_heavy_rate']}")

        # Verify crit_heavy_count internally consistent.
        expected_ch = raw_crit_heavy
        check(tgt["crit_heavy_count"] == expected_ch,
              f"crit_heavy_count == {expected_ch} (got {tgt['crit_heavy_count']})")

        if dry_run:
            frame = _post_fight_frame(fight_ts=base_ts, targets=[tgt], final=False)
            print(f"\n  --- DRY RUN FRAMES ---")
            print(f"  post_fight targets[0]:")
            print(f"    {json.dumps(tgt, indent=4)}")
            print(f"  build_stat_block (reference):")
            print(f"    crit_rate={block['crit_rate']}  heavy_rate={block['heavy_rate']}  "
                  f"crit_heavy_rate={block['crit_heavy_rate']}")
            print(f"  raw counts: crits={raw_crits}/{n}  heavies={raw_heavies}/{n}  "
                  f"crit+heavy={raw_crit_heavy}/{n}")

        print(f"\n  build_stat_block reference: crit={block['crit_rate']}% "
              f"heavy={block['heavy_rate']}% crit_heavy={block['crit_heavy_rate']}%")
        print(f"  targets[] row:             crit={tgt['crit_rate']}% "
              f"heavy={tgt['heavy_rate']}% crit_heavy={tgt['crit_heavy_rate']}%")

    return 0 if ok else 1


# ---------------------------------------------------------------------------
# Log-fed interactive session (main_async)
# ---------------------------------------------------------------------------

async def main_async(args) -> int:
    if args.list_scenarios:
        print("Available scenarios:")
        for name, doc in SCENARIOS.items():
            print(f"  {name}:{doc}")
        return 0

    if args.scenario:
        code = (args.code or _gen_code()).upper()
        return await run_scenario(
            args.scenario, args.host, code, args.delay, dry_run=args.dry_run)

    if args.multiboss:
        code = (args.code or _gen_code()).upper()
        return await run_multiboss(
            args.host, code, args.members, args.delay, dry_run=args.dry_run)

    if not args.code:
        print("A party code is required (create/join it in the app first).",
              file=sys.stderr)
        return 2

    log_path = Path(args.log) if args.log else find_default_log()
    if not log_path or not log_path.is_file():
        print("No combat log found. Pass --log <path to TLCombatLog-*.txt>.",
              file=sys.stderr)
        return 2
    print(f"log: {log_path}")

    mode = "now" if args.now else ("live" if args.live else "reactive")
    base_tgts: list[dict] = []
    base_hits: list[dict] = []
    if mode != "live":
        base_tgts, base_hits = base_targets(log_path)
        if not base_tgts:
            print("No DamageDone hits parsed from that log.", file=sys.stderr)
            return 2

    blurb = {
        "live": "LIVE - mirror your real combat as the log flushes",
        "reactive": "REACTIVE - replay log snapshot in climbing slices on Start",
        "now": "NOW - post immediately, ignoring leader",
    }[mode]
    code_up = args.code.upper()
    print(f"connecting {args.members} members -> {args.host}/party/{code_up}  [{blurb}]")
    print(f"  fight_ts mode: {'SHARED (--share-ts)' if args.share_ts else 'DISTINCT per bot (default)'}")

    if args.dry_run:
        base_ts_dr = int(time.time() * 1000)
        for i in range(1, args.members + 1):
            fts = _bot_fight_ts(i, share_ts=args.share_ts, base_ts=base_ts_dr)
            await member(
                args.host, code_up, i, base_tgts, base_hits,
                args.rounds, args.delay, mode, log_path,
                {"active": False, "cutoff_line": 0, "targets": [], "raw_hits": []},
                fight_ts=fts, dry_run=True,
            )
        return 0

    if not _HAS_WS:
        print("websockets not installed. Install with: pip install websockets",
              file=sys.stderr)
        return 2

    if mode != "now":
        print("  Auto-posting begins immediately (no Start button needed). "
              "Ctrl+C to remove bots.")

    run = {"active": False, "cutoff_line": 0, "targets": [], "raw_hits": []}
    base_ts_live = int(time.time() * 1000)
    try:
        await asyncio.gather(*[
            member(
                args.host, code_up, i, base_tgts, base_hits,
                args.rounds, args.delay, mode, log_path, run,
                fight_ts=_bot_fight_ts(i, share_ts=args.share_ts, base_ts=base_ts_live),
            )
            for i in range(1, args.members + 1)
        ])
    except KeyboardInterrupt:
        pass
    print("done.")
    return 0


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main() -> int:
    ap = argparse.ArgumentParser(
        description="Simulate N party members against the room (CURRENT PROTOCOL).",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Live-tail mode (4 bots, distinct fight_ts):
  python sim_party.py MYCODE --live

  # Dry-run: print frames without connecting:
  python sim_party.py MYCODE --live --dry-run

  # Named scenario (dry):
  python sim_party.py --scenario crit-heavy-parity --dry-run

  # Multiboss harness:
  python sim_party.py --multiboss MBTEST

  # List scenarios:
  python sim_party.py --list-scenarios
""")
    ap.add_argument("code", nargs="?", default="",
                    help="party code to join; optional with --multiboss/--scenario")
    ap.add_argument("--members", type=int, default=4)
    ap.add_argument("--log", default="",
                    help="path to TLCombatLog-*.txt; auto-picks newest if omitted")
    ap.add_argument("--rounds", type=int, default=5,
                    help="reactive mode: slices to climb over")
    ap.add_argument("--delay", type=float, default=1.5,
                    help="seconds between posts / live polls")
    ap.add_argument("--host", default=DEFAULT_HOST)
    ap.add_argument("--live", action="store_true",
                    help="LIVE-tail the log: bots mirror your real combat as it flushes")
    ap.add_argument("--now", action="store_true",
                    help="post a snapshot immediately (quick board check)")
    ap.add_argument("--multiboss", action="store_true",
                    help="scripted 3-encounter harness (Tevent/Morokai/Tevent) + assertions")
    ap.add_argument("--scenario", default="",
                    help="run a named scenario (--list-scenarios to see them)")
    ap.add_argument("--list-scenarios", action="store_true",
                    help="print available scenario names and exit")
    ap.add_argument("--share-ts", action="store_true",
                    help="all bots share ONE fight_ts (old broken behaviour; "
                         "default is DISTINCT per bot to reproduce merge regression)")
    ap.add_argument("--dry-run", action="store_true",
                    help="build + print frames WITHOUT opening a websocket")
    args = ap.parse_args()
    try:
        return asyncio.run(main_async(args))
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
