"""Shared encounter-boundary predicate (gap thresholds + category lookup).

One source of truth for *where an encounter ends*, so the two segmentation paths
agree:

* the **file-history** path — :func:`encounter_scan.parse_encounters_from_log`,
  which re-parses a whole combat-log file into per-target, gap-bounded encounters;
* the **live-ingest** path — the party accumulator (Workstream B Phase 2), which
  segments the live hit stream as the post-combat flush is ingested.

Extracted verbatim from ``encounter_scan`` (disasm L1690-1848 category routing):
archboss → same-calendar-day grouping (NOT gap-based); the three boss categories →
45s gap split; adds → 30s; everything else → 30s. Keeping these here means a
threshold tweak lands in both paths at once and they can never drift.

Pure functions only — no I/O, no transport, stdlib ``datetime`` in / scalars out.
"""
from __future__ import annotations

from datetime import datetime
from typing import Optional

# Category routing. ``archboss`` is intentionally absent from any gap table: it is
# grouped by calendar day, not by an inter-hit gap (see :func:`is_new_encounter`).
BOSS_CATEGORIES = ("raid_boss", "field_boss", "dungeon_boss")
BOSS_GAP_THRESHOLD = 45
OTHER_GAP_THRESHOLD = 30
ADDS_GAP_THRESHOLD = 30

ARCHBOSS_CATEGORY = "archboss"


def category_for_target(target_name: str, target_assignments: dict) -> str:
    """Resolve a target's category from the merged assignments map.

    ``target_assignments`` is the ``{"assignments": {name: category}}`` map
    (defaults + user overrides), exactly as
    :func:`encounter_scan.parse_encounters_from_log` consumes it. Unknown targets
    fall back to ``"other"`` (the disasm default).
    """
    assignments = target_assignments.get("assignments", {})
    return assignments.get(target_name, "other")


def gap_threshold_for_category(category: str) -> Optional[int]:
    """Seconds-gap that closes an encounter for ``category``.

    ``None`` for ``archboss`` — it is not gap-bounded (same-calendar-day grouping);
    callers must branch on ``None`` and use the day rule instead. Boss categories →
    45s; ``adds`` and everything else → 30s (kept as two named constants to mirror
    the original even though they share a value today).
    """
    if category == ARCHBOSS_CATEGORY:
        return None
    if category in BOSS_CATEGORIES:
        return BOSS_GAP_THRESHOLD
    if category == "adds":
        return ADDS_GAP_THRESHOLD
    return OTHER_GAP_THRESHOLD


def is_new_encounter(prev_ts: datetime, next_ts: datetime, category: str) -> bool:
    """Does the hit at ``next_ts`` start a NEW encounter, given the previous hit?

    The boundary predicate, shared by the file and live paths:

    * ``archboss`` → a new encounter only across a calendar-day change (same-day
      hits all collapse to one encounter, per :func:`parse_archboss_encounters`);
    * everything else → a new encounter when the inter-hit gap *exceeds* the
      category threshold (``> threshold``, matching the original ``gap > threshold``
      — a gap exactly equal to the threshold stays in the current encounter).
    """
    if category == ARCHBOSS_CATEGORY:
        return prev_ts.date() != next_ts.date()
    threshold = gap_threshold_for_category(category)
    return (next_ts - prev_ts).total_seconds() > threshold
