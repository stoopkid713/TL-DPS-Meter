"""Pure, deterministic damage-stats aggregation core.

The single source of truth for parity is the old backend's output: feeding the
recorded ``rotation`` hits of an encounter back through these builders must
reproduce that encounter's stat block exactly (after the parity normalizer).
See ``tests/test_stats_parity.py`` and ``tools/compare_snapshots.py``.

A "hit" is a plain dict with these keys (produced by ``combat_log_parser``):
    time:str  relative_time:float  skill:str  target:str
    damage:int  is_crit:bool  is_heavy:bool  hit_type:str

Nothing here does I/O, holds wall-clock state, or imports the server — so it is
trivially unit-testable and safe to call from any thread.
"""
from __future__ import annotations

from typing import Any

from debug import trace

from constants import (
    GAP_DEAD_THRESHOLD,
    GAP_LIVE_LIST_THRESHOLD,
    GAP_MAJOR_THRESHOLD,
    ROUND_DEAD_TIME,
    ROUND_DPS,
    ROUND_DURATION,
    ROUND_GAP_DURATION,
    ROUND_RATE,
    ROUND_REL_TIME,
    SIXTY_SECOND_WINDOW,
    TOP_HITS_LIMIT,
)

Hit = dict[str, Any]


def _rate(numerator: int, hit_count: int) -> float:
    """Percentage of hits, 1 dp. 0.0 when there are no hits (no ZeroDivision)."""
    if not hit_count:
        return 0.0
    return round(numerator / hit_count * 100, ROUND_RATE)


def _skills(hits: list[Hit], total_damage: int) -> list[dict]:
    """Per-skill aggregates, sorted by total damage descending.

    Matches the old backend: skill names are aggregated then ordered by damage
    (disasm L6666: ``sorted(skill_damage.keys(), key=..., reverse=True)``).
    Insertion order (first-seen) is the stable tiebreak.
    """
    agg: dict[str, dict] = {}
    for h in hits:
        s = agg.get(h["skill"])
        if s is None:
            s = agg[h["skill"]] = {
                "name": h["skill"],
                "damage": 0,
                "hits": 0,
                "crits": 0,
                "heavies": 0,
                "crit_damage": 0,
                "heavy_damage": 0,
            }
        dmg = h["damage"]
        s["damage"] += dmg
        s["hits"] += 1
        if h["is_crit"]:
            s["crits"] += 1
            s["crit_damage"] += dmg
        if h["is_heavy"]:
            s["heavies"] += 1
            s["heavy_damage"] += dmg

    skills = list(agg.values())
    for s in skills:
        s["percent"] = round(s["damage"] / total_damage * 100, ROUND_RATE) if total_damage else 0.0
    skills.sort(key=lambda s: s["damage"], reverse=True)
    return skills


def _targets(hits: list[Hit], total_damage: int) -> list[dict]:
    """Per-target damage share, sorted by damage descending (overall block only)."""
    agg: dict[str, dict] = {}
    for h in hits:
        t = agg.get(h["target"])
        if t is None:
            t = agg[h["target"]] = {"name": h["target"], "damage": 0}
        t["damage"] += h["damage"]
    targets = list(agg.values())
    for t in targets:
        t["percent"] = round(t["damage"] / total_damage * 100, ROUND_RATE) if total_damage else 0.0
    targets.sort(key=lambda t: t["damage"], reverse=True)
    return targets


def _top_hits(hits: list[Hit]) -> list[dict]:
    """Top-N hits by damage, passed through verbatim (stable sort keeps order on ties)."""
    ordered = sorted(hits, key=lambda h: h["damage"], reverse=True)[:TOP_HITS_LIMIT]
    return [dict(h) for h in ordered]


def _gap_stats(hits: list[Hit]) -> dict:
    """Inter-hit timing analysis, reproducing the old backend's gap loop exactly.

    For every consecutive pair a gap record ``{after_index, duration, at_time}``
    is built (durations rounded to 2 dp). Derived fields:
      - total_dead_time:       sum of (gap - 1.0) over gaps longer than 1.0s, 1 dp
      - num_major_gaps:        count of gap records with duration > 2.0s
      - longest_gap:           max gap duration (0 when no gaps)
      - avg_time_between_hits: mean gap duration (0 when no gaps)
      - gaps:                  ONLY the major gap records (> 2.0s)  <- the rest are
                               folded into the aggregates, not emitted (disasm L12300-12480).
    """
    gaps: list[dict] = []
    total_gap_time = 0.0
    if len(hits) > 1:
        for i in range(1, len(hits)):
            prev_t = hits[i - 1].get("relative_time", 0)
            curr_t = hits[i].get("relative_time", 0)
            gap = curr_t - prev_t
            gaps.append(
                {
                    "after_index": i - 1,
                    "duration": round(gap, ROUND_GAP_DURATION),
                    "at_time": round(prev_t, 1),
                }
            )
            if gap > GAP_DEAD_THRESHOLD:
                total_gap_time += gap - GAP_DEAD_THRESHOLD

    major = [g for g in gaps if g["duration"] > GAP_MAJOR_THRESHOLD]
    longest = round(max((g["duration"] for g in gaps), default=0), ROUND_GAP_DURATION)
    avg = round(sum(g["duration"] for g in gaps) / len(gaps), ROUND_GAP_DURATION) if gaps else 0
    return {
        "total_dead_time": round(total_gap_time, ROUND_DEAD_TIME),
        "num_major_gaps": len(major),
        "longest_gap": longest,
        "avg_time_between_hits": avg,
        "gaps": major,
    }


def build_stat_block(
    hits: list[Hit],
    *,
    with_targets: bool = False,
    with_rotation: bool = False,
    with_gap_stats: bool = False,
) -> dict:
    """Build one stat block from a list of hits (the shared core of every view).

    ``duration`` is the span of the supplied hits (last - first relative_time);
    callers that need a fixed window must pre-slice the hits. ``dps`` is
    ``total_damage / duration`` (0 when duration is 0).
    """
    total_damage = sum(h["damage"] for h in hits)
    hit_count = len(hits)
    crit_count = sum(1 for h in hits if h["is_crit"])
    heavy_count = sum(1 for h in hits if h["is_heavy"])
    crit_heavy_count = sum(1 for h in hits if h["is_crit"] and h["is_heavy"])

    if hits:
        duration = round(hits[-1]["relative_time"] - hits[0]["relative_time"], ROUND_DURATION)
    else:
        duration = 0.0
    dps = round(total_damage / duration, ROUND_DPS) if duration > 0 else 0.0

    block: dict[str, Any] = {
        "dps": dps,
        "total_damage": total_damage,
        "duration": duration,
        "hit_count": hit_count,
        "crit_rate": _rate(crit_count, hit_count),
        "crit_damage": sum(h["damage"] for h in hits if h["is_crit"]),
        "heavy_rate": _rate(heavy_count, hit_count),
        "heavy_damage": sum(h["damage"] for h in hits if h["is_heavy"]),
        "crit_heavy_rate": _rate(crit_heavy_count, hit_count),
        "crit_heavy_damage": sum(h["damage"] for h in hits if h["is_crit"] and h["is_heavy"]),
        "skills": _skills(hits, total_damage),
        "top_hits": _top_hits(hits),
    }
    if with_targets:
        block["targets"] = _targets(hits, total_damage)
    if with_rotation:
        block["rotation"] = [dict(h) for h in hits]
    if with_gap_stats:
        block["gap_stats"] = _gap_stats(hits)
    return block


def build_overall_block(hits: list[Hit]) -> dict:
    """The encounter-wide block: includes per-target share, no rotation/gap_stats."""
    return build_stat_block(hits, with_targets=True)


def build_first_60s_block(hits: list[Hit]) -> dict:
    """The first-60-seconds block: includes rotation + gap_stats, no targets.

    The caller passes the already-windowed hits (relative_time <= 60.0); this
    matches the recorded ``first_60s.rotation`` the old backend persists.
    """
    return build_stat_block(hits, with_rotation=True, with_gap_stats=True)


def slice_first_60s(hits: list[Hit]) -> list[Hit]:
    """Hits within the first 60s window (boundary inclusive)."""
    return [h for h in hits if h["relative_time"] <= SIXTY_SECOND_WINDOW]


# ---------------------------------------------------------------------------
# LIVE broadcast serializer (Phase 3)
#
# The WebSocket `stats` broadcast uses a FLATTER, richer shape than the
# encounter-record blocks above: it inlines `_60s` variants and exposes both
# RAW and skill-settings-ADJUSTED crit/heavy figures. Captured + verified against
# the old .exe's `gold_stats_stream.jsonl` (disasm `CombatStats.to_dict`,
# L11740-12760). The encounter-record builders are unchanged (Phase 1 gate-green).
#
# Adjustment model (disasm L1285-1320): the accumulator stores RAW per-hit
# crit/heavy; at serialize time a skill flagged `cannot_crit`/`cannot_heavy`
# is excluded from the adjusted crit/heavy aggregates. `crit_rate` etc. report
# the ADJUSTED rate; `raw_crit_rate` etc. report the raw rate. With an empty (or
# non-matching) skill_settings, adjusted == raw.
# ---------------------------------------------------------------------------


def _per_skill_raw(hits: list[Hit]) -> dict[str, dict]:
    """Raw per-skill tallies: hits / crits / heavies / crit_damage / heavy_damage."""
    agg: dict[str, dict] = {}
    for h in hits:
        s = agg.get(h["skill"])
        if s is None:
            s = agg[h["skill"]] = {"hits": 0, "crits": 0, "heavies": 0,
                                   "crit_damage": 0, "heavy_damage": 0}
        s["hits"] += 1
        if h["is_crit"]:
            s["crits"] += 1
            s["crit_damage"] += h["damage"]
        if h["is_heavy"]:
            s["heavies"] += 1
            s["heavy_damage"] += h["damage"]
    return agg


def _adjusted(hits: list[Hit], skill_settings: dict) -> dict:
    """Skill-settings-adjusted crit/heavy/crit+heavy aggregates (disasm L1285-1320).

    For each skill: unless ``cannot_crit``, its hits/crits/crit_damage feed the
    adjusted crit aggregates; unless ``cannot_heavy``, likewise for heavy. The
    crit+heavy aggregate only counts skills where NEITHER flag is set, summed
    per-hit over those skills' crit-and-heavy hits.
    """
    per = _per_skill_raw(hits)
    a = {k: 0 for k in (
        "adj_crit_hits", "adj_crit_count", "adj_crit_damage",
        "adj_heavy_hits", "adj_heavy_count", "adj_heavy_damage",
        "adj_crit_heavy_hits", "adj_crit_heavy_count", "adj_crit_heavy_damage")}
    for skill, s in per.items():
        settings = skill_settings.get(skill) or {}
        cannot_crit = settings.get("cannot_crit", False)
        cannot_heavy = settings.get("cannot_heavy", False)
        if not cannot_crit:
            a["adj_crit_hits"] += s["hits"]
            a["adj_crit_count"] += s["crits"]
            a["adj_crit_damage"] += s["crit_damage"]
        if not cannot_heavy:
            a["adj_heavy_hits"] += s["hits"]
            a["adj_heavy_count"] += s["heavies"]
            a["adj_heavy_damage"] += s["heavy_damage"]
        if cannot_crit or cannot_heavy:
            continue
        a["adj_crit_heavy_hits"] += s["hits"]
    for h in hits:
        settings = skill_settings.get(h["skill"]) or {}
        if settings.get("cannot_crit") or settings.get("cannot_heavy"):
            continue
        if h["is_crit"] and h["is_heavy"]:
            a["adj_crit_heavy_count"] += 1
            a["adj_crit_heavy_damage"] += h["damage"]
    return a


def _ratio(num: int, den: int) -> float:
    """num/den*100, 1 dp; 0 when den is 0 (disasm uses the same > 0 guard)."""
    return round(num / den * 100, ROUND_RATE) if den > 0 else 0


def _live_gap_stats(hits: list[Hit]) -> dict:
    """Live gap analysis over the supplied (60s-window) hits (disasm L1340-1362).

    Differs from the encounter-record ``_gap_stats``: it runs over the 60s
    rotation, the emitted ``gaps`` list keeps records > 1.5s (not 2.0), while
    ``num_major_gaps`` still counts > 2.0s. Dead time sums (gap - 1.0) over
    gaps > 1.0s.
    """
    gaps: list[dict] = []
    total_gap = 0.0
    for i in range(1, len(hits)):
        prev_t = hits[i - 1].get("relative_time", 0)
        curr_t = hits[i].get("relative_time", 0)
        gap = curr_t - prev_t
        gaps.append({"after_index": i - 1, "duration": round(gap, ROUND_GAP_DURATION),
                     "at_time": round(prev_t, 1)})
        if gap > GAP_DEAD_THRESHOLD:
            total_gap += gap - GAP_DEAD_THRESHOLD
    return {
        "total_dead_time": round(total_gap, ROUND_DEAD_TIME),
        "num_major_gaps": len([g for g in gaps if g["duration"] > GAP_MAJOR_THRESHOLD]),
        "longest_gap": round(max((g["duration"] for g in gaps), default=0), ROUND_GAP_DURATION),
        "avg_time_between_hits": (
            round(sum(g["duration"] for g in gaps) / len(gaps), ROUND_GAP_DURATION) if gaps else 0),
        "gaps": [g for g in gaps if g["duration"] > GAP_LIVE_LIST_THRESHOLD],
    }


def build_live_stats(
    hits: list[Hit],
    *,
    skill_settings: dict | None = None,
    duration: float = 0.0,
    timeline_seconds: list[int] | None = None,
) -> dict:
    """The live WebSocket `stats.data` payload (disasm ``CombatStats.to_dict``).

    ``hits`` are RAW canonical hits (is_crit/is_heavy as logged, NOT corrected).
    ``duration`` is the real elapsed seconds (last-first timestamp); ``dps`` is
    ``total_damage / duration`` rounded 1dp. All other fields derive from ``hits``.

    ``timeline_seconds`` is the per-hit integer second bucket from the RAW elapsed
    time (the old backend buckets by ``int(real_seconds)``, not by the 1dp-rounded
    ``relative_time`` — rounding would shift boundary hits between buckets). When
    omitted, it falls back to ``int(relative_time)`` (exact only when timestamps
    are unavailable).
    """
    skill_settings = skill_settings or {}
    total_damage = sum(h["damage"] for h in hits)
    hit_count = len(hits)

    crit_count = sum(1 for h in hits if h["is_crit"])
    heavy_count = sum(1 for h in hits if h["is_heavy"])
    crit_heavy_count = sum(1 for h in hits if h["is_crit"] and h["is_heavy"])
    normal_count = sum(1 for h in hits if not h["is_crit"] and not h["is_heavy"])
    normal_damage = sum(h["damage"] for h in hits if not h["is_crit"] and not h["is_heavy"])

    adj = _adjusted(hits, skill_settings)
    dps = round(total_damage / duration, ROUND_DPS) if duration > 0 else 0

    # 60s window
    hits_60s = slice_first_60s(hits)
    damage_60s = sum(h["damage"] for h in hits_60s)
    duration_60s = round(min(duration, SIXTY_SECOND_WINDOW), ROUND_DURATION)
    adj60 = _adjusted(hits_60s, skill_settings)

    # timeline: per-second damage buckets, length int(duration)+1
    if timeline_seconds is None:
        timeline_seconds = [int(h["relative_time"]) for h in hits]
    timeline_map: dict[int, int] = {}
    for h, sec in zip(hits, timeline_seconds):
        timeline_map[sec] = timeline_map.get(sec, 0) + h["damage"]
    timeline = [timeline_map.get(i, 0) for i in range(int(duration) + 1)] if hits else []

    targets = _targets(hits, total_damage)
    primary_target = targets[0]["name"] if targets else "Unknown"

    return {
        "dps": dps,
        "total_damage": total_damage,
        "duration": round(duration, ROUND_DURATION),
        "normal_rate": _ratio(normal_count, hit_count),
        "normal_count": normal_count,
        "normal_damage": normal_damage,
        "crit_rate": _ratio(adj["adj_crit_count"], adj["adj_crit_hits"]),
        "heavy_rate": _ratio(adj["adj_heavy_count"], adj["adj_heavy_hits"]),
        "hit_count": hit_count,
        "crit_count": adj["adj_crit_count"],
        "crit_damage": adj["adj_crit_damage"],
        "heavy_count": adj["adj_heavy_count"],
        "heavy_damage": adj["adj_heavy_damage"],
        "crit_heavy_rate": _ratio(adj["adj_crit_heavy_count"], adj["adj_crit_heavy_hits"]),
        "crit_heavy_count": adj["adj_crit_heavy_count"],
        "crit_heavy_damage": adj["adj_crit_heavy_damage"],
        "raw_crit_rate": _ratio(crit_count, hit_count),
        "raw_heavy_rate": _ratio(heavy_count, hit_count),
        "raw_crit_heavy_rate": _ratio(crit_heavy_count, hit_count),
        "adj_crit_hits": adj["adj_crit_hits"],
        "adj_heavy_hits": adj["adj_heavy_hits"],
        "adj_crit_heavy_hits": adj["adj_crit_heavy_hits"],
        "first_hit": hits[0]["time"] if hits else None,
        "last_hit": hits[-1]["time"] if hits else None,
        "skills": _skills(hits, total_damage),
        "targets": targets,
        "top_hits": _top_hits(hits),
        "hit_log": [dict(h) for h in hits],
        "timeline": timeline,
        "primary_target": primary_target,
        "dps_60s": round(damage_60s / duration_60s, ROUND_DPS) if duration_60s > 0 else 0,
        "damage_60s": damage_60s,
        "duration_60s": duration_60s,
        "crit_rate_60s": _ratio(adj60["adj_crit_count"], adj60["adj_crit_hits"]),
        "heavy_rate_60s": _ratio(adj60["adj_heavy_count"], adj60["adj_heavy_hits"]),
        "hit_count_60s": len(hits_60s),
        "crit_count_60s": adj60["adj_crit_count"],
        "crit_damage_60s": adj60["adj_crit_damage"],
        "heavy_count_60s": adj60["adj_heavy_count"],
        "heavy_damage_60s": adj60["adj_heavy_damage"],
        "crit_heavy_rate_60s": _ratio(adj60["adj_crit_heavy_count"], adj60["adj_crit_heavy_hits"]),
        "crit_heavy_count_60s": adj60["adj_crit_heavy_count"],
        "crit_heavy_damage_60s": adj60["adj_crit_heavy_damage"],
        "skills_60s": _skills(hits_60s, damage_60s),
        "top_hits_60s": _top_hits(hits_60s),
        "rotation_60s": [dict(h) for h in hits_60s],
        "gap_stats": _live_gap_stats(hits_60s),
    }


class CombatStats:
    """Live accumulator wrapping the pure builders (used by the server in Phase 3+).

    Tracks first/last raw timestamps so the live broadcast's ``duration``/``dps``
    use real elapsed seconds (the per-hit ``relative_time`` is rounded to 1dp and
    is too coarse for dps). Feed it ``parse_line`` partials (which carry
    ``_timestamp``) via :meth:`add_partial`, or canonical hits via :meth:`add_hit`.
    """

    def __init__(self) -> None:
        self.hits: list[Hit] = []
        self.seconds: list[int] = []  # raw int second-bucket per hit (for timeline)
        self.first_ts = None
        self.last_ts = None

    def add_hit(self, hit: Hit) -> None:
        self.hits.append(hit)
        self.seconds.append(int(hit.get("relative_time", 0)))

    def add_partial(self, partial: Hit) -> None:
        """Add a ``parse_line`` partial: tracks timestamps and appends a canonical hit."""
        ts = partial["_timestamp"]
        if self.first_ts is None:
            self.first_ts = ts
        self.last_ts = ts
        elapsed = (ts - self.first_ts).total_seconds()
        self.hits.append({
            "time": partial["time"],
            "relative_time": round(elapsed, ROUND_REL_TIME),
            "skill": partial["skill"],
            "target": partial["target"],
            "damage": partial["damage"],
            "is_crit": partial["is_crit"],
            "is_heavy": partial["is_heavy"],
            "hit_type": partial["hit_type"],
        })
        self.seconds.append(int(elapsed))

    def reset(self) -> None:
        n = len(self.hits)
        self.hits.clear()
        self.seconds.clear()
        self.first_ts = None
        self.last_ts = None
        trace("stats.reset", hits_before=n, hits_after=0)

    def real_duration(self) -> float:
        """Elapsed seconds between first and last hit (0 when fewer than 2 hits)."""
        if self.first_ts is None or self.last_ts is None:
            return 0.0
        return (self.last_ts - self.first_ts).total_seconds()

    def overall(self) -> dict:
        return build_overall_block(self.hits)

    def first_60s(self) -> dict:
        return build_first_60s_block(slice_first_60s(self.hits))

    def live(self, skill_settings: dict | None = None) -> dict:
        return build_live_stats(self.hits, skill_settings=skill_settings,
                                duration=self.real_duration(),
                                timeline_seconds=self.seconds)
