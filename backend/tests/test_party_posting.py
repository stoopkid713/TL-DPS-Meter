"""A3 gate: per-encounter party posting in the live emit path.

Drives ``DPSMeterServer._record_party_hit`` via ``ingest_lines`` (capturing
``_emit``) to assert the Phase-2 wiring:

* every ``party_live_hit`` carries the current encounter's ``encounter_id``;
* a gap/wipe boundary emits a ``final`` frame for the just-closed encounter (so its
  board is posted authoritatively) tagged with that encounter's id;
* the legacy continuous run (no boundary) still emits one encounter and NO ``final``
  frame — behaviour held constant.
"""
from __future__ import annotations

from dps_meter_server import DPSMeterServer


def _line(ts: str, skill: str, dmg: int, crit: bool, heavy: bool, target: str,
          caster: str = "Hero") -> str:
    return (f"{ts},DamageDone,{skill},1,{dmg},{int(crit)},{int(heavy)},"
            f"kHit,{caster},{target}")


def _armed_server(tmp_path, assignments):
    srv = DPSMeterServer(str(tmp_path), port=0)
    emitted: list[dict] = []
    srv._emit = lambda payload: emitted.append(payload)  # capture (no loop in tests)
    srv._party_assignments = assignments                 # what the start handler caches
    srv.party.start_recording("ROOM")
    return srv, emitted


def _live_hits(emitted):
    return [e for e in emitted if e.get("type") == "party_live_hit"]


def test_live_hit_carries_encounter_id(tmp_path):
    srv, emitted = _armed_server(tmp_path, {"Boss": "raid_boss"})
    srv.ingest_lines([_line("20260531-12:00:00:000", "Fireball", 1000, False, False, "Boss")])
    hits = _live_hits(emitted)
    assert len(hits) == 1
    assert hits[0]["totals"]["encounter_id"] == srv.party.current.encounter_id
    assert hits[0]["totals"]["encounter_id"] is not None
    assert hits[0].get("final") is not True


def test_gap_boundary_emits_final_for_closed_encounter(tmp_path):
    srv, emitted = _armed_server(tmp_path, {"Boss": "raid_boss"})
    # Encounter A: two hits 1s apart.
    srv.ingest_lines([
        _line("20260531-12:00:00:000", "Fireball", 1000, False, False, "Boss"),
        _line("20260531-12:00:01:000", "Slash", 500, False, False, "Boss"),
    ])
    # 46s gap (> 45s raid_boss threshold) -> encounter B opens; A is finalized.
    srv.ingest_lines([_line("20260531-12:00:47:000", "Smash", 800, False, True, "Boss")])

    assert len(srv.party.encounters) == 2
    enc_a, enc_b = srv.party.encounters

    finals = [e for e in _live_hits(emitted) if e.get("final")]
    assert len(finals) == 1, "exactly one final frame on the single boundary"
    fin = finals[0]
    assert fin["totals"]["encounter_id"] == enc_a.encounter_id
    assert fin["totals"]["total_damage"] == 1500  # A's authoritative board

    # The very last (non-final) live-hit belongs to encounter B.
    last_live = [e for e in _live_hits(emitted) if not e.get("final")][-1]
    assert last_live["totals"]["encounter_id"] == enc_b.encounter_id
    assert enc_a.encounter_id != enc_b.encounter_id


def test_continuous_run_no_final_single_encounter(tmp_path):
    """No gap -> one encounter, no final frame (behaviour constant)."""
    srv, emitted = _armed_server(tmp_path, {"Boss": "raid_boss"})
    srv.ingest_lines([
        _line("20260531-12:00:00:000", "Fireball", 1000, False, False, "Boss"),
        _line("20260531-12:00:05:000", "Slash", 500, False, False, "Boss"),
        _line("20260531-12:00:10:000", "Smash", 800, False, True, "Boss"),
    ])
    assert len(srv.party.encounters) == 1
    assert not any(e.get("final") for e in _live_hits(emitted))
    ids = {e["totals"]["encounter_id"] for e in _live_hits(emitted)}
    assert len(ids) == 1  # one stable encounter_id throughout
