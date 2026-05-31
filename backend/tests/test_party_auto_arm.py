"""Contract 1–4 gate: auto-arm, fight_ts consistency, final frame shape + detail.

Tests for the 2-PC live test fix:
  * Combat hits post to the party WITHOUT a Start button click (Contract 1).
  * party_start_recording is idempotent — clicking it while already armed does NOT
    reset accumulators (Contract 1).
  * Every live party frame carries fight_ts consistently (Contract 2).
  * An idle timeout (> PARTY_IDLE_CLOSE_S) emits a party_final frame with full
    detail (Contract 3), including crit/heavy breakdown (Contract 4).
  * A wipe-boundary final frame carries the detail block too (Contract 4).
  * The existing reset/lagged-backlog protections are NOT weakened.
"""
from __future__ import annotations

import asyncio
import json
from datetime import datetime, timedelta
from typing import Optional

import pytest
import websockets

from dps_meter_server import PARTY_IDLE_CLOSE_S, DPSMeterServer
from party_state import PartyState


# ---------------------------------------------------------------------------
# Helpers shared by unit and integration tests
# ---------------------------------------------------------------------------

def _line(ts: str, skill: str, dmg: int, crit: bool, heavy: bool,
          target: str, caster: str = "Hero") -> str:
    return (f"{ts},DamageDone,{skill},1,{dmg},{int(crit)},{int(heavy)},"
            f"kHit,{caster},{target}")


HITS = [
    _line("20260530-12:00:00:000", "Fireball", 1000, True, False, "Boss"),
    _line("20260530-12:00:01:000", "Slash", 500, False, False, "Boss"),
    _line("20260530-12:00:02:000", "SmashHeavy", 800, False, True, "Boss"),
]


def _server_with_capture(tmp_path) -> tuple[DPSMeterServer, list[dict]]:
    """DPSMeterServer with _emit captured (no real loop needed for unit tests)."""
    srv = DPSMeterServer(str(tmp_path), port=0)
    emitted: list[dict] = []
    srv._emit = lambda payload: emitted.append(payload)
    return srv, emitted


# ===========================================================================
# Contract 1 — Auto-arm on first hit; party_start_recording is idempotent
# ===========================================================================

def test_auto_arm_on_first_hit_no_start_button(tmp_path):
    """Contract 1: hits flow into the party accumulator WITHOUT calling
    party_start_recording first, as long as _party_session_active is True."""
    srv, emitted = _server_with_capture(tmp_path)
    # Simulate what party_start_recording does — set the session active + code.
    # (In the real flow the frontend still sends party_start_recording to pass the
    # party_code; what changes is that we DON'T block hits until the user clicks it.)
    srv._party_session_active = True
    srv.party.party_code = "TESTROOM"
    assert srv.party.encounter_active is False  # not yet armed

    srv.ingest_lines(HITS)

    # Auto-arm should have fired on the first hit.
    assert srv.party.encounter_active is True
    # All 3 hits were recorded.
    assert srv.party.current is not None
    assert srv.party.current.total_damage() == 2300
    # party_live_hit frames were emitted.
    live_hits = [e for e in emitted if e.get("type") == "party_live_hit"]
    assert len(live_hits) == 3


def test_auto_arm_does_not_fire_without_session_active(tmp_path):
    """Contract 1 boundary: if _party_session_active is False (no party_code
    registered or session explicitly stopped), hits must NOT post to party."""
    srv, emitted = _server_with_capture(tmp_path)
    assert srv._party_session_active is False  # default

    srv.ingest_lines(HITS)

    assert srv.party.encounter_active is False
    assert srv.party.current is None
    assert not emitted


def test_party_start_recording_idempotent_does_not_reset(tmp_path):
    """Contract 1: calling party_start_recording while already armed (auto-armed or
    clicked during a fight) must NOT reset the accumulated hits."""
    srv, emitted = _server_with_capture(tmp_path)
    # Simulate: session started, first hit auto-armed it.
    srv._party_session_active = True
    srv.party.party_code = "ROOM"
    srv.ingest_lines(HITS)
    assert srv.party.encounter_active is True
    assert srv.party.current.total_damage() == 2300

    # Frontend sends party_start_recording (the old button click path).
    from dps_meter_server import _h_party_start_recording
    response = _h_party_start_recording(srv, {"command": "party_start_recording",
                                               "party_code": "ROOM"})
    assert response["type"] == "party_recording_started"
    assert response["status"]["encounter_active"] is True
    # Crucially: accumulated damage is NOT zeroed.
    assert response["status"]["total_damage"] == 2300
    assert srv.party.current.total_damage() == 2300


def test_party_start_recording_arms_when_not_active(tmp_path):
    """Contract 1: if not yet armed, party_start_recording arms + resets (original
    behaviour preserved)."""
    srv, emitted = _server_with_capture(tmp_path)
    from dps_meter_server import _h_party_start_recording
    response = _h_party_start_recording(srv, {"command": "party_start_recording",
                                               "party_code": "ROOM2"})
    assert response["status"]["encounter_active"] is True
    assert srv._party_session_active is True
    assert srv.party.party_code == "ROOM2"


def test_stop_recording_prevents_auto_rearm(tmp_path):
    """Contract 1: after party_stop_recording, subsequent hits must NOT re-arm
    (the user explicitly ended the session)."""
    srv, emitted = _server_with_capture(tmp_path)
    srv._party_session_active = True
    srv.party.party_code = "ROOM"
    srv.ingest_lines(HITS)  # auto-arm + 3 hits
    assert srv.party.encounter_active is True

    from dps_meter_server import _h_party_stop_recording
    _h_party_stop_recording(srv, {"command": "party_stop_recording"})
    assert srv.party.encounter_active is False
    assert srv._party_session_active is False

    # Clear emitted so we can check what NEW hits produce.
    emitted.clear()
    srv.ingest_lines(HITS)  # these should NOT re-arm
    assert srv.party.encounter_active is False
    party_frames = [e for e in emitted if e.get("type") == "party_live_hit"]
    assert not party_frames, "no party_live_hit should emit after stop"


# ===========================================================================
# Contract 2 — fight_ts in every live frame
# ===========================================================================

def test_fight_ts_in_every_live_frame(tmp_path):
    """Contract 2: every party_live_hit frame carries fight_ts in totals."""
    srv, emitted = _server_with_capture(tmp_path)
    srv._party_session_active = True
    srv.party.party_code = "ROOM"

    srv.ingest_lines(HITS)

    live_hits = [e for e in emitted if e.get("type") == "party_live_hit"]
    assert len(live_hits) == 3
    for i, frame in enumerate(live_hits):
        totals = frame["totals"]
        assert "fight_ts" in totals, f"frame {i} missing fight_ts"
        assert totals["fight_ts"] is not None, f"frame {i} has None fight_ts"
        assert isinstance(totals["fight_ts"], int), f"frame {i} fight_ts must be epoch ms int"


def test_fight_ts_consistent_across_all_frames(tmp_path):
    """Contract 2: fight_ts is the SAME epoch-ms value on every frame of one encounter."""
    srv, emitted = _server_with_capture(tmp_path)
    srv._party_session_active = True
    srv.party.party_code = "ROOM"

    srv.ingest_lines(HITS)

    live_hits = [e for e in emitted if e.get("type") == "party_live_hit"]
    fight_tss = [f["totals"]["fight_ts"] for f in live_hits]
    # All frames in one encounter must share the same fight_ts.
    assert len(set(fight_tss)) == 1, f"fight_ts changed mid-encounter: {fight_tss}"


def test_fight_ts_matches_first_hit_timestamp(tmp_path):
    """Contract 2: fight_ts == epoch-ms of the first hit's log timestamp."""
    from combat_log_parser import parse_line
    srv, emitted = _server_with_capture(tmp_path)
    srv._party_session_active = True
    srv.party.party_code = "ROOM"

    srv.ingest_lines(HITS)

    first_partial = parse_line(HITS[0])
    expected_ts = int(first_partial["_timestamp"].timestamp() * 1000)

    live_hits = [e for e in emitted if e.get("type") == "party_live_hit"]
    assert live_hits[0]["totals"]["fight_ts"] == expected_ts


def test_fight_ts_resets_on_wipe_boundary(tmp_path):
    """Contract 2: after a wipe boundary, new encounter's fight_ts reflects the NEW
    fight start, not the old one."""
    srv, emitted = _server_with_capture(tmp_path)
    # Use the real assignments so the 46s gap triggers a boundary.
    srv._party_session_active = True
    srv.party.party_code = "ROOM"
    srv._party_assignments = {"Boss": "raid_boss"}

    first_hit = _line("20260531-12:00:00:000", "Fireball", 1000, False, False, "Boss")
    second_hit = _line("20260531-12:00:47:000", "Slash", 500, False, False, "Boss")

    srv.ingest_lines([first_hit])
    srv.ingest_lines([second_hit])

    live_hits = [e for e in emitted if e.get("type") == "party_live_hit"
                 and not e.get("final")]
    assert len(live_hits) == 2
    ts_enc_a = live_hits[0]["totals"]["fight_ts"]
    ts_enc_b = live_hits[1]["totals"]["fight_ts"]
    assert ts_enc_a != ts_enc_b, "fight_ts must change on wipe boundary"


# ===========================================================================
# Contract 3 — Auto-close + final detail frame on idle timeout
# ===========================================================================

def test_idle_close_emits_party_final_type(tmp_path):
    """Contract 3: when _check_party_idle fires (combat silence), it emits a
    party_final frame with final=True."""
    srv, emitted = _server_with_capture(tmp_path)
    srv._party_session_active = True
    srv.party.party_code = "ROOM"
    srv.ingest_lines(HITS)
    assert srv.party.encounter_active is True

    # Simulate idle timeout: last hit was PARTY_IDLE_CLOSE_S + 1 seconds ago.
    srv._party_last_hit_time = datetime.now() - timedelta(
        seconds=PARTY_IDLE_CLOSE_S + 1)
    emitted.clear()

    srv._check_party_idle()

    # Encounter must be disarmed.
    assert srv.party.encounter_active is False
    # A party_final frame must have been emitted.
    finals = [e for e in emitted if e.get("type") == "party_final"]
    assert len(finals) == 1, f"expected 1 party_final, got: {emitted}"
    fin = finals[0]
    assert fin["final"] is True


def test_idle_close_does_not_fire_before_threshold(tmp_path):
    """Contract 3 boundary: silence shorter than threshold must NOT close."""
    srv, emitted = _server_with_capture(tmp_path)
    srv._party_session_active = True
    srv.party.party_code = "ROOM"
    srv.ingest_lines(HITS)

    # Silence is only half the threshold.
    srv._party_last_hit_time = datetime.now() - timedelta(
        seconds=PARTY_IDLE_CLOSE_S / 2)
    emitted.clear()

    srv._check_party_idle()

    assert srv.party.encounter_active is True
    assert not any(e.get("type") == "party_final" for e in emitted)


def test_idle_close_leaves_session_active_for_next_fight(tmp_path):
    """Contract 3: after an idle-close, _party_session_active stays True so the
    NEXT fight auto-arms when combat resumes (user is still in the room)."""
    srv, emitted = _server_with_capture(tmp_path)
    srv._party_session_active = True
    srv.party.party_code = "ROOM"
    srv.ingest_lines(HITS)

    srv._party_last_hit_time = datetime.now() - timedelta(
        seconds=PARTY_IDLE_CLOSE_S + 1)
    srv._check_party_idle()

    assert srv._party_session_active is True  # still in session
    assert srv.party.encounter_active is False  # disarmed

    # New hits should auto-arm again (new fight).
    emitted.clear()
    new_hits = [_line("20260530-14:00:00:000", "Fireball", 999, False, False, "Boss2")]
    srv.ingest_lines(new_hits)
    assert srv.party.encounter_active is True
    live_hits = [e for e in emitted if e.get("type") == "party_live_hit"]
    assert len(live_hits) == 1


def test_idle_close_not_checked_before_any_hit(tmp_path):
    """Contract 3: if no hits ever arrived (_party_last_hit_time is None),
    _check_party_idle must not close anything."""
    srv, emitted = _server_with_capture(tmp_path)
    srv._party_session_active = True
    srv.party.start_recording("ROOM")  # arm manually (no hits)
    assert srv._party_last_hit_time is None

    srv._check_party_idle()

    assert srv.party.encounter_active is True
    assert not emitted


# ===========================================================================
# Contract 4 — Final frame detail: per-target + per-skill with crit/heavy
# ===========================================================================

def test_idle_final_frame_has_fight_ts_and_encounter_id(tmp_path):
    """Contract 4: party_final carries both encounter_id and fight_ts at top level."""
    srv, emitted = _server_with_capture(tmp_path)
    srv._party_session_active = True
    srv.party.party_code = "ROOM"
    srv.ingest_lines(HITS)

    srv._party_last_hit_time = datetime.now() - timedelta(
        seconds=PARTY_IDLE_CLOSE_S + 1)
    emitted.clear()
    srv._check_party_idle()

    finals = [e for e in emitted if e.get("type") == "party_final"]
    assert len(finals) == 1
    fin = finals[0]
    assert fin["encounter_id"] is not None
    assert fin["fight_ts"] is not None
    assert isinstance(fin["fight_ts"], int)


def test_idle_final_frame_detail_shape(tmp_path):
    """Contract 4: detail block has targets, skills, total_damage, duration,
    rotation, fight_ts at detail level."""
    srv, emitted = _server_with_capture(tmp_path)
    srv._party_session_active = True
    srv.party.party_code = "ROOM"
    # Use HITS with skill + time threads through for C1b rotation.
    from combat_log_parser import parse_line
    for raw in HITS:
        partial = parse_line(raw)
        if srv._party_session_active and not srv.party.encounter_active:
            srv.party.arm()
        if srv.party.encounter_active:
            # Mirror the server's _record_party_hit: call record_hit with skill+time.
            srv.party.record_hit(
                target=partial["target"], damage=partial["damage"],
                is_crit=partial["is_crit"], is_heavy=partial["is_heavy"],
                hit_time=partial["_timestamp"],
                skill=partial["skill"], time=partial["time"],
            )

    srv._party_last_hit_time = datetime.now() - timedelta(
        seconds=PARTY_IDLE_CLOSE_S + 1)
    emitted.clear()
    srv._check_party_idle()

    finals = [e for e in emitted if e.get("type") == "party_final"]
    assert len(finals) == 1
    detail = finals[0]["detail"]
    # Core structure.
    assert "targets" in detail
    assert "skills" in detail
    assert "total_damage" in detail
    assert "duration" in detail
    assert "rotation" in detail
    assert "fight_ts" in detail
    # Values.
    assert detail["total_damage"] == 2300
    assert len(detail["targets"]) == 1  # only "Boss"
    target = detail["targets"][0]
    assert target["target"] == "Boss"
    assert target["total_damage"] == 2300
    assert "crit_rate" in target
    assert "heavy_rate" in target


def test_final_frame_detail_has_crit_and_heavy_damage_per_skill(tmp_path):
    """Contract 4: the skills array in detail includes crit_damage and
    heavy_damage — the components previously under-reported."""
    srv, emitted = _server_with_capture(tmp_path)
    srv._party_session_active = True
    srv.party.party_code = "ROOM"
    from combat_log_parser import parse_line
    for raw in HITS:
        partial = parse_line(raw)
        if not srv.party.encounter_active:
            srv.party.arm()
        srv.party.record_hit(
            target=partial["target"], damage=partial["damage"],
            is_crit=partial["is_crit"], is_heavy=partial["is_heavy"],
            hit_time=partial["_timestamp"],
            skill=partial["skill"], time=partial["time"],
        )

    srv._party_last_hit_time = datetime.now() - timedelta(
        seconds=PARTY_IDLE_CLOSE_S + 1)
    emitted.clear()
    srv._check_party_idle()

    finals = [e for e in emitted if e.get("type") == "party_final"]
    detail = finals[0]["detail"]
    by_skill = {s["name"]: s for s in detail["skills"]}

    # Fireball was a crit (1000 dmg) — crit_damage must be 1000.
    fireball = by_skill.get("Fireball")
    assert fireball is not None
    assert fireball["crit_damage"] == 1000
    assert fireball["heavy_damage"] == 0

    # SmashHeavy was a heavy (800 dmg) — heavy_damage must be 800.
    smash = by_skill.get("SmashHeavy")
    assert smash is not None
    assert smash["heavy_damage"] == 800
    assert smash["crit_damage"] == 0

    # Slash was neither.
    slash = by_skill.get("Slash")
    assert slash is not None
    assert slash["crit_damage"] == 0
    assert slash["heavy_damage"] == 0


def test_wipe_boundary_final_has_detail_block(tmp_path):
    """Contract 4: a wipe-boundary final (party_live_hit with final=True) also
    carries the detail block so the worker always gets full breakdown."""
    srv, emitted = _server_with_capture(tmp_path)
    srv._party_session_active = True
    srv.party.party_code = "ROOM"
    srv._party_assignments = {"Boss": "raid_boss"}

    # Two hits before the gap, one after (46s > 45s boss threshold = wipe).
    srv.ingest_lines([
        _line("20260531-12:00:00:000", "Fireball", 1000, True, False, "Boss"),
        _line("20260531-12:00:01:000", "Slash", 500, False, False, "Boss"),
    ])
    srv.ingest_lines([
        _line("20260531-12:00:47:000", "Smash", 800, False, True, "Boss"),
    ])

    # Find the wipe-boundary final frame (party_live_hit with final=True).
    finals = [e for e in emitted
              if e.get("type") == "party_live_hit" and e.get("final")]
    assert len(finals) == 1, "exactly one wipe-boundary final"
    fin = finals[0]
    assert "detail" in fin, "wipe-boundary final must carry the detail block"
    detail = fin["detail"]
    assert detail["total_damage"] == 1500  # encounter A's authoritative damage
    skills_by_name = {s["name"]: s for s in detail["skills"]}
    assert "Fireball" in skills_by_name
    assert skills_by_name["Fireball"]["crit_damage"] == 1000


def test_stop_recording_reply_includes_fight_ts(tmp_path):
    """Contract 2 + 3: the party_recording_stopped reply carries fight_ts in results
    so the caller can key the saved run without a separate query."""
    srv, emitted = _server_with_capture(tmp_path)
    srv._party_session_active = True
    srv.party.start_recording("ROOM")
    from combat_log_parser import parse_line
    first = parse_line(HITS[0])
    srv.party.record_hit(first["target"], first["damage"], first["is_crit"],
                         first["is_heavy"], first["_timestamp"])
    expected_ts = int(first["_timestamp"].timestamp() * 1000)

    from dps_meter_server import _h_party_stop_recording
    reply = _h_party_stop_recording(srv, {"command": "party_stop_recording"})
    assert reply["results"]["fight_ts"] == expected_ts


# ===========================================================================
# Contract 1 regression: existing reset/lagged-backlog protections intact
# ===========================================================================

def test_auto_arm_respects_reset_after_timestamp(tmp_path):
    """Contract 1 regression: auto-armed party must NOT receive hits that predate the
    reset_after_timestamp (the lagged-backlog protection must stay green)."""
    from combat_log_parser import parse_line

    srv, emitted = _server_with_capture(tmp_path)
    srv._party_session_active = True
    srv.party.party_code = "ROOM"

    # Set cutoff to "now" — any hit before this instant must be dropped.
    srv.reset_after_timestamp = datetime.now() + timedelta(seconds=100)

    # HITS timestamps are 2026-05-30 12:00:xx — far in the past relative to cutoff.
    srv.ingest_lines(HITS)

    # Because all hits are before the cutoff, party should NOT have been armed.
    # (The auto-arm code runs before the cutoff check for the stats buffer, but
    # the party record_hit call only happens after the cutoff check passes.)
    # Actually: auto-arm fires on the first hit that passes the cutoff filter.
    # Since ALL hits are dropped by the cutoff, auto-arm never fires.
    assert srv.party.encounter_active is False
    assert not emitted
