"""Unit tests for the shared encounter-boundary predicate.

Pins the gap thresholds + category lookup + the ``> threshold`` (not ``>=``) edge
semantics that BOTH the file-history path (``encounter_scan``) and the live
party-segmentation path (Workstream B Phase 2) depend on. If these change, the two
paths drift — that is exactly what the shared module exists to prevent.
"""
from __future__ import annotations

from datetime import datetime, timedelta

import pytest

import encounter_boundary as eb


# --- category_for_target -----------------------------------------------------
def test_category_for_target_known():
    assignments = {"assignments": {"Tevent": "archboss", "Goblin": "adds"}}
    assert eb.category_for_target("Tevent", assignments) == "archboss"
    assert eb.category_for_target("Goblin", assignments) == "adds"


def test_category_for_target_unknown_falls_back_to_other():
    assert eb.category_for_target("Nobody", {"assignments": {}}) == "other"
    # Missing "assignments" key entirely is tolerated.
    assert eb.category_for_target("Nobody", {}) == "other"


# --- gap_threshold_for_category ----------------------------------------------
@pytest.mark.parametrize("category,expected", [
    ("raid_boss", 45),
    ("field_boss", 45),
    ("dungeon_boss", 45),
    ("adds", 30),
    ("other", 30),
    ("some_unmapped_thing", 30),
])
def test_gap_threshold_values(category, expected):
    assert eb.gap_threshold_for_category(category) == expected


def test_archboss_has_no_gap_threshold():
    # archboss is day-grouped, not gap-bounded.
    assert eb.gap_threshold_for_category("archboss") is None


# --- is_new_encounter: gap edge (> threshold, not >=) ------------------------
def _ts(seconds: int) -> datetime:
    return datetime(2026, 5, 31, 12, 0, 0) + timedelta(seconds=seconds)


def test_boss_gap_at_threshold_stays_same_encounter():
    # Exactly 45s gap -> NOT a new encounter (original used `gap > threshold`).
    assert eb.is_new_encounter(_ts(0), _ts(45), "raid_boss") is False


def test_boss_gap_over_threshold_splits():
    assert eb.is_new_encounter(_ts(0), _ts(46), "raid_boss") is True


def test_adds_gap_edges():
    assert eb.is_new_encounter(_ts(0), _ts(30), "adds") is False
    assert eb.is_new_encounter(_ts(0), _ts(31), "adds") is True


def test_other_gap_edges():
    assert eb.is_new_encounter(_ts(0), _ts(30), "other") is False
    assert eb.is_new_encounter(_ts(0), _ts(31), "other") is True


# --- is_new_encounter: archboss day rule -------------------------------------
def test_archboss_same_day_is_not_new():
    morning = datetime(2026, 5, 31, 8, 0, 0)
    night = datetime(2026, 5, 31, 23, 59, 0)  # huge gap, same calendar day
    assert eb.is_new_encounter(morning, night, "archboss") is False


def test_archboss_across_midnight_is_new():
    late = datetime(2026, 5, 31, 23, 59, 0)
    next_day = datetime(2026, 6, 1, 0, 1, 0)  # 2-minute gap, new calendar day
    assert eb.is_new_encounter(late, next_day, "archboss") is True
