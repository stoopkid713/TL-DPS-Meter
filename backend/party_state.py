"""Local party-encounter accumulator (Phase 6).

A faithful port of the old backend's ``PartyState`` (``server.py`` L1697-1806). It
tracks per-target damage during an active party recording and produces the two
payloads the WS contract needs: ``status`` (from :meth:`get_status`, also surfaced
as the ``party_status`` field of every live ``stats`` broadcast) and ``results``
(from :meth:`get_results`, returned by ``party_stop_recording``).

NO transport coupling. The old class docstring noted: "All party logic (create,
join, broadcast) is handled in frontend via Supabase. Server just tracks hits and
provides stats." This module keeps that boundary — it only accumulates hits. The
server emits ``party_live_hit`` over the socket; swapping Supabase for a Cloudflare
relay (Workstream B) is a frontend/transport change that never touches this class.

All numbers match the old implementation exactly: ``duration`` floors at 1.0s once
any hit lands, rates are ``count/hits*100`` (1 dp), per-target ``dps`` is
``damage/duration`` (1 dp). ``hit_time`` is a ``datetime`` so duration is a real
wall-clock delta.
"""
from __future__ import annotations

from collections import defaultdict
from typing import Any, Optional


def _new_target_stats() -> dict[str, int]:
    """Per-target accumulator factory (the old ``defaultdict`` lambda, L1714)."""
    return {"damage": 0, "hits": 0, "crits": 0, "heavies": 0}


class PartyState:
    """Tracks hits during an active party encounter. Pure local state, no IO."""

    def __init__(self) -> None:
        self.encounter_active: bool = False
        self.party_code: Optional[str] = None
        self.reset_stats()

    def reset_stats(self) -> None:
        """Clear accumulated hits (does NOT change ``encounter_active``)."""
        self.party_stats: dict[str, Any] = {
            "first_hit_time": None,
            "last_hit_time": None,
            "target_damage": defaultdict(_new_target_stats),
        }

    def start_recording(self, party_code: Optional[str] = None) -> None:
        """Begin a recording: arm, stamp the code, and zero the accumulators."""
        self.encounter_active = True
        self.party_code = party_code
        self.reset_stats()

    def stop_recording(self) -> dict:
        """Disarm and return the final :meth:`get_results` snapshot."""
        self.encounter_active = False
        return self.get_results()

    def record_hit(self, target, damage, is_crit, is_heavy, hit_time) -> None:
        """Fold one hit into the per-target totals. No-op when not recording."""
        if not self.encounter_active:
            return
        if self.party_stats["first_hit_time"] is None:
            self.party_stats["first_hit_time"] = hit_time
        self.party_stats["last_hit_time"] = hit_time
        stats = self.party_stats["target_damage"][target]
        stats["damage"] += damage
        stats["hits"] += 1
        if is_crit:
            stats["crits"] += 1
        if is_heavy:
            stats["heavies"] += 1

    def get_duration(self) -> float:
        """Wall-clock span of the recording, floored at 1.0s (0 before any hit)."""
        first = self.party_stats["first_hit_time"]
        last = self.party_stats["last_hit_time"]
        if not (first and last):
            return 0
        delta = (last - first).total_seconds()
        return max(delta, 1.0)

    def get_results(self) -> dict:
        """Final per-target breakdown + totals (the ``results`` payload)."""
        target_damage = self.party_stats["target_damage"]
        if not target_damage:
            return {"targets": [], "total_damage": 0, "duration": 0}
        duration = self.get_duration()
        total_damage = sum(v["damage"] for v in target_damage.values())
        targets = []
        for target, stats in target_damage.items():
            damage = stats["damage"]
            hits = stats["hits"]
            crits = stats["crits"]
            heavies = stats["heavies"]
            crit_rate = (crits / hits * 100) if hits > 0 else 0
            heavy_rate = (heavies / hits * 100) if hits > 0 else 0
            dps = (damage / duration) if duration > 0 else 0
            targets.append({
                "target": target,
                "total_damage": damage,
                "duration": round(duration, 1),
                "dps": round(dps, 1),
                "hits": hits,
                "crit_rate": round(crit_rate, 1),
                "heavy_rate": round(heavy_rate, 1),
            })
        return {
            "targets": targets,
            "total_damage": total_damage,
            "duration": round(duration, 1),
        }

    def get_status(self) -> dict:
        """Lightweight live state (the ``status`` / ``party_status`` payload)."""
        target_damage = self.party_stats["target_damage"]
        total_damage = sum(v["damage"] for v in target_damage.values())
        target_count = len(target_damage)
        return {
            "encounter_active": self.encounter_active,
            "party_code": self.party_code,
            "total_damage": total_damage,
            "target_count": target_count,
        }
