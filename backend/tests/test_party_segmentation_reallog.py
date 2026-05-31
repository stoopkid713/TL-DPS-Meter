"""V1 gate: client-side party segmentation against a REAL combat log.

The Block-A unit tests (test_party_state_encounters / test_party_posting) drive
segmentation with *synthetic* timestamps + injected assignments. This test closes the
gap that the smooth synthetic build hid: it runs the real ingest chain
(``ingest_lines`` -> ``_record_party_hit`` -> category lookup -> ``party_state`` gap-roll)
against a REAL, anonymized multi-boss combat-log slice and asserts the headline
behaviour — a boss fought twice (wipe-retry) segments into two DISTINCT encounters.

Fixture: ``fixtures/party_multiboss_sample.txt`` — a downsampled, caster-anonymized slice
of a real run (adds pack -> Lucien -> ~158s gap -> Lucien again). Real timestamps/targets/
gaps; only the caster field is scrubbed (PII) and hits are thinned (segmentation is
gap+target driven, so density doesn't matter).

Decoupled from the shipped/auto-refreshing assignment dataset (owned by a separate
project): the test supplies its OWN category map (only ``Lucien`` -> dungeon_boss matters;
the duplicate-boss split is driven by the ~158s gap, which exceeds every threshold). So this
stays green regardless of how the external boss/skill/dungeon assignments evolve.
"""
from __future__ import annotations

from pathlib import Path

from dps_meter_server import DPSMeterServer

FIXTURE = Path(__file__).resolve().parent.parent / "fixtures" / "party_multiboss_sample.txt"


def _top_target(enc) -> str:
    items = sorted(enc.target_damage.items(), key=lambda kv: -kv[1]["damage"])
    return items[0][0] if items else ""


def test_real_log_duplicate_boss_segments_into_distinct_encounters(tmp_path):
    lines = FIXTURE.read_text(encoding="utf-8", errors="replace").splitlines()
    assert len(lines) > 20, "fixture should hold a real multi-boss slice"

    srv = DPSMeterServer(str(tmp_path), port=0)
    # Explicit, minimal category map — NOT the shipped dataset. Only Lucien's category
    # is relevant; everything else falls to "other" via the _party_category default.
    srv._party_assignments = {"Lucien": "dungeon_boss"}
    srv.party.start_recording("REALLOG")
    srv.ingest_lines(lines)

    encs = srv.party.encounters
    assert len(encs) >= 2, f"expected multiple encounters, got {len(encs)}"

    lucien = [e for e in encs if _top_target(e) == "Lucien"]
    # The boss was fought twice with a wipe/gap between -> TWO distinct encounters, both kept.
    assert len(lucien) == 2, f"expected 2 Lucien encounters (wipe-retry), got {len(lucien)}"
    assert lucien[0].encounter_id != lucien[1].encounter_id, "duplicate-boss encounters must have distinct ids"
    assert lucien[0].encounter_id and lucien[1].encounter_id

    # Ordered by occurrence; the gap between the two fights is the real ~158s wipe gap.
    lucien.sort(key=lambda e: e.first_hit_time)
    gap = (lucien[1].first_hit_time - lucien[0].last_hit_time).total_seconds()
    assert gap > 60, f"the two Lucien fights should be separated by a large gap, got {gap:.0f}s"

    # Each Lucien encounter is a real fight with damage to Lucien.
    for e in lucien:
        assert e.total_damage() > 0
        assert "Lucien" in e.target_damage


def test_real_log_first_fight_has_no_internal_split(tmp_path):
    """A single continuous boss fight must NOT over-split (no intra-fight false gaps in
    the downsampled fixture — kept-hit spacing stays well under the boss threshold)."""
    lines = FIXTURE.read_text(encoding="utf-8", errors="replace").splitlines()
    srv = DPSMeterServer(str(tmp_path), port=0)
    srv._party_assignments = {"Lucien": "dungeon_boss"}
    srv.party.start_recording("REALLOG")
    srv.ingest_lines(lines)

    lucien = [e for e in srv.party.encounters if _top_target(e) == "Lucien"]
    # Exactly two — not three+ from a fight fragmenting internally.
    assert len(lucien) == 2
