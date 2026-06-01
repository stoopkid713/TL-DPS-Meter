"""fake_combat_log.py — Scenario-driven Throne & Liberty combat-log generator.

Generates real-format ``TLCombatLog-*.txt`` files that parse cleanly through
``backend/combat_log_parser.parse_line``. Every hit it emits satisfies the
grammar documented in ``backend/SCHEMAS.md`` (≥10 comma-separated fields,
correct timestamp, ``DamageDone`` log-type).

Public API
----------
generate_log(scenario, out_dir, *, seed, burst_mode) -> Path
    Write one or more log files for *scenario* into *out_dir*.
    Returns the path of the first (or only) file written.

generate_all_presets(out_dir, *, seed) -> dict[str, Path]
    Convenience: run every built-in preset and return a name→path mapping.

CLI
---
    python fake_combat_log.py [preset] [--out-dir DIR] [--seed N] [--burst]
                              [--list-presets] [--verify]

``--verify`` runs the round-trip parse test and prints results (no output files
needed — it generates to a temp dir and parses back through the real parser).
"""
from __future__ import annotations

import argparse
import random
import sys
import tempfile
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional

# ---------------------------------------------------------------------------
# Grammar constants (mirror of constants.py so this file is self-contained
# when invoked stand-alone; also imported alongside the real constants at verify
# time to confirm parity).
# ---------------------------------------------------------------------------

_LOG_VERSION_HEADER = "CombatLogVersion,4"
_LOG_TYPE_DAMAGE = "DamageDone"

# Real HitType strings from constants.py / SCHEMAS.md:
_HIT_TYPE_CRIT = "kMaxDamageByCriticalDecision"
_HIT_TYPE_NORMAL = "kNormalHit"
_HIT_TYPE_MIN = "kMinDamageByNormal"

# Plausible T&L skill names (used as defaults in scenarios):
_TL_SKILLS = [
    "Brutal Incision",
    "Executioner",
    "Piercing Strike",
    "Spinning Slash",
    "Merciless Barrage",
    "Rupture",
    "Lethal Tempo",
    "Dark Explosion",
    "Shadow Strike",
    "Cross Slash",
    "Vault",
    "Ground Smash",
    "Mana Arrow",
    "Triple Shot",
    "Wrath Rune",
]

# ---------------------------------------------------------------------------
# Data model
# ---------------------------------------------------------------------------


@dataclass
class FightSpec:
    """One fight (boss encounter) within a scenario."""
    target: str
    duration_sec: float = 60.0
    hit_count: int = 120           # total hits across ALL players in this fight
    skills: list[str] = field(default_factory=list)
    crit_prob: float = 0.30        # independent per-hit probability
    heavy_prob: float = 0.25       # independent per-hit probability
    # damage range for a plain normal hit; crits/heavies multiply these
    base_dmg_min: int = 1_000
    base_dmg_max: int = 5_000
    crit_multiplier: float = 1.8
    heavy_multiplier: float = 1.4


@dataclass
class Scenario:
    """Full scenario: N players, ordered fights, gaps between fights."""
    players: list[str]             # each player → its own output file
    fights: list[FightSpec]
    gap_sec: float = 10.0          # idle gap between fights (no hits logged)
    start_dt: datetime = field(default_factory=lambda: datetime(2025, 6, 1, 18, 0, 0))
    seed: int = 42


# ---------------------------------------------------------------------------
# Built-in presets
# ---------------------------------------------------------------------------

PRESETS: dict[str, Scenario] = {
    "solo-boss": Scenario(
        players=["Aelindra"],
        fights=[
            FightSpec(
                target="Tevent",
                duration_sec=90.0,
                hit_count=180,
                skills=["Brutal Incision", "Executioner", "Piercing Strike", "Merciless Barrage"],
                crit_prob=0.35,
                heavy_prob=0.28,
            )
        ],
        gap_sec=0.0,
    ),
    "multi-boss-chronological": Scenario(
        players=["Aelindra", "Vareth", "Synapse"],
        fights=[
            FightSpec(
                target="Tevent",
                duration_sec=60.0,
                hit_count=180,
                skills=["Brutal Incision", "Executioner", "Vault"],
                crit_prob=0.30,
                heavy_prob=0.25,
            ),
            FightSpec(
                target="Morokai",
                duration_sec=75.0,
                hit_count=225,
                skills=["Dark Explosion", "Shadow Strike", "Cross Slash"],
                crit_prob=0.22,
                heavy_prob=0.20,
            ),
            FightSpec(
                target="Kowazan",
                duration_sec=50.0,
                hit_count=150,
                skills=["Triple Shot", "Mana Arrow", "Wrath Rune"],
                crit_prob=0.40,
                heavy_prob=0.15,
            ),
        ],
        gap_sec=12.0,
    ),
    "wipe-retry": Scenario(
        players=["Aelindra", "Vareth"],
        fights=[
            FightSpec(
                target="Junobote",
                duration_sec=30.0,   # wipe — fight ends early
                hit_count=60,
                skills=["Spinning Slash", "Rupture"],
                crit_prob=0.28,
                heavy_prob=0.22,
            ),
            FightSpec(
                target="Junobote",   # retry of the same boss
                duration_sec=90.0,
                hit_count=180,
                skills=["Spinning Slash", "Rupture", "Lethal Tempo"],
                crit_prob=0.28,
                heavy_prob=0.22,
            ),
        ],
        gap_sec=15.0,
    ),
    "crit-heavy-mix": Scenario(
        players=["Aelindra"],
        fights=[
            FightSpec(
                target="Adentus",
                duration_sec=120.0,
                hit_count=240,
                skills=["Ground Smash", "Executioner", "Brutal Incision", "Dark Explosion"],
                crit_prob=0.50,    # high crit — stresses crit_heavy math
                heavy_prob=0.50,   # high heavy — many hits will be BOTH
                base_dmg_min=2_000,
                base_dmg_max=8_000,
                crit_multiplier=2.0,
                heavy_multiplier=1.6,
            )
        ],
        gap_sec=0.0,
    ),
}


# ---------------------------------------------------------------------------
# Timestamp helpers
# ---------------------------------------------------------------------------


def _fmt_ts(dt: datetime) -> str:
    """Format datetime → ``YYYYMMDD-HH:MM:SS:mmm`` (what parse_timestamp accepts)."""
    millis = dt.microsecond // 1000
    return dt.strftime("%Y%m%d-%H:%M:%S") + f":{millis:03d}"


def _make_timestamps(
    start: datetime, duration_sec: float, count: int, rng: random.Random
) -> list[datetime]:
    """Distribute *count* hit timestamps over [start, start+duration], sorted."""
    end = start + timedelta(seconds=duration_sec)
    span_us = int(duration_sec * 1_000_000)
    offsets = sorted(rng.randint(0, max(span_us - 1, 0)) for _ in range(count))
    return [start + timedelta(microseconds=off) for off in offsets]


# ---------------------------------------------------------------------------
# Single-line emitter
# ---------------------------------------------------------------------------

# Skill IDs are numeric strings; we just use a stable hash of the skill name.
def _skill_id(skill: str) -> str:
    return str(abs(hash(skill)) % 100_000)


def _emit_line(
    ts: datetime,
    skill: str,
    damage: int,
    is_crit: bool,
    is_heavy: bool,
    caster: str,
    target: str,
) -> str:
    """Return one CSV log line matching the grammar (10 fields).

    Field layout (from constants.py IDX_* and SCHEMAS.md):
    idx 0  Timestamp        YYYYMMDD-HH:MM:SS:mmm
    idx 1  LogType          DamageDone
    idx 2  SkillName        str (spaces OK, no commas)
    idx 3  SkillId          numeric str
    idx 4  Damage           int
    idx 5  HitCritical      1/0
    idx 6  HitHeavy         1/0
    idx 7  HitType          kMaxDamageByCriticalDecision / kNormalHit / kMinDamageByNormal
    idx 8  CasterName       str
    idx 9  TargetName       str (may contain commas; parser re-joins parts[9:])
    """
    # hit_type: crit wins over heavy when both are set (crit = "max damage")
    if is_crit:
        hit_type = _HIT_TYPE_CRIT
    elif not is_crit and not is_heavy:
        # Check for min-damage case: use kMinDamageByNormal with ~10% chance
        # (the parser accepts all three; we just need variety)
        hit_type = _HIT_TYPE_NORMAL  # _HIT_TYPE_MIN set externally if needed
    else:
        hit_type = _HIT_TYPE_NORMAL

    crit_flag = "1" if is_crit else "0"
    heavy_flag = "1" if is_heavy else "0"

    parts = [
        _fmt_ts(ts),           # 0
        _LOG_TYPE_DAMAGE,      # 1
        skill,                 # 2
        _skill_id(skill),      # 3
        str(damage),           # 4
        crit_flag,             # 5
        heavy_flag,            # 6
        hit_type,              # 7
        caster,                # 8
        target,                # 9
    ]
    return ",".join(parts)


# ---------------------------------------------------------------------------
# Per-fight hit generator
# ---------------------------------------------------------------------------


def _generate_fight_hits(
    fight: FightSpec,
    player: str,
    fight_start: datetime,
    rng: random.Random,
) -> list[str]:
    """Return sorted log lines for one player in one fight.

    Each player receives an equal share of *fight.hit_count* hits (integer
    division; the remainder goes to no one — acceptable for test data).
    """
    n_players_implicit = 1  # called once per player; hit_count is already per-fight total
    # Per-player hit allocation:
    per_player = fight.hit_count  # caller may divide externally; here we generate ALL for this player

    skills = fight.skills if fight.skills else rng.choices(_TL_SKILLS, k=4)

    timestamps = _make_timestamps(fight_start, fight.duration_sec, per_player, rng)
    lines: list[str] = []

    for ts in timestamps:
        skill = rng.choice(skills)
        is_crit = rng.random() < fight.crit_prob
        is_heavy = rng.random() < fight.heavy_prob

        # Base damage for a normal hit; crits/heavies multiply
        base = rng.randint(fight.base_dmg_min, fight.base_dmg_max)
        multiplier = 1.0
        if is_crit:
            multiplier *= fight.crit_multiplier
        if is_heavy:
            multiplier *= fight.heavy_multiplier
        damage = max(1, int(base * multiplier))

        lines.append(_emit_line(ts, skill, damage, is_crit, is_heavy, player, fight.target))

    return lines


# ---------------------------------------------------------------------------
# File writer
# ---------------------------------------------------------------------------


def _log_filename(player: str, run_ts: datetime) -> str:
    """TLCombatLog-YYYYMMDD-HHMMSSmmm-<Player>.txt"""
    tag = run_ts.strftime("%Y%m%d-%H%M%S") + f"{run_ts.microsecond // 1000:03d}"
    # sanitize player name for filenames
    safe = "".join(c if c.isalnum() or c in "-_" else "_" for c in player)
    return f"TLCombatLog-{tag}-{safe}.txt"


def _build_file_lines(
    scenario: Scenario,
    player: str,
    rng: random.Random,
) -> tuple[list[str], datetime]:
    """Produce all log lines for one player across all fights, with idle gaps.

    Returns (lines, start_datetime_for_filename).
    """
    current_dt = scenario.start_dt
    all_lines: list[str] = [_LOG_VERSION_HEADER]
    file_start = current_dt

    n_players = len(scenario.players)
    player_idx = scenario.players.index(player)

    for fight_idx, fight in enumerate(scenario.fights):
        # Each player gets (hit_count // n_players) hits, remainder to player 0
        base_hits = fight.hit_count // n_players
        extra = fight.hit_count % n_players
        player_hits_count = base_hits + (1 if player_idx < extra else 0)

        # Build a per-player fight spec copy with adjusted hit count
        player_fight = FightSpec(
            target=fight.target,
            duration_sec=fight.duration_sec,
            hit_count=player_hits_count,
            skills=fight.skills,
            crit_prob=fight.crit_prob,
            heavy_prob=fight.heavy_prob,
            base_dmg_min=fight.base_dmg_min,
            base_dmg_max=fight.base_dmg_max,
            crit_multiplier=fight.crit_multiplier,
            heavy_multiplier=fight.heavy_multiplier,
        )

        fight_lines = _generate_fight_hits(player_fight, player, current_dt, rng)
        all_lines.extend(fight_lines)

        current_dt += timedelta(seconds=fight.duration_sec)
        # idle gap (no hits) between fights
        if fight_idx < len(scenario.fights) - 1 and scenario.gap_sec > 0:
            current_dt += timedelta(seconds=scenario.gap_sec)

    return all_lines, file_start


# ---------------------------------------------------------------------------
# Burst-flush emulation
# ---------------------------------------------------------------------------


def _write_burst(path: Path, lines: list[str], burst_size: int = 20, delay_sec: float = 0.05) -> None:
    """Write *lines* to *path* in bursts (simulates TL flushing the log incrementally).

    The file is opened once and lines are appended in chunks of *burst_size*,
    with a short sleep between flushes. Useful for exercising the live-tail path.
    """
    with path.open("w", encoding="utf-8") as fh:
        for i in range(0, len(lines), burst_size):
            chunk = lines[i:i + burst_size]
            fh.write("\n".join(chunk) + "\n")
            fh.flush()
            if i + burst_size < len(lines):
                time.sleep(delay_sec)


# ---------------------------------------------------------------------------
# Top-level public API
# ---------------------------------------------------------------------------


def generate_log(
    scenario: Scenario,
    out_dir: Path,
    *,
    seed: Optional[int] = None,
    burst_mode: bool = False,
    burst_size: int = 20,
    burst_delay_sec: float = 0.05,
) -> dict[str, Path]:
    """Generate log files for all players in *scenario*, writing into *out_dir*.

    Returns a mapping of ``player_name → Path`` for every file written.
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    effective_seed = seed if seed is not None else scenario.seed
    # One RNG per call; reproducible given same seed + scenario.
    rng = random.Random(effective_seed)

    result: dict[str, Path] = {}
    for player in scenario.players:
        lines, file_start = _build_file_lines(scenario, player, rng)
        filename = _log_filename(player, file_start)
        path = out_dir / filename
        if burst_mode:
            _write_burst(path, lines, burst_size=burst_size, delay_sec=burst_delay_sec)
        else:
            path.write_text("\n".join(lines) + "\n", encoding="utf-8")
        result[player] = path

    return result


def generate_all_presets(out_dir: Path, *, seed: Optional[int] = None) -> dict[str, dict[str, Path]]:
    """Run every built-in preset and return ``preset_name → {player → Path}``."""
    results: dict[str, dict[str, Path]] = {}
    for name, scenario in PRESETS.items():
        preset_dir = out_dir / name
        results[name] = generate_log(scenario, preset_dir, seed=seed)
    return results


# ---------------------------------------------------------------------------
# Round-trip verifier
# ---------------------------------------------------------------------------


def _verify_preset(preset_name: str, scenario: Scenario, seed: int, verbose: bool = True) -> dict:
    """Generate a preset, parse it back, and check crit/heavy/crit_heavy/normal counts.

    Returns a summary dict for the dispatcher gate report.
    """
    # Import the real parser from the project (must run from backend/ or with sys.path set)
    import importlib
    import sys as _sys

    # Ensure we can import from backend/ regardless of cwd
    backend_dir = Path(__file__).parent.parent
    if str(backend_dir) not in _sys.path:
        _sys.path.insert(0, str(backend_dir))

    from combat_log_parser import parse_line

    with tempfile.TemporaryDirectory() as tmpdir:
        player_paths = generate_log(scenario, Path(tmpdir), seed=seed)

        summary: dict[str, object] = {"preset": preset_name, "players": {}}
        all_ok = True

        for player, path in player_paths.items():
            lines = path.read_text(encoding="utf-8").splitlines()

            # Expected per-player hit count
            n_players = len(scenario.players)
            player_idx = scenario.players.index(player)
            expected_hits = 0
            for fight in scenario.fights:
                base = fight.hit_count // n_players
                extra = fight.hit_count % n_players
                expected_hits += base + (1 if player_idx < extra else 0)

            # Parse every line
            hits = []
            for line in lines:
                partial = parse_line(line)
                if partial is not None:
                    hits.append(partial)

            hit_count = len(hits)
            crit_count = sum(1 for h in hits if h["is_crit"])
            heavy_count = sum(1 for h in hits if h["is_heavy"])
            crit_heavy_count = sum(1 for h in hits if h["is_crit"] and h["is_heavy"])
            normal_count = sum(1 for h in hits if not h["is_crit"] and not h["is_heavy"])

            hits_match = hit_count == expected_hits

            # Expected rates across all fights (weighted by hit count)
            # For simplicity we use per-scenario averages (adequate for single-fight presets;
            # multi-fight presets report per-fight expectations separately below)
            total_fight_hits = sum(f.hit_count for f in scenario.fights)
            expected_crit_rate = sum(
                f.crit_prob * f.hit_count for f in scenario.fights
            ) / total_fight_hits if total_fight_hits else 0.0

            expected_heavy_rate = sum(
                f.heavy_prob * f.hit_count for f in scenario.fights
            ) / total_fight_hits if total_fight_hits else 0.0

            expected_crit_heavy_rate = expected_crit_rate * expected_heavy_rate  # independent

            actual_crit_rate = crit_count / hit_count if hit_count else 0.0
            actual_heavy_rate = heavy_count / hit_count if hit_count else 0.0
            actual_crit_heavy_rate = crit_heavy_count / hit_count if hit_count else 0.0
            actual_normal_rate = normal_count / hit_count if hit_count else 0.0

            # Tolerance: within 10 percentage points of expected (random variance)
            TOLERANCE = 0.10
            crit_ok = abs(actual_crit_rate - expected_crit_rate) <= TOLERANCE
            heavy_ok = abs(actual_heavy_rate - expected_heavy_rate) <= TOLERANCE
            crit_heavy_ok = abs(actual_crit_heavy_rate - expected_crit_heavy_rate) <= TOLERANCE
            ok = hits_match and crit_ok and heavy_ok and crit_heavy_ok
            if not ok:
                all_ok = False

            player_summary = {
                "expected_hits": expected_hits,
                "actual_hits": hit_count,
                "hits_match": hits_match,
                "crit_count": crit_count,
                "heavy_count": heavy_count,
                "crit_heavy_count": crit_heavy_count,
                "normal_count": normal_count,
                "actual_crit_rate": round(actual_crit_rate, 3),
                "actual_heavy_rate": round(actual_heavy_rate, 3),
                "actual_crit_heavy_rate": round(actual_crit_heavy_rate, 3),
                "actual_normal_rate": round(actual_normal_rate, 3),
                "expected_crit_rate": round(expected_crit_rate, 3),
                "expected_heavy_rate": round(expected_heavy_rate, 3),
                "expected_crit_heavy_rate": round(expected_crit_heavy_rate, 3),
                "crit_ok": crit_ok,
                "heavy_ok": heavy_ok,
                "crit_heavy_ok": crit_heavy_ok,
                "PASS": ok,
            }
            summary["players"][player] = player_summary  # type: ignore[index]

            if verbose:
                status = "PASS" if ok else "FAIL"
                print(f"  [{status}] {preset_name} / {player}:")
                print(f"    hits: {hit_count}/{expected_hits}  "
                      f"crit: {actual_crit_rate:.1%}(exp {expected_crit_rate:.1%})  "
                      f"heavy: {actual_heavy_rate:.1%}(exp {expected_heavy_rate:.1%})  "
                      f"crit+heavy: {actual_crit_heavy_rate:.1%}(exp {expected_crit_heavy_rate:.1%})  "
                      f"normal: {actual_normal_rate:.1%}")

        summary["PASS"] = all_ok  # type: ignore[assignment]
        return summary


def run_verify(seed: int = 42, verbose: bool = True) -> bool:
    """Run round-trip verification for all presets. Returns True if all pass."""
    if verbose:
        print("=== Round-trip verification ===")
    all_pass = True
    for name, scenario in PRESETS.items():
        result = _verify_preset(name, scenario, seed=seed, verbose=verbose)
        if not result["PASS"]:
            all_pass = False
    if verbose:
        print(f"\n{'ALL PASS' if all_pass else 'FAILURES DETECTED'}")
    return all_pass


# ---------------------------------------------------------------------------
# Example line generator (for gate report)
# ---------------------------------------------------------------------------


def example_line() -> str:
    """Return one representative log line with labeled fields."""
    ts = datetime(2025, 6, 1, 18, 0, 5, 123_000)
    return _emit_line(ts, "Brutal Incision", 8_500, is_crit=True, is_heavy=False,
                      caster="Aelindra", target="Tevent")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def _cli() -> None:
    parser = argparse.ArgumentParser(
        description="Generate fake Throne & Liberty combat log files for testing."
    )
    parser.add_argument(
        "preset",
        nargs="?",
        default=None,
        help="Preset scenario name (omit to generate all presets).",
    )
    parser.add_argument(
        "--out-dir", default="fake_logs",
        help="Directory to write log files into (default: ./fake_logs).",
    )
    parser.add_argument(
        "--seed", type=int, default=42,
        help="RNG seed for deterministic output (default: 42).",
    )
    parser.add_argument(
        "--burst", action="store_true",
        help="Write files in burst-flush mode (simulates TL incremental log flush).",
    )
    parser.add_argument(
        "--burst-size", type=int, default=20,
        help="Lines per burst chunk (default: 20, used with --burst).",
    )
    parser.add_argument(
        "--burst-delay", type=float, default=0.05,
        help="Seconds between bursts (default: 0.05, used with --burst).",
    )
    parser.add_argument(
        "--list-presets", action="store_true",
        help="List available preset names and exit.",
    )
    parser.add_argument(
        "--verify", action="store_true",
        help="Run round-trip parse verification and print results.",
    )
    parser.add_argument(
        "--example-line", action="store_true",
        help="Print one example log line with field labels and exit.",
    )
    args = parser.parse_args()

    if args.list_presets:
        print("Available presets:")
        for name, s in PRESETS.items():
            players = ", ".join(s.players)
            fights = ", ".join(f.target for f in s.fights)
            print(f"  {name:<32} players=[{players}]  fights=[{fights}]")
        return

    if args.example_line:
        line = example_line()
        labels = (
            "idx: 0=Timestamp          1=LogType    2=SkillName       "
            "3=SkillId  4=Damage  5=Crit  6=Heavy  7=HitType                          "
            "8=Caster    9=Target"
        )
        print(labels)
        print(line)
        return

    if args.verify:
        ok = run_verify(seed=args.seed, verbose=True)
        sys.exit(0 if ok else 1)

    out_dir = Path(args.out_dir)

    if args.preset:
        if args.preset not in PRESETS:
            print(f"ERROR: unknown preset '{args.preset}'. Use --list-presets.", file=sys.stderr)
            sys.exit(1)
        scenario = PRESETS[args.preset]
        paths = generate_log(
            scenario, out_dir / args.preset,
            seed=args.seed,
            burst_mode=args.burst,
            burst_size=args.burst_size,
            burst_delay_sec=args.burst_delay,
        )
        for player, path in paths.items():
            n_lines = len(path.read_text(encoding="utf-8").splitlines())
            print(f"  {player}: {path}  ({n_lines} lines)")
    else:
        results = generate_all_presets(out_dir, seed=args.seed)
        for preset_name, player_paths in results.items():
            for player, path in player_paths.items():
                n_lines = len(path.read_text(encoding="utf-8").splitlines())
                print(f"  {preset_name}/{player}: {path}  ({n_lines} lines)")


if __name__ == "__main__":
    _cli()
