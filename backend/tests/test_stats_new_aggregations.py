"""Gate tests for the two new aggregations (spec §2 + §3).

  1. hit_quality() — accuracy / hit-type distribution
  2. build_target_blocks() — full per-target stat blocks
  3. Integration: build_overall_block() now returns both under new keys
  4. party_state path: get_results(include_target_breakdown=True)

Ground truth uses the ``sample_input_hits.json`` fixture (1 763 hits against a
single target "Practice Dummy").  The exact distribution was verified by a
field[7] histogram against the raw log:

    kMaxDamageByCriticalDecision : 607
    kNormalHit                   : 1 152
    kMaxDamageByNormal           : 2
    kMinDamageByNormal           : 1
    kMiss                        : 1
    total                        : 1 763

The single-target fixture means sum-of-per-target-damage == overall total_damage.
Multi-target behaviour is exercised via synthetic hits below.
"""
from __future__ import annotations

import json
import os
from datetime import datetime, timedelta

import pytest

from combat_stats import build_overall_block, build_target_blocks, hit_quality
from party_state import PartyState

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------
BACKEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FIX_DIR = os.path.join(BACKEND, "fixtures")
SAMPLE_HITS_PATH = os.path.join(FIX_DIR, "sample_input_hits.json")

_have_sample = os.path.isfile(SAMPLE_HITS_PATH)
_skip_no_sample = pytest.mark.skipif(
    not _have_sample,
    reason="sample_input_hits.json absent; run tools/build_sample_fixture.py",
)


def _load_sample() -> list[dict]:
    with open(SAMPLE_HITS_PATH, encoding="utf-8") as f:
        return json.load(f)


def _make_hit(skill: str, target: str, damage: int, *,
              is_crit: bool = False, is_heavy: bool = False,
              hit_type: str = "kNormalHit",
              relative_time: float = 0.0) -> dict:
    return {
        "time": "00:00:00",
        "relative_time": relative_time,
        "skill": skill,
        "target": target,
        "damage": damage,
        "is_crit": is_crit,
        "is_heavy": is_heavy,
        "hit_type": hit_type,
    }


# ---------------------------------------------------------------------------
# 1. hit_quality() — accuracy / hit-type distribution
# ---------------------------------------------------------------------------

class TestHitQuality:

    def test_empty_hits(self):
        """Zero-length list must not raise and must produce all-zero block."""
        q = hit_quality([])
        assert q["total"] == 0
        assert q["miss_count"] == 0
        assert q["miss_rate"] == 0.0
        assert q["accuracy"] == 0.0
        assert q["normal_count"] == 0
        assert q["crit_decision_count"] == 0

    def test_all_keys_present(self):
        h = _make_hit("A", "T", 100)
        q = hit_quality([h])
        expected_keys = {
            "miss_count", "miss_rate", "accuracy",
            "normal_count", "normal_rate",
            "min_normal_count", "min_normal_rate",
            "max_normal_count", "max_normal_rate",
            "crit_decision_count", "crit_decision_rate",
            "total",
        }
        assert set(q.keys()) == expected_keys

    def test_single_normal_hit(self):
        h = _make_hit("Slash", "Goblin", 500, hit_type="kNormalHit")
        q = hit_quality([h])
        assert q["total"] == 1
        assert q["normal_count"] == 1
        assert q["normal_rate"] == 100.0
        assert q["miss_count"] == 0
        assert q["accuracy"] == 100.0
        assert q["crit_decision_count"] == 0

    def test_single_miss(self):
        h = _make_hit("Bomb", "Orc", 0, hit_type="kMiss")
        q = hit_quality([h])
        assert q["total"] == 1
        assert q["miss_count"] == 1
        assert q["miss_rate"] == 100.0
        assert q["accuracy"] == 0.0

    def test_rates_sum_to_100(self):
        """The five rates must sum to 100 % (within rounding tolerance)."""
        hits = [
            _make_hit("A", "T", 100, hit_type="kNormalHit"),
            _make_hit("A", "T", 200, hit_type="kMaxDamageByCriticalDecision"),
            _make_hit("A", "T", 50, hit_type="kMinDamageByNormal"),
            _make_hit("A", "T", 0, hit_type="kMiss"),
            _make_hit("A", "T", 150, hit_type="kMaxDamageByNormal"),
        ]
        q = hit_quality(hits)
        total_rate = (q["normal_rate"] + q["crit_decision_rate"] + q["min_normal_rate"]
                      + q["miss_rate"] + q["max_normal_rate"])
        assert abs(total_rate - 100.0) <= 0.5  # rounding tolerance

    def test_accuracy_complement_of_miss_rate(self):
        hits = [
            _make_hit("A", "T", 0, hit_type="kMiss"),
            _make_hit("A", "T", 100, hit_type="kNormalHit"),
            _make_hit("A", "T", 100, hit_type="kNormalHit"),
            _make_hit("A", "T", 100, hit_type="kNormalHit"),
        ]
        q = hit_quality(hits)
        assert q["miss_count"] == 1
        assert q["miss_rate"] == 25.0   # 1/4 * 100
        assert q["accuracy"] == 75.0    # 3/4 * 100

    @_skip_no_sample
    def test_gold_fixture_exact_distribution(self):
        """Verify against the known field[7] histogram from the gold combat log."""
        hits = _load_sample()
        q = hit_quality(hits)
        assert q["total"] == 1763
        assert q["miss_count"] == 1,           f"miss_count: {q['miss_count']}"
        assert q["normal_count"] == 1152,      f"normal_count: {q['normal_count']}"
        assert q["min_normal_count"] == 1,     f"min_normal_count: {q['min_normal_count']}"
        assert q["max_normal_count"] == 2,     f"max_normal_count: {q['max_normal_count']}"
        assert q["crit_decision_count"] == 607, f"crit_decision_count: {q['crit_decision_count']}"

    @_skip_no_sample
    def test_gold_fixture_miss_rate(self):
        hits = _load_sample()
        q = hit_quality(hits)
        # 1 miss / 1763 hits -> 0.1 % (1 dp)
        assert q["miss_rate"] == round(1 / 1763 * 100, 1)
        assert q["accuracy"] == round(1762 / 1763 * 100, 1)


# ---------------------------------------------------------------------------
# 2. build_target_blocks() — per-target stat blocks
# ---------------------------------------------------------------------------

class TestBuildTargetBlocks:

    def test_empty_hits(self):
        assert build_target_blocks([]) == {}

    def test_single_target_stat_block_shape(self):
        """A per-target block must have the same shape as build_stat_block."""
        from combat_stats import build_stat_block
        hits = [
            _make_hit("Slash", "Goblin", 1000, is_crit=True, relative_time=0.0),
            _make_hit("Slash", "Goblin", 500, relative_time=1.0),
            _make_hit("Fireball", "Goblin", 800, is_heavy=True, relative_time=2.0),
        ]
        blocks = build_target_blocks(hits)
        assert "Goblin" in blocks
        block = blocks["Goblin"]
        # Required keys from build_stat_block
        for key in ("dps", "total_damage", "duration", "hit_count",
                    "crit_rate", "heavy_rate", "crit_heavy_rate",
                    "skills", "top_hits", "hit_quality"):
            assert key in block, f"missing key: {key}"

    def test_single_target_damage_matches_sum(self):
        hits = [
            _make_hit("A", "BossA", 100, relative_time=0.0),
            _make_hit("B", "BossA", 200, relative_time=1.0),
            _make_hit("C", "BossA", 300, relative_time=2.0),
        ]
        blocks = build_target_blocks(hits)
        assert blocks["BossA"]["total_damage"] == 600

    def test_multi_target_sum_equals_overall(self):
        """Sum of per-target total_damage must equal sum of all hits' damage."""
        hits = [
            _make_hit("A", "BossA", 1000, relative_time=0.0),
            _make_hit("B", "BossB", 500, relative_time=0.5),
            _make_hit("C", "BossA", 800, relative_time=1.0),
            _make_hit("A", "BossB", 200, relative_time=1.5),
            _make_hit("D", "BossC", 100, relative_time=2.0),
        ]
        blocks = build_target_blocks(hits)
        assert set(blocks.keys()) == {"BossA", "BossB", "BossC"}
        total_from_blocks = sum(b["total_damage"] for b in blocks.values())
        total_from_hits = sum(h["damage"] for h in hits)
        assert total_from_blocks == total_from_hits

    def test_per_target_skills_reconcile(self):
        """Each target's per-skill damage sums must match the target total."""
        hits = [
            _make_hit("Slash", "GoblinA", 400, relative_time=0.0),
            _make_hit("Fireball", "GoblinA", 600, relative_time=1.0),
            _make_hit("Slash", "GoblinB", 200, relative_time=0.5),
        ]
        blocks = build_target_blocks(hits)
        for target, block in blocks.items():
            skill_total = sum(s["damage"] for s in block["skills"])
            assert skill_total == block["total_damage"], (
                f"{target}: skills sum {skill_total} != total_damage {block['total_damage']}"
            )

    def test_per_target_dps_uses_own_window(self):
        """Each target's DPS must be computed over its own first→last time window."""
        hits = [
            _make_hit("A", "BossA", 1000, relative_time=0.0),
            _make_hit("A", "BossA", 1000, relative_time=10.0),  # window = 10s
            _make_hit("B", "BossB", 500, relative_time=5.0),    # only 1 hit → window = 0
        ]
        blocks = build_target_blocks(hits)
        assert blocks["BossA"]["duration"] == 10.0
        assert blocks["BossA"]["dps"] == round(2000 / 10.0, 1)
        # BossB has one hit so duration=0 → dps=0
        assert blocks["BossB"]["duration"] == 0.0
        assert blocks["BossB"]["dps"] == 0.0

    def test_hit_quality_present_per_target(self):
        hits = [
            _make_hit("A", "Boss", 100, hit_type="kNormalHit", relative_time=0.0),
            _make_hit("A", "Boss", 0,   hit_type="kMiss",      relative_time=1.0),
        ]
        blocks = build_target_blocks(hits)
        hq = blocks["Boss"]["hit_quality"]
        assert hq["miss_count"] == 1
        assert hq["normal_count"] == 1

    @_skip_no_sample
    def test_gold_single_target_block_total_damage(self):
        """With one target the block's total_damage must match sum of all hits."""
        hits = _load_sample()
        total = sum(h["damage"] for h in hits)
        blocks = build_target_blocks(hits)
        assert len(blocks) == 1
        target_name = list(blocks.keys())[0]
        assert blocks[target_name]["total_damage"] == total

    @_skip_no_sample
    def test_gold_target_hit_quality_exact(self):
        """Per-target hit_quality must match the known gold distribution."""
        hits = _load_sample()
        blocks = build_target_blocks(hits)
        hq = list(blocks.values())[0]["hit_quality"]
        assert hq["miss_count"] == 1
        assert hq["crit_decision_count"] == 607
        assert hq["normal_count"] == 1152


# ---------------------------------------------------------------------------
# 3. build_overall_block() — new keys are present, parity keys unchanged
# ---------------------------------------------------------------------------

class TestBuildOverallBlockNewKeys:

    def test_overall_block_has_target_breakdown(self):
        hits = [
            _make_hit("A", "BossA", 100, relative_time=0.0),
            _make_hit("B", "BossB", 200, relative_time=1.0),
        ]
        block = build_overall_block(hits)
        assert "target_breakdown" in block
        assert "hit_quality" in block

    def test_overall_block_targets_unchanged(self):
        """The legacy ``targets`` list (damage share) must still be present and correct."""
        hits = [
            _make_hit("A", "BossA", 750, relative_time=0.0),
            _make_hit("B", "BossB", 250, relative_time=1.0),
        ]
        block = build_overall_block(hits)
        assert "targets" in block
        targets = {t["name"]: t for t in block["targets"]}
        assert targets["BossA"]["damage"] == 750
        assert targets["BossA"]["percent"] == 75.0
        assert targets["BossB"]["damage"] == 250
        assert targets["BossB"]["percent"] == 25.0

    def test_target_breakdown_sum_equals_total_damage(self):
        hits = [
            _make_hit("A", "T1", 1000, relative_time=0.0),
            _make_hit("B", "T2", 500, relative_time=1.0),
            _make_hit("C", "T1", 300, relative_time=2.0),
        ]
        block = build_overall_block(hits)
        breakdown_sum = sum(b["total_damage"] for b in block["target_breakdown"].values())
        assert breakdown_sum == block["total_damage"]

    @_skip_no_sample
    def test_gold_overall_block_backward_compat(self):
        """Existing parity keys (total_damage, crit_rate, etc.) must be unchanged."""
        hits = _load_sample()
        block = build_overall_block(hits)
        # These values are the same headline numbers verified by test_stats_parity.py
        # against the old backend (first_60s window); here we assert on ALL hits.
        assert block["hit_count"] == 1763
        assert block["total_damage"] == sum(h["damage"] for h in hits)
        # New keys present
        assert "target_breakdown" in block
        assert "hit_quality" in block
        # hit_quality on full block matches known distribution
        hq = block["hit_quality"]
        assert hq["miss_count"] == 1
        assert hq["crit_decision_count"] == 607


# ---------------------------------------------------------------------------
# 4. party_state path — get_results(include_target_breakdown=True)
# ---------------------------------------------------------------------------

class TestPartyStateTargetBreakdown:

    @staticmethod
    def _make_party_with_hits(hits_spec: list[tuple]) -> PartyState:
        """
        hits_spec: list of (target, damage, is_crit, is_heavy, skill, offset_secs)
        """
        ps = PartyState()
        ps.start_recording()
        base = datetime(2026, 6, 1, 12, 0, 0)
        for target, damage, is_crit, is_heavy, skill, offset in hits_spec:
            ps.record_hit(
                target, damage, is_crit, is_heavy,
                base + timedelta(seconds=offset),
                skill=skill, time=f"12:00:{offset:02d}",
            )
        return ps

    def test_include_false_no_breakdown(self):
        """Default call must NOT include target_breakdown (parity preserved)."""
        ps = self._make_party_with_hits([
            ("BossA", 1000, True, False, "Slash", 0),
            ("BossB", 500, False, False, "Arrow", 1),
        ])
        results = ps.get_results()
        assert "target_breakdown" not in results

    def test_include_true_has_breakdown(self):
        ps = self._make_party_with_hits([
            ("BossA", 1000, True, False, "Slash", 0),
            ("BossB", 500, False, False, "Arrow", 1),
        ])
        results = ps.get_results(include_target_breakdown=True)
        assert "target_breakdown" in results
        assert "BossA" in results["target_breakdown"]
        assert "BossB" in results["target_breakdown"]

    def test_breakdown_sum_equals_total(self):
        ps = self._make_party_with_hits([
            ("Goblin", 400, False, False, "Stab", 0),
            ("Goblin", 600, True, False, "Blast", 1),
            ("Orc", 200, False, True, "Cleave", 2),
        ])
        results = ps.get_results(include_target_breakdown=True)
        breakdown_sum = sum(
            b["total_damage"] for b in results["target_breakdown"].values()
        )
        assert breakdown_sum == results["total_damage"]

    def test_breakdown_per_target_skills(self):
        """Each target's skill list must reconcile to its total_damage."""
        ps = self._make_party_with_hits([
            ("BossA", 300, False, False, "SkillX", 0),
            ("BossA", 700, True, False, "SkillY", 1),
            ("BossB", 500, False, False, "SkillX", 2),
        ])
        results = ps.get_results(include_target_breakdown=True)
        for target_name, block in results["target_breakdown"].items():
            skill_sum = sum(s["damage"] for s in block["skills"])
            assert skill_sum == block["total_damage"], (
                f"{target_name}: skill_sum {skill_sum} != {block['total_damage']}"
            )

    def test_empty_encounter_breakdown(self):
        """Empty encounter with flag True returns empty dict, not error."""
        ps = PartyState()
        ps.start_recording()
        results = ps.get_results(include_target_breakdown=True)
        assert results["target_breakdown"] == {}

    def test_legacy_results_shape_unchanged(self):
        """Existing shape (targets list, total_damage, duration, fight_ts) is intact."""
        ps = self._make_party_with_hits([
            ("BossA", 1000, True, False, "A", 0),
            ("BossA", 500, False, False, "B", 2),
        ])
        results = ps.get_results()
        for key in ("targets", "total_damage", "duration", "fight_ts"):
            assert key in results, f"missing key: {key}"
