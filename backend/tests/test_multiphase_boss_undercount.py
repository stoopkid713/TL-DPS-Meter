"""Regression test: multi-phase boss undercount (Calanthia / Calanthia of Destruction).

CONFIRMED BUG (2026-06-02, lane BackendTrace):

A 2-phase archboss fight (e.g. Calanthia -> Calanthia of Destruction) produces TWO
distinct target names in the targets[] array posted to the Cloudflare worker:

    targets = [
        { target: "Calanthia",                total_damage: 18_420_000 },
        { target: "Calanthia of Destruction", total_damage: 28_050_000 },
    ]

The worker's buildScoreboard() calls detectBoss() which crowns ONE target (the highest
aggregate damage across all members — here "Calanthia of Destruction" at 28.05M). It
then filters each member's submission down to ONLY that target:

    const hit = sub.targets.find((t) => norm(t.target) === bossKey);

Phase-1 damage ("Calanthia", 18.42M) is excluded as if it were trash/adds.

OBSERVED LIVE (Calanthia run, 3-person party):
    Phase 1  "Calanthia":               18.42M
    Phase 2  "Calanthia of Destruction": 28.05M
    Ground truth (both phases):         46.47M  <- what Game Combat Analyzer shows
    Scoreboard shows (phase 2 only):    28.05M  <- what the app showed
    Undercount:                         ~18.4M  (39.6% of total)

    The Compare tab shows 46.70M because it lets the user SUM encounters manually
    from the encounter list — it doesn't go through detectBoss filtering.

BACKEND SIDE (party_state.py):
    - party_state correctly accumulates BOTH phases into ONE encounter when category=archboss
      (archboss uses same-calendar-day grouping, NOT gap-based, so no boundary fires even
      with a 2+ minute phase-transition silence).
    - The targets[] array in get_results() carries BOTH phase targets with correct totals.
    - Backend is NOT the bug.

WORKER SIDE (workers/party/src/index.js  buildScoreboard(), detectBoss()):
    - detectBoss() picks one winner from known bosses (highest aggregate).
    - buildScoreboard() then calls targets.find() — a SINGLE match — against the winner.
    - All other phase targets are silently excluded.
    FIX LOCATION: workers/party/src/index.js
    Recommended fix: when detecting a multi-phase archboss, sum ALL targets whose
    normalized name matches ANY known phase of the boss (or sum all known-boss targets
    for the same boss encounter), not just the single highest-named target.
    Simplest approach: treat all "archboss" targets in the submission as the boss pool
    and sum them per member, rather than picking one name via find().

RELATIONSHIP TO SWITCHER-FLOOD OVER-SEGMENTATION:
    The switcher-flood over-segmentation creates EXTRA encounter rows in the worker's
    encounter list (one per target-name switch in the live stream).  That is a different
    defect than this one:
    - Switcher-flood: encounter_boundary / party_state rolling too eagerly
      (rule #2 target-change, if re-enabled, or rule #3 gap too short)
    - Multi-phase undercount: correct single encounter, but worker-side boss filter
      excludes all but the winning target name.
    Both can cause an undercount on the scoreboard, but via different mechanisms.
    The switcher-flood also generates orphan encounter rows (no submissions), whereas
    multi-phase undercount always has correct data — it's just filtered wrong.

These tests are marked xfail because they document the CONFIRMED, NOT-YET-FIXED bug.
Remove xfail when the worker buildScoreboard fix lands.
"""
from __future__ import annotations

from datetime import datetime, timedelta

import pytest

from party_state import PartyState


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

CALANTHIA = "Calanthia"
CALANTHIA_P2 = "Calanthia of Destruction"

# Live numbers from the real run (context brief):
PHASE1_DAMAGE = 18_420_000
PHASE2_DAMAGE = 28_050_000
GROUND_TRUTH = PHASE1_DAMAGE + PHASE2_DAMAGE  # 46_470_000


def _build_two_phase_party_state() -> tuple[PartyState, dict]:
    """Build a PartyState after a full 2-phase archboss fight.

    Returns (ps, final_results) where final_results is what the client would
    post to the worker as the targets[] array.
    """
    ps = PartyState()
    ps.start_recording("TEST_CALANTHIA")

    t0 = datetime(2026, 5, 31, 20, 0, 0)

    # Phase 1: 6 hits to Calanthia, total PHASE1_DAMAGE
    hit_dmg_p1 = PHASE1_DAMAGE // 6
    for i in range(6):
        ps.record_hit(
            CALANTHIA, hit_dmg_p1, False, False,
            t0 + timedelta(seconds=i * 5),
            category="archboss", skill="test_skill", time=str(t0),
        )

    # 2-minute phase-transition silence (well within same calendar day)
    t_p2 = t0 + timedelta(seconds=30 + 120)

    # Phase 2: 6 hits to Calanthia of Destruction, total PHASE2_DAMAGE
    hit_dmg_p2 = PHASE2_DAMAGE // 6
    for i in range(6):
        ps.record_hit(
            CALANTHIA_P2, hit_dmg_p2, False, False,
            t_p2 + timedelta(seconds=i * 5),
            category="archboss", skill="test_skill", time=str(t_p2),
        )

    final_results = ps.get_results()
    return ps, final_results


# ---------------------------------------------------------------------------
# Backend assertions (these PASS — backend is NOT the bug)
# ---------------------------------------------------------------------------

class TestBackendAccumulationCorrect:
    """party_state correctly accumulates both phases into ONE encounter.

    These tests verify the backend is clean — the undercount is downstream
    in the worker's buildScoreboard logic.
    """

    def test_archboss_same_day_no_boundary_single_encounter(self):
        """Same-day archboss hits NEVER trigger a gap boundary — one encounter."""
        ps, _ = _build_two_phase_party_state()
        assert len(ps.encounters) == 1, (
            f"expected 1 encounter for same-day archboss, got {len(ps.encounters)}"
        )

    def test_both_phases_in_targets(self):
        """The targets[] array carries BOTH phase targets."""
        _, results = _build_two_phase_party_state()
        target_names = {t["target"] for t in results["targets"]}
        assert CALANTHIA in target_names, f"Phase 1 target missing from results: {target_names}"
        assert CALANTHIA_P2 in target_names, f"Phase 2 target missing from results: {target_names}"

    def test_backend_total_damage_correct(self):
        """Backend total_damage == sum of both phases (not just one)."""
        _, results = _build_two_phase_party_state()
        assert results["total_damage"] == GROUND_TRUTH, (
            f"backend total_damage {results['total_damage']:,} != ground truth {GROUND_TRUTH:,}"
        )

    def test_phase1_target_damage(self):
        """Phase-1 target damage is correct in the targets array."""
        _, results = _build_two_phase_party_state()
        p1 = next((t for t in results["targets"] if t["target"] == CALANTHIA), None)
        assert p1 is not None, "Phase-1 target missing"
        assert p1["total_damage"] == PHASE1_DAMAGE

    def test_phase2_target_damage(self):
        """Phase-2 target damage is correct in the targets array."""
        _, results = _build_two_phase_party_state()
        p2 = next((t for t in results["targets"] if t["target"] == CALANTHIA_P2), None)
        assert p2 is not None, "Phase-2 target missing"
        assert p2["total_damage"] == PHASE2_DAMAGE


# ---------------------------------------------------------------------------
# Worker scoreboard simulation (xfail — documents the bug)
# ---------------------------------------------------------------------------

def _simulate_worker_scoreboard(targets: list[dict], known_bosses: dict) -> int:
    """Minimal Python port of the worker's buildScoreboard boss-detection + filter.

    Mirrors workers/party/src/index.js  detectBoss() + the targets.find() filter.
    Returns the damage shown on the scoreboard for one member's submission.
    """
    def norm(s):
        return str(s or "").strip().lower()

    # detectBoss: pick the known boss with highest aggregate damage
    agg: dict[str, dict] = {}
    for t in targets:
        key = norm(t["target"])
        if key not in agg:
            agg[key] = {"name": t["target"], "damage": 0}
        agg[key]["damage"] += t["total_damage"]

    known_keys = [k for k in agg if k in known_bosses]
    if not known_keys:
        return 0  # no boss detected

    known_keys.sort(key=lambda k: -agg[k]["damage"])
    boss_key = known_keys[0]

    # buildScoreboard: targets.find() — only the ONE winning target
    hit = next((t for t in targets if norm(t["target"]) == boss_key), None)
    return hit["total_damage"] if hit else 0


@pytest.mark.xfail(
    reason=(
        "BUG: worker buildScoreboard only sums the single detectBoss winner target, "
        "excluding all other phase targets. Fix: sum all known-boss targets per member, "
        "not just the one with the highest name. "
        "Fix location: workers/party/src/index.js  buildScoreboard() / detectBoss(). "
        "Remove xfail when the worker fix lands."
    ),
    strict=True,
)
def test_worker_scoreboard_shows_combined_phases():
    """Worker scoreboard should show BOTH phases combined, not just the winning phase.

    This test FAILS until buildScoreboard is fixed to sum all known-boss phase targets
    instead of using targets.find() which picks only one.
    """
    _, results = _build_two_phase_party_state()
    targets = results["targets"]

    # Minimal KNOWN_BOSSES — just the two Calanthia phases (from index.js)
    known_bosses = {
        "calanthia": "archboss",
        "calanthia of destruction": "archboss",
    }

    shown_damage = _simulate_worker_scoreboard(targets, known_bosses)

    # XFAIL: the simulation returns only PHASE2_DAMAGE (28.05M), not GROUND_TRUTH (46.47M)
    assert shown_damage == GROUND_TRUTH, (
        f"Scoreboard shows {shown_damage:,} but ground truth is {GROUND_TRUTH:,}. "
        f"Phase-1 damage ({PHASE1_DAMAGE:,}) is excluded by the targets.find() filter."
    )


@pytest.mark.xfail(
    reason=(
        "Documents the EXACT undercount magnitude: 18.42M / 39.6% of ground truth. "
        "The scoreboard shows only phase-2 damage (28.05M) not the combined 46.47M. "
        "Remove xfail when the worker fix lands."
    ),
    strict=True,
)
def test_worker_undercount_magnitude():
    """Documents the magnitude of the multi-phase undercount.

    With the current code: shown = 28.05M, ground truth = 46.47M.
    Undercount = 18.42M = 39.6% of total boss damage.
    """
    _, results = _build_two_phase_party_state()
    targets = results["targets"]

    known_bosses = {
        "calanthia": "archboss",
        "calanthia of destruction": "archboss",
    }

    shown_damage = _simulate_worker_scoreboard(targets, known_bosses)
    undercount = GROUND_TRUTH - shown_damage

    # This assert will PASS (documenting the bug), making the outer xfail trigger
    # because the test as a whole claims something that isn't true:
    assert undercount == 0, (
        f"Undercount is {undercount:,} ({undercount/GROUND_TRUTH*100:.1f}% of total). "
        f"Scoreboard shows {shown_damage:,}, ground truth {GROUND_TRUTH:,}."
    )
