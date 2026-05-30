"""Parity + unit tests for the log-scanning path (encounter history + details).

The strongest check is real-data parity: ``parse_encounters_from_log`` over the
frozen ``fixtures/gold_combat.log`` must reproduce the old exe's captured
``get_encounter_history`` reply (``fixtures/gold_init_responses.json``) exactly —
all 17 encounters, every field. ``parse_encounter_details`` is cross-validated
against that golden: the most-recent King Khanzaizin encounter's window is
time-isolated, so the details total_damage / hit_count must equal the history
entry's. The rest are focused unit tests on the windowing + crit/heavy cascade.
"""
from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path

import encounter_scan
import persistence as p

BACKEND = Path(__file__).resolve().parents[1]
REPO = BACKEND.parent
FIX = BACKEND / "fixtures"
GOLD_LOG = FIX / "gold_combat.log"


def _merged_assignments() -> dict:
    """Defaults (inverted) + user overrides, as the old load_target_assignments did."""
    defaults = p.load_default_targets(str(REPO))
    merged: dict[str, str] = {}
    for category, names in defaults.items():
        if isinstance(names, list):
            for name in names:
                merged[name] = category
    merged.update(p.load_target_assignments(str(REPO)).get("assignments", {}))
    return {"assignments": merged}


def _gold_history() -> list[dict]:
    init = json.loads((FIX / "gold_init_responses.json").read_text(encoding="utf-8"))
    return init["get_encounter_history"]["encounters"]


def _norm_entry(e: dict) -> dict:
    """Round the one messy float (dps) so float division reprs can't false-fail."""
    out = dict(e)
    out["dps"] = round(float(e["dps"]), 4)
    out["duration"] = round(float(e["duration"]), 4)
    out["gap_before"] = round(float(e["gap_before"]), 4)
    return out


# --- real-data parity: history --------------------------------------------
def test_history_matches_gold_exactly():
    encounters = encounter_scan.parse_encounters_from_log(GOLD_LOG, _merged_assignments())
    payload = encounter_scan.encounter_history_payload(encounters)
    gold = _gold_history()
    assert len(payload) == len(gold) == 17
    for got, want in zip(payload, gold):
        assert _norm_entry(got) == _norm_entry(want)


def test_history_missing_file_is_empty():
    assert encounter_scan.parse_encounters_from_log(None, _merged_assignments()) == []
    assert encounter_scan.parse_encounters_from_log(
        FIX / "does_not_exist.log", _merged_assignments()) == []


# --- real-data cross-validation: details ----------------------------------
def test_details_matches_gold_encounter():
    """The most-recent King Khanzaizin encounter is time-isolated, so its details
    window [start-10s, +10min] captures exactly that encounter's hits."""
    gold = _gold_history()
    target = gold[0]  # end_time desc -> most recent; King Khanzaizin, isolated
    assert target["target_name"] == "King Khanzaizin"
    start = datetime.fromisoformat(target["start_time"])
    details = encounter_scan.parse_encounter_details(GOLD_LOG, "King Khanzaizin", start, {})
    assert details is not None
    assert details["total_damage"] == target["total_damage"]
    assert details["hit_count"] == target["hit_count"]
    # internal consistency
    assert sum(h["damage"] for h in details["hit_log"]) == details["total_damage"]
    assert len(details["hit_log"]) == details["hit_count"]
    assert (details["crit_count"] + details["heavy_count"]
            + details["crit_heavy_count"] + details["normal_count"]) == details["hit_count"]
    assert details["timeline"] == details["timeline"][: int(details["duration"]) + 1]
    assert len(details["timeline"]) == int(details["duration"]) + 1
    assert sum(details["timeline"]) == details["total_damage"]
    assert details["primary_target"] == "King Khanzaizin"
    assert details["gap_stats"] == {}
    assert details["targets"] == [{"name": "King Khanzaizin",
                                   "damage": details["total_damage"]}]


def test_details_field_set_matches_old_shape():
    gold = _gold_history()
    start = datetime.fromisoformat(gold[0]["start_time"])
    details = encounter_scan.parse_encounter_details(GOLD_LOG, "King Khanzaizin", start, {})
    # handler stamps these two AFTER the function; the function itself returns these keys:
    expected = {
        "dps", "total_damage", "duration", "hit_count",
        "crit_rate", "crit_count", "heavy_rate", "heavy_count",
        "crit_heavy_rate", "crit_heavy_count", "normal_rate", "normal_count",
        "skills", "top_hits", "hit_log", "timeline", "targets",
        "first_hit", "last_hit", "primary_target",
        "dps_60s", "damage_60s", "hit_count_60s",
        "crit_rate_60s", "crit_count_60s", "heavy_rate_60s", "heavy_count_60s",
        "crit_heavy_rate_60s", "crit_heavy_count_60s", "normal_rate_60s", "normal_count_60s",
        "skills_60s", "rotation_60s", "duration_60s", "gap_stats",
    }
    assert set(details.keys()) == expected
    hit = details["hit_log"][0]
    assert set(hit.keys()) == {"timestamp", "skill", "damage", "is_crit",
                               "is_heavy", "target", "relative_time"}
    skill = details["skills"][0]
    assert set(skill.keys()) == {"name", "damage", "hits", "crits", "heavies",
                                 "percent", "crit_percent", "heavy_percent"}
    assert len(details["top_hits"]) <= 10


def test_details_no_match_returns_none():
    gold = _gold_history()
    start = datetime.fromisoformat(gold[0]["start_time"])
    assert encounter_scan.parse_encounter_details(
        GOLD_LOG, "Nonexistent Target XYZ", start, {}) is None
    assert encounter_scan.parse_encounter_details(None, "King Khanzaizin", start, {}) is None


# --- focused unit tests on the algorithms ----------------------------------
def _mklog(tmp_path: Path, rows: list[tuple]) -> Path:
    """Write a minimal combat log. rows = (ts 'HH:MM:SS', skill, dmg, crit, heavy, target)."""
    lines = ["CombatLogVersion,4"]
    for ts, skill, dmg, crit, heavy, target in rows:
        lines.append(",".join([
            f"20260104-{ts}:000", "DamageDone", skill, "1", str(dmg),
            "1" if crit else "0", "1" if heavy else "0", "0", "Player", target,
        ]))
    f = tmp_path / "combat.txt"
    f.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return f


def test_other_category_gap_split_30s(tmp_path):
    """Two clusters of the same 'other' target split when the gap exceeds 30s."""
    log = _mklog(tmp_path, [
        ("10:00:00", "A", 100, False, False, "Mob"),
        ("10:00:05", "A", 100, False, False, "Mob"),
        ("10:00:40", "A", 100, False, False, "Mob"),  # +35s gap -> new encounter
        ("10:00:45", "A", 100, False, False, "Mob"),
    ])
    encs = encounter_scan.parse_encounters_from_log(log, {"assignments": {}})
    assert len(encs) == 2
    # sorted by end_time desc: the later cluster first
    assert encs[0]["start_time"].strftime("%H:%M:%S") == "10:00:40"
    assert encs[0]["hit_count"] == 2
    assert encs[0].get("gap_before", 0) == 0  # trailing flush carries no gap_before
    assert encs[1]["hit_count"] == 2
    assert encs[1]["gap_before"] == 35.0      # the split gap is recorded on the closed encounter


def test_archboss_groups_per_day(tmp_path):
    log = _mklog(tmp_path, [
        ("10:00:00", "A", 100, False, False, "Arch"),
        ("11:30:00", "A", 200, False, False, "Arch"),  # same day, huge gap -> still one
    ])
    encs = encounter_scan.parse_encounters_from_log(log, {"assignments": {"Arch": "archboss"}})
    assert len(encs) == 1
    assert encs[0]["total_damage"] == 300
    assert encs[0]["hit_count"] == 2
    assert encs[0]["date_label"] == datetime(2026, 1, 4).strftime("%b %d")


def test_details_crit_heavy_cascade(tmp_path):
    """crit_count/heavy_count are EXCLUSIVE of crit+heavy; per-skill counts include it."""
    log = _mklog(tmp_path, [
        ("10:00:00", "S", 100, True, True, "Mob"),    # crit+heavy
        ("10:00:01", "S", 100, True, False, "Mob"),   # crit only
        ("10:00:02", "S", 100, False, True, "Mob"),   # heavy only
        ("10:00:03", "S", 100, False, False, "Mob"),  # normal
    ])
    start = datetime(2026, 1, 4, 10, 0, 0)
    d = encounter_scan.parse_encounter_details(log, "Mob", start, {})
    assert d["hit_count"] == 4
    assert d["crit_count"] == 1          # crit-only
    assert d["heavy_count"] == 1         # heavy-only
    assert d["crit_heavy_count"] == 1
    assert d["normal_count"] == 1
    assert d["crit_count"] + d["heavy_count"] + d["crit_heavy_count"] + d["normal_count"] == 4
    s = d["skills"][0]
    assert s["crits"] == 2               # crit-only + crit+heavy
    assert s["heavies"] == 2             # heavy-only + crit+heavy
    assert d["total_damage"] == 400


def test_details_window_excludes_outside(tmp_path):
    """Hits before start-10s or after start+10min are dropped."""
    log = _mklog(tmp_path, [
        ("09:59:45", "S", 999, False, False, "Mob"),  # 15s before start -> excluded (<10s window)
        ("10:00:00", "S", 100, False, False, "Mob"),  # start
        ("10:05:00", "S", 100, False, False, "Mob"),  # within +10min
        ("10:11:00", "S", 999, False, False, "Mob"),  # 11min after -> excluded
    ])
    start = datetime(2026, 1, 4, 10, 0, 0)
    d = encounter_scan.parse_encounter_details(log, "Mob", start, {})
    assert d["hit_count"] == 2
    assert d["total_damage"] == 200
