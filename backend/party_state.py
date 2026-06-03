"""Local party-encounter accumulator (Phase 6 → Workstream B Phase 2: encounter-aware).

A faithful port of the old backend's ``PartyState`` (``server.py`` L1697-1806),
extended for multi-boss / per-encounter segmentation. It tracks per-target damage
during an active party recording and produces the two payloads the WS contract
needs: ``status`` (from :meth:`get_status`, also surfaced as the ``party_status``
field of every live ``stats`` broadcast) and ``results`` (from :meth:`get_results`,
returned by ``party_stop_recording`` and ridden along on ``party_live_hit``).

**Encounter model (Phase 2 / A2).** Internally a run is now a *list* of
:class:`PartyEncounter` accumulators with a *current* one, instead of a single flat
accumulator. The boundary predicate is the shared :mod:`encounter_boundary` (gap +
leader), so the live path and the file-history path agree.

**Behaviour held constant for the legacy call.** Segmentation only happens when a
caller passes the new ``encounter_id`` (leader / rule #1) or ``category`` (gap /
rule #3) arguments to :meth:`record_hit`, or calls :meth:`begin_encounter`. The
server still calls the 5-argument ``record_hit`` and bare ``get_results()`` today
(A3 wires the new args), so a continuous run produces exactly ONE encounter and
every output is byte-identical to the pre-A2 behaviour. The target-change boundary
(rule #2) is deliberately NOT implemented here — gap+leader cover the headline
wipe-and-refight case with fewer false splits.

NO transport coupling. This module only accumulates hits; the server emits
``party_live_hit`` over the socket. All numbers match the old implementation
exactly: ``duration`` floors at 1.0s once any hit lands, rates are ``count/hits*100``
(1 dp), per-target ``dps`` is ``damage/duration`` (1 dp). ``hit_time`` is a
``datetime`` so duration is a real wall-clock delta.
"""
from __future__ import annotations

from collections import defaultdict
from typing import Any, Optional

from combat_stats import build_stat_block, build_target_blocks, hit_quality
from encounter_boundary import is_new_encounter


def _new_target_stats() -> dict[str, int]:
    """Per-target accumulator factory (the old ``defaultdict`` lambda, L1714)."""
    return {"damage": 0, "hits": 0, "crits": 0, "heavies": 0}


class PartyEncounter:
    """One boss-kill attempt: the per-target accumulator scoped to a single segment.

    ``encounter_id`` is ``str(fight_ts)`` (Foundations F1) — epoch-ms of the first
    hit — assigned lazily on the first recorded hit unless a leader-supplied id was
    passed in. Carries the exact per-target math the flat accumulator used to do.
    """

    def __init__(self, encounter_id: Optional[str] = None) -> None:
        self.encounter_id: Optional[str] = encounter_id
        self.first_hit_time = None
        self.last_hit_time = None
        self.target_damage: dict[str, dict[str, int]] = defaultdict(_new_target_stats)
        # Full hit-by-hit retention (Phase 3 / C1b). One dict per hit in the SAME
        # shape the solo path emits (``combat_log_parser.finalize_hit`` →
        # ``combat_stats`` rotation), so the solo renderers (``_skills`` /
        # ``_targets`` / ``_gap_stats`` / ``renderRotationChart``) consume it
        # unchanged on drill-down. Emitted as ``rotation`` only on the final post
        # (``results(include_hits=True)``) — never on the light live tick.
        self.hits: list[dict] = []

    def record(self, target, damage, is_crit, is_heavy, hit_time,
               skill: Optional[str] = None, time: Optional[str] = None) -> None:
        if self.first_hit_time is None:
            self.first_hit_time = hit_time
        self.last_hit_time = hit_time
        stats = self.target_damage[target]
        stats["damage"] += damage
        stats["hits"] += 1
        if is_crit:
            stats["crits"] += 1
        if is_heavy:
            stats["heavies"] += 1
        # Retain the raw hit (solo-hit shape). ``relative_time`` is seconds from the
        # encounter's first hit (1 dp, matching ``ROUND_REL_TIME``); ``first_hit_time``
        # is set above so the first hit is 0.0.
        self.hits.append({
            "time": time,
            "relative_time": round((hit_time - self.first_hit_time).total_seconds(), 1),
            "skill": skill,
            "target": target,
            "damage": damage,
            "is_crit": is_crit,
            "is_heavy": is_heavy,
        })

    def fight_ts(self) -> Optional[int]:
        """Epoch-ms of the first hit (the encounter key); ``None`` before any hit."""
        return int(self.first_hit_time.timestamp() * 1000) if self.first_hit_time else None

    def total_damage(self) -> int:
        return sum(v["damage"] for v in self.target_damage.values())

    def duration(self) -> float:
        """Wall-clock span, floored at 1.0s (0 before any hit) — old ``get_duration``."""
        first, last = self.first_hit_time, self.last_hit_time
        if not (first and last):
            return 0
        return max((last - first).total_seconds(), 1.0)

    def results(self, include_hits: bool = False,
               include_target_breakdown: bool = False) -> dict:
        """Final per-target breakdown + totals — the ``results`` payload shape.

        Byte-identical to the pre-A2 ``PartyState.get_results`` output (per-target
        keys, rounding, ``fight_ts``) when ``include_hits`` and
        ``include_target_breakdown`` are False (the defaults, and the live-tick path).

        With ``include_hits=True`` (the final post only) a ``rotation`` key carries
        the full retained hit list (Phase 3 / C1b) — a copy of each :attr:`hits`
        dict, in solo-hit shape, for the room to store opaquely and serve on
        drill-down (C1a/C3).

        With ``include_target_breakdown=True`` a ``target_breakdown`` key carries the
        full per-target stat blocks from ``build_target_blocks(self.hits)`` — same
        shape as the solo ``build_overall_block`` ``target_breakdown`` key, so the
        future UI can render per-target drill-down with identical renderer logic.
        Note: party hits do not carry ``hit_type`` (not plumbed through
        ``record_hit``), so ``hit_quality`` within each per-target block will show
        zeroes for hit-type counts; the damage/crit/skill/dps fields are correct.
        """
        fight_ts = self.fight_ts()
        if not self.target_damage:
            empty = {"targets": [], "total_damage": 0, "duration": 0, "fight_ts": fight_ts}
            if include_hits:
                empty["rotation"] = []
            if include_target_breakdown:
                empty["target_breakdown"] = {}
            return empty
        duration = self.duration()
        total_damage = self.total_damage()
        # Index hits by target once for the per-target stat-block pass below.
        hits_by_target: dict[str, list[dict]] = defaultdict(list)
        for h in self.hits:
            hits_by_target[h["target"]].append(h)

        targets = []
        for target, stats in self.target_damage.items():
            damage = stats["damage"]
            raw_hits = stats["hits"]
            dps = (damage / duration) if duration > 0 else 0
            # Route rates through build_stat_block so party == solo (same adjusted
            # crit/heavy logic, plus the combined crit_heavy stat the solo meter
            # produces).  Skill settings are not available per-member in the party
            # path today (no skill_settings arg here), so adjusted == raw — which
            # matches the scenario verified by sim_party --scenario crit-heavy-parity.
            target_hits = hits_by_target.get(target, [])
            sb = build_stat_block(target_hits) if target_hits else {}
            # crit_heavy_count: hits where BOTH flags are True (the same numerator
            # build_stat_block uses for crit_heavy_rate, exposed separately for the
            # pinned post_fight contract the screens lane renders).
            crit_heavy_count = sum(
                1 for h in target_hits if h["is_crit"] and h["is_heavy"]
            )
            targets.append({
                "target": target,
                "total_damage": damage,
                "duration": round(duration, 1),
                "dps": round(dps, 1),
                "hits": raw_hits,
                "crit_rate": sb.get("crit_rate", 0.0),
                "heavy_rate": sb.get("heavy_rate", 0.0),
                "crit_heavy_rate": sb.get("crit_heavy_rate", 0.0),
                "crit_heavy_count": crit_heavy_count,
            })
        out = {
            "targets": targets,
            "total_damage": total_damage,
            "duration": round(duration, 1),
            "fight_ts": fight_ts,
        }
        if include_hits:
            out["rotation"] = [dict(h) for h in self.hits]
        if include_target_breakdown:
            out["target_breakdown"] = build_target_blocks(self.hits)
        return out

    def meta(self) -> dict:
        """Lightweight enumeration entry for the room/UI encounter list (A4)."""
        return {
            "encounter_id": self.encounter_id,
            "fight_ts": self.fight_ts(),
            "total_damage": self.total_damage(),
            "target_count": len(self.target_damage),
            "started_at": self.first_hit_time.isoformat() if self.first_hit_time else None,
        }


class PartyState:
    """Tracks hits during an active party recording. Pure local state, no IO.

    Holds a list of :class:`PartyEncounter` (finished + current). The legacy
    single-encounter contract is preserved: with the 5-argument ``record_hit`` and
    a bare ``get_results()``, the run stays one encounter and outputs are unchanged.
    """

    def __init__(self) -> None:
        self.encounter_active: bool = False
        self.party_code: Optional[str] = None
        self.reset_stats()

    def reset_stats(self) -> None:
        """Clear accumulated encounters (does NOT change ``encounter_active``)."""
        self.encounters: list[PartyEncounter] = []
        self.current: Optional[PartyEncounter] = None

    def start_recording(self, party_code: Optional[str] = None) -> None:
        """Begin a recording: arm, stamp the code, and zero the accumulators."""
        self.encounter_active = True
        self.party_code = party_code
        self.reset_stats()

    def arm(self) -> None:
        """Arm without resetting accumulators (auto-arm path — no button click needed).

        Called by the server when the first combat hit arrives and the party_code is
        already set but encounter_active is still False (the user joined a room but
        hadn't clicked Start, or Start was idempotent on a running encounter).
        Does NOT touch encounters / current — the first call to record_hit will open
        the initial encounter lazily as before.
        """
        self.encounter_active = True

    def stop_recording(self, include_hits: bool = False) -> dict:
        """Disarm and return the final :meth:`get_results` snapshot (current encounter).

        ``include_hits=True`` carries the full ``rotation`` hit slice for the final
        post (Phase 3 / C1b)."""
        self.encounter_active = False
        return self.get_results(include_hits=include_hits)

    def clear_party(self) -> None:
        """Leave the party session: null ``party_code`` and wipe all accumulators.

        Called when the user leaves or closes a party room.  After this call,
        ``get_status()`` emits ``party_code=None`` so any subsequent status-sync on
        the frontend sees a clean slate — no stale code that could clobber a freshly
        generated create/join code.  Also disarms the encounter so auto-arm cannot
        fire for a room that no longer exists.
        """
        self.encounter_active = False
        self.party_code = None
        self.reset_stats()

    def _open_encounter(self, encounter_id: Optional[str] = None) -> PartyEncounter:
        enc = PartyEncounter(encounter_id)
        self.encounters.append(enc)
        self.current = enc
        return enc

    def begin_encounter(self, encounter_id: str) -> PartyEncounter:
        """Close the current encounter and open a new one under ``encounter_id``.

        The leader-coordinated boundary (Foundations F1b rule #1) and the
        server-assigned autostart fallback. Idempotent: re-issuing the id that is
        already current is a no-op (so a re-broadcast doesn't spawn an empty twin).
        """
        if self.current is not None and self.current.encounter_id == encounter_id:
            return self.current
        return self._open_encounter(encounter_id)

    def record_hit(self, target, damage, is_crit, is_heavy, hit_time,
                   encounter_id: Optional[str] = None,
                   category: Optional[str] = None,
                   skill: Optional[str] = None, time: Optional[str] = None) -> None:
        """Fold one hit into the current encounter, rolling to a new one at a boundary.

        Boundary rules (open a fresh encounter *before* folding the hit):

        * **encounter_id** given and differs from current (or no current) — leader /
          explicit boundary (rule #1).
        * else **category** given and the inter-hit gap exceeds the category
          threshold — gap / wipe boundary (rule #3), via
          :func:`encounter_boundary.is_new_encounter`.

        With neither argument (today's server call) no boundary is ever crossed, so
        the run is a single encounter and behaviour is unchanged. No-op when not
        recording.
        """
        if not self.encounter_active:
            return
        if encounter_id is not None:
            if self.current is None or self.current.encounter_id != encounter_id:
                self._open_encounter(encounter_id)
        elif self.current is None:
            self._open_encounter()
        elif (category is not None and self.current.last_hit_time is not None
              and is_new_encounter(self.current.last_hit_time, hit_time, category)):
            self._open_encounter()

        self.current.record(target, damage, is_crit, is_heavy, hit_time,
                            skill=skill, time=time)
        # Lazily key the encounter to its first hit (Foundations F1) when no leader
        # id was supplied.
        if self.current.encounter_id is None:
            self.current.encounter_id = str(self.current.fight_ts())

    def get_duration(self) -> float:
        """Wall-clock span of the current encounter (0 before any hit)."""
        return self.current.duration() if self.current else 0

    def get_results(self, encounter_id: Optional[str] = None,
                    include_hits: bool = False,
                    include_target_breakdown: bool = False) -> dict:
        """Per-target breakdown + totals for one encounter (the ``results`` payload).

        Defaults to the **current** encounter (the legacy behaviour); pass an
        ``encounter_id`` to fetch a specific past encounter (A4 enumeration). Returns
        the empty shape when the target encounter doesn't exist / nothing recorded.

        ``include_hits=True`` (final post only) adds the full ``rotation`` hit list
        (Phase 3 / C1b); the default keeps the live tick light + byte-identical.

        ``include_target_breakdown=True`` adds a ``target_breakdown`` key with full
        per-target stat blocks (spec §2).  Off by default so the live tick stays
        byte-identical and lightweight.
        """
        enc = self._find(encounter_id) if encounter_id is not None else self.current
        if enc is None:
            empty = {"targets": [], "total_damage": 0, "duration": 0, "fight_ts": None}
            if include_hits:
                empty["rotation"] = []
            if include_target_breakdown:
                empty["target_breakdown"] = {}
            return empty
        return enc.results(include_hits=include_hits,
                           include_target_breakdown=include_target_breakdown)

    def _find(self, encounter_id: str) -> Optional[PartyEncounter]:
        for enc in self.encounters:
            if enc.encounter_id == encounter_id:
                return enc
        return None

    def list_encounters(self) -> list[dict]:
        """Metadata for every encounter, oldest first — room/UI enumeration (A4)."""
        return [enc.meta() for enc in self.encounters]

    def get_status(self) -> dict:
        """Lightweight live state (the ``status`` / ``party_status`` payload).

        Totals reflect the **current** encounter — identical to the pre-A2 flat
        accumulator for a single-encounter run.
        """
        total_damage = self.current.total_damage() if self.current else 0
        target_count = len(self.current.target_damage) if self.current else 0
        return {
            "encounter_active": self.encounter_active,
            "party_code": self.party_code,
            "total_damage": total_damage,
            "target_count": target_count,
        }
