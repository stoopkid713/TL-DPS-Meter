"""A2 gate: encounter-aware PartyState segmentation (Workstream B Phase 2).

Companion to ``test_party_state.py`` (which pins the legacy single-encounter
contract — those must stay green = behaviour held constant). These drive the NEW
boundary capability directly: gap (rule #3) and leader/explicit id (rule #1), plus
per-encounter ``get_results`` and the enumeration list. The server doesn't pass the
new args yet (A3), so this is the only coverage of segmentation until then.
"""
from __future__ import annotations

from datetime import datetime, timedelta

from party_state import PartyState


def _ts(sec: int) -> datetime:
    return datetime(2026, 5, 31, 12, 0, 0) + timedelta(seconds=sec)


def test_no_category_no_id_stays_one_encounter_even_across_a_huge_gap():
    """The legacy 5-arg call never segments — even a 10-minute gap = one encounter.

    This is the behaviour-constant guarantee: the server calls record_hit without
    ``category``/``encounter_id`` today, so multi-boss segmentation can't leak in
    before A3 wires it.
    """
    ps = PartyState()
    ps.start_recording("ROOM")
    ps.record_hit("Boss", 100, False, False, _ts(0))
    ps.record_hit("Boss", 100, False, False, _ts(600))  # 10-min gap, no category
    assert len(ps.encounters) == 1
    assert ps.get_results()["total_damage"] == 200


def test_gap_boundary_splits_same_boss_into_two_encounters():
    """raid_boss gap > 45s = wipe/refight = two distinct encounters, both kept."""
    ps = PartyState()
    ps.start_recording("ROOM")
    ps.record_hit("Tevent", 1000, True, False, _ts(0), category="raid_boss")
    ps.record_hit("Tevent", 500, False, False, _ts(10), category="raid_boss")
    # 46s gap (> 45 boss threshold) -> new encounter, same boss.
    ps.record_hit("Tevent", 800, False, True, _ts(56), category="raid_boss")

    assert len(ps.encounters) == 2
    a, b = ps.encounters
    assert a.encounter_id != b.encounter_id
    assert a.total_damage() == 1500
    assert b.total_damage() == 800
    # current = the second attempt; default get_results follows current.
    assert ps.get_results()["total_damage"] == 800
    # past encounter still fetchable by id.
    assert ps.get_results(a.encounter_id)["total_damage"] == 1500


def test_gap_exactly_at_threshold_does_not_split():
    """45s == threshold stays in one encounter (`> threshold`, not `>=`)."""
    ps = PartyState()
    ps.start_recording("ROOM")
    ps.record_hit("Tevent", 100, False, False, _ts(0), category="raid_boss")
    ps.record_hit("Tevent", 100, False, False, _ts(45), category="raid_boss")
    assert len(ps.encounters) == 1


def test_leader_encounter_id_opens_and_aligns_encounters():
    """Explicit encounter_id (leader / F1b) rolls a new encounter; same id is sticky."""
    ps = PartyState()
    ps.start_recording("ROOM")
    ps.record_hit("Boss", 100, False, False, _ts(0), encounter_id="A")
    ps.record_hit("Boss", 100, False, False, _ts(1), encounter_id="A")  # same id, no roll
    assert len(ps.encounters) == 1
    assert ps.current.encounter_id == "A"

    ps.record_hit("Boss", 200, False, False, _ts(2), encounter_id="B")  # new id -> roll
    assert len(ps.encounters) == 2
    assert ps.get_results("A")["total_damage"] == 200
    assert ps.get_results("B")["total_damage"] == 200


def test_begin_encounter_is_idempotent_and_closes_current():
    ps = PartyState()
    ps.start_recording("ROOM")
    ps.record_hit("Boss", 100, False, False, _ts(0), encounter_id="A")
    ps.begin_encounter("A")  # already current -> no new encounter
    assert len(ps.encounters) == 1
    ps.begin_encounter("C")  # explicit new boundary
    assert len(ps.encounters) == 2
    assert ps.current.encounter_id == "C"


def test_lazy_encounter_id_is_first_hit_fight_ts():
    """With no leader id, the encounter is keyed to str(epoch-ms of first hit) (F1)."""
    ps = PartyState()
    ps.start_recording("ROOM")
    ps.record_hit("Boss", 100, False, False, _ts(0))
    expected = str(int(_ts(0).timestamp() * 1000))
    assert ps.current.encounter_id == expected


def test_list_encounters_enumeration():
    ps = PartyState()
    ps.start_recording("ROOM")
    ps.record_hit("Tevent", 1000, False, False, _ts(0), category="raid_boss")
    ps.record_hit("Tevent", 800, False, False, _ts(56), category="raid_boss")  # gap split

    metas = ps.list_encounters()
    assert len(metas) == 2
    assert [m["total_damage"] for m in metas] == [1000, 800]
    assert all(m["encounter_id"] and m["fight_ts"] and m["started_at"] for m in metas)
    # ids are distinct and oldest-first.
    assert metas[0]["fight_ts"] < metas[1]["fight_ts"]


def test_get_results_unknown_id_returns_empty_shape():
    ps = PartyState()
    ps.start_recording("ROOM")
    ps.record_hit("Boss", 100, False, False, _ts(0))
    assert ps.get_results("nope") == {
        "targets": [], "total_damage": 0, "duration": 0, "fight_ts": None}
