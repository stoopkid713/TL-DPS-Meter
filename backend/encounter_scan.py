"""Log-reconstruction for the Encounters tab — faithful port of the old backend.

Two families, both re-parse a *single* combat-log file (the active log file,
``self.log_file`` in the old exe) rather than the live accumulator:

* :func:`parse_encounters_from_log` (+ the category splitters
  :func:`parse_archboss_encounters` / :func:`parse_boss_encounters` /
  :func:`parse_adds_encounters` / :func:`build_encounter_dict`) — the
  ``get_encounter_history`` list.
* :func:`parse_encounter_details` — the per-hit ``hit_log`` for one encounter
  window, used by the Encounters-row breakdown click.

These deliberately do NOT reuse ``combat_log_parser`` / ``combat_stats``: the old
backend's encounter-scan path parses with **second-resolution** timestamps
(milliseconds dropped), filters by **target only** (no caster filter), uses
**raw** crit/heavy flags (``skill_settings`` is accepted but ignored, exactly as
the old code), and emits a **distinct, smaller** stat shape than the live
``build_live_stats`` (unrounded top-level rates, ``gap_stats: {}``,
single-target ``targets`` without ``percent``). Reconstructed from
``server.disasm.txt`` ``parse_encounters_from_log`` (L436) /
``parse_encounter_details`` (L682) and the ``handle_command`` serializers.
"""
from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Optional

from encounter_boundary import (
    ADDS_GAP_THRESHOLD as _ADDS_GAP_THRESHOLD,
    BOSS_CATEGORIES as _BOSS_CATEGORIES,
    BOSS_GAP_THRESHOLD as _BOSS_GAP_THRESHOLD,
    OTHER_GAP_THRESHOLD as _OTHER_GAP_THRESHOLD,
    category_for_target,
    gap_threshold_for_category,
)

# Category routing (disasm L1690-1848): archboss -> same-day grouping; the three
# boss categories -> 45s gap split; adds -> 30s; everything else -> 30s gap split.
# The thresholds + category lookup now live in ``encounter_boundary`` (shared with
# the live party-segmentation path); re-exported here under their original private
# names so existing references stay valid.

# Details window around the requested start_time (disasm L693-694).
_DETAILS_WINDOW_BEFORE = timedelta(seconds=10)
_DETAILS_WINDOW_AFTER = timedelta(minutes=10)

_MIN_PARTS = 10
_LOG_TYPE_DAMAGE = "DamageDone"


def _parse_log_timestamp(timestamp_str: str) -> datetime:
    """``YYYYMMDD-HH:MM:SS[:mmm]`` -> second-resolution datetime (millis dropped).

    Matches the old encounter-scan parsing (disasm L496-508 / L750-758): it
    splits ``HH:MM:SS:mmm`` on ``:`` and uses only the first three fields, so the
    millisecond component never reaches the datetime. (The live parser keeps
    millis; the encounter-scan path does not — preserved for parity.)
    """
    date_part, time_part = timestamp_str.split("-")
    year = int(date_part[:4])
    month = int(date_part[4:6])
    day = int(date_part[6:8])
    time_parts = time_part.split(":")
    hour = int(time_parts[0])
    minute = int(time_parts[1])
    second = int(time_parts[2])
    return datetime(year, month, day, hour, minute, second)


# ===========================================================================
# get_encounter_history family
# ===========================================================================
def build_encounter_dict(target_name: str, category: str, hits: list[dict]) -> dict:
    """One gap-bounded encounter's summary (disasm L656-678). ``{}`` when empty."""
    if not hits:
        return {}
    start_time = min(h["timestamp"] for h in hits)
    end_time = max(h["timestamp"] for h in hits)
    duration = (end_time - start_time).total_seconds()
    total_damage = sum(h["damage"] for h in hits)
    dps = total_damage / duration if duration > 0 else 0
    return {
        "target_name": target_name,
        "category": category,
        "start_time": start_time,
        "end_time": end_time,
        "duration": duration,
        "total_damage": total_damage,
        "dps": dps,
        "hit_count": len(hits),
        "time_label": start_time.strftime("%H:%M:%S"),
    }


def parse_archboss_encounters(target_name: str, hits: list[dict], category: str) -> list[dict]:
    """Archboss: all same-calendar-day hits collapse to one encounter (disasm L563-591)."""
    encounters_by_day: dict[Any, list[dict]] = defaultdict(list)
    for hit in hits:
        encounters_by_day[hit["timestamp"].date()].append(hit)
    encounters: list[dict] = []
    for day, day_hits in encounters_by_day.items():
        start_time = min(h["timestamp"] for h in day_hits)
        end_time = max(h["timestamp"] for h in day_hits)
        duration = (end_time - start_time).total_seconds()
        total_damage = sum(h["damage"] for h in day_hits)
        dps = total_damage / duration if duration > 0 else 0
        encounters.append({
            "target_name": target_name,
            "category": category,
            "start_time": start_time,
            "end_time": end_time,
            "duration": duration,
            "total_damage": total_damage,
            "dps": dps,
            "hit_count": len(day_hits),
            "date_label": day.strftime("%b %d"),
        })
    return encounters


def parse_boss_encounters(target_name: str, hits: list[dict], category: str,
                          gap_threshold: int) -> list[dict]:
    """Gap-based separation (disasm L594-623).

    A gap longer than ``gap_threshold`` seconds between consecutive hits closes
    the current encounter. The closed encounter gets ``gap_before`` = the gap
    that triggered the split (the old code's naming — it is the gap *to the next*
    encounter; the trailing flush carries no ``gap_before``).
    """
    encounters: list[dict] = []
    current_encounter: list[dict] = []
    for i, hit in enumerate(hits):
        if i == 0:
            current_encounter.append(hit)
            continue
        gap = (hit["timestamp"] - hits[i - 1]["timestamp"]).total_seconds()
        if gap > gap_threshold:
            if current_encounter:
                enc = build_encounter_dict(target_name, category, current_encounter)
                enc["gap_before"] = gap
                encounters.append(enc)
            current_encounter = [hit]
        else:
            current_encounter.append(hit)
    if current_encounter:
        encounters.append(build_encounter_dict(target_name, category, current_encounter))
    return encounters


def parse_adds_encounters(target_name: str, hits: list[dict], category: str) -> list[dict]:
    """Adds: short 30s gap split; no ``gap_before`` is recorded (disasm L626-653)."""
    encounters: list[dict] = []
    current_encounter: list[dict] = []
    gap_threshold = _ADDS_GAP_THRESHOLD
    for i, hit in enumerate(hits):
        if i == 0:
            current_encounter.append(hit)
            continue
        gap = (hit["timestamp"] - hits[i - 1]["timestamp"]).total_seconds()
        if gap > gap_threshold:
            if current_encounter:
                encounters.append(build_encounter_dict(target_name, category, current_encounter))
            current_encounter = [hit]
        else:
            current_encounter.append(hit)
    if current_encounter:
        encounters.append(build_encounter_dict(target_name, category, current_encounter))
    return encounters


def parse_encounters_from_log(log_file_path: Optional[Path],
                              target_assignments: dict) -> list[dict]:
    """Detect encounters in one combat-log file by target-category rules (disasm L436).

    ``target_assignments`` is the merged ``{"assignments": {name: category}}`` map
    (defaults + user overrides). Returns encounter dicts sorted by ``end_time``
    descending (most recent first). ``[]`` on a missing file or any parse error.
    """
    if not log_file_path or not Path(log_file_path).exists():
        return []
    try:
        hits_by_target: dict[str, list[dict]] = defaultdict(list)
        with open(log_file_path, "r", encoding="utf-8") as f:
            f.readline()  # skip the log-version header line
            for line in f:
                parts = line.strip().split(",")
                if len(parts) < _MIN_PARTS:
                    continue
                timestamp_str = parts[0]
                log_type = parts[1]
                damage = int(parts[4]) if parts[4].isdigit() else 0
                target_name = ",".join(parts[9:]).strip()
                if log_type != _LOG_TYPE_DAMAGE:
                    continue
                if damage == 0:
                    continue
                try:
                    timestamp = _parse_log_timestamp(timestamp_str)
                except Exception:
                    continue
                hits_by_target[target_name].append({"timestamp": timestamp, "damage": damage})

        encounters: list[dict] = []
        for target_name, hits in hits_by_target.items():
            if len(hits) == 0:
                continue
            hits.sort(key=lambda h: h["timestamp"])
            category = category_for_target(target_name, target_assignments)
            if category == "archboss":
                encounters_for_target = parse_archboss_encounters(target_name, hits, category)
            elif category in _BOSS_CATEGORIES:
                encounters_for_target = parse_boss_encounters(
                    target_name, hits, category,
                    gap_threshold=gap_threshold_for_category(category))
            elif category == "adds":
                encounters_for_target = parse_adds_encounters(target_name, hits, category)
            else:
                encounters_for_target = parse_boss_encounters(
                    target_name, hits, category,
                    gap_threshold=gap_threshold_for_category(category))
            encounters.extend(encounters_for_target)

        encounters.sort(key=lambda e: e["end_time"], reverse=True)
        return encounters
    except Exception:
        return []


def encounter_history_payload(encounters: list[dict]) -> list[dict]:
    """Serialize :func:`parse_encounters_from_log` output to the WS entry shape.

    11 keys, with ``start_time``/``end_time`` as ISO strings and the optional
    ``time_label``/``date_label``/``gap_before`` filled via ``.get`` defaults —
    exactly the ``get_encounter_history`` serializer (disasm L2644-2661).
    """
    out: list[dict] = []
    for enc in encounters:
        out.append({
            "target_name": enc["target_name"],
            "category": enc["category"],
            "start_time": enc["start_time"].isoformat(),
            "end_time": enc["end_time"].isoformat(),
            "duration": enc["duration"],
            "total_damage": enc["total_damage"],
            "dps": enc["dps"],
            "hit_count": enc["hit_count"],
            "time_label": enc.get("time_label", ""),
            "date_label": enc.get("date_label", ""),
            "gap_before": enc.get("gap_before", 0),
        })
    return out


# ===========================================================================
# get_encounter_details
# ===========================================================================
def parse_encounter_details(log_file_path: Optional[Path], target_name: str,
                            start_time: datetime, skill_settings: dict) -> Optional[dict]:
    """Per-hit detailed stats for one encounter window (disasm L682-947).

    Selects ``DamageDone`` hits to ``target_name`` whose (second-resolution)
    timestamp falls in ``[start_time - 10s, start_time + 10min]``, then builds the
    live-stats-compatible breakdown the Encounters-row click renders. Crit/heavy
    use the raw log flags; ``skill_settings`` is accepted for signature parity but
    unused, exactly as the old backend. ``None`` when the file is missing or no
    matching hits are found.
    """
    if not log_file_path or not Path(log_file_path).exists():
        return None
    try:
        time_window_start = start_time - _DETAILS_WINDOW_BEFORE
        time_window_end = start_time + _DETAILS_WINDOW_AFTER

        hits: list[dict] = []
        hits_60s: list[dict] = []
        total_damage = 0
        skill_damage: dict[str, int] = defaultdict(int)
        skill_counts: dict[str, int] = defaultdict(int)
        skill_crits: dict[str, int] = defaultdict(int)
        skill_heavies: dict[str, int] = defaultdict(int)
        crit_count = heavy_count = crit_heavy_count = normal_count = hit_count = 0

        damage_60s = 0
        skill_damage_60s: dict[str, int] = defaultdict(int)
        skill_counts_60s: dict[str, int] = defaultdict(int)
        skill_crits_60s: dict[str, int] = defaultdict(int)
        skill_heavies_60s: dict[str, int] = defaultdict(int)
        crit_count_60s = heavy_count_60s = crit_heavy_count_60s = 0
        normal_count_60s = hit_count_60s = 0

        first_hit_time: Optional[datetime] = None
        last_hit_time: Optional[datetime] = None

        with open(log_file_path, "r", encoding="utf-8") as f:
            f.readline()  # skip header
            for line in f:
                parts = line.strip().split(",")
                if len(parts) < _MIN_PARTS:
                    continue
                timestamp_str = parts[0]
                log_type = parts[1]
                skill_name = parts[2]
                damage = int(parts[4]) if parts[4].isdigit() else 0
                is_crit = parts[5] == "1"
                is_heavy = parts[6] == "1"
                target = ",".join(parts[9:]).strip()
                if log_type != _LOG_TYPE_DAMAGE or damage == 0:
                    continue
                if target != target_name:
                    continue
                timestamp = _parse_log_timestamp(timestamp_str)
                if timestamp < time_window_start or timestamp > time_window_end:
                    continue

                if first_hit_time is None:
                    first_hit_time = timestamp
                last_hit_time = timestamp
                relative_time = (timestamp - first_hit_time).total_seconds() if first_hit_time else 0

                total_damage += damage
                skill_damage[skill_name] += damage
                skill_counts[skill_name] += 1
                hit_count += 1

                # Mutually-exclusive cascade (disasm L780-794): crit+heavy is its
                # own bucket; top-level crit_count/heavy_count are exclusive of it,
                # while per-skill crit/heavy tallies count crit+heavy in both.
                if is_crit and is_heavy:
                    crit_heavy_count += 1
                    skill_crits[skill_name] += 1
                    skill_heavies[skill_name] += 1
                elif is_crit:
                    crit_count += 1
                    skill_crits[skill_name] += 1
                elif is_heavy:
                    heavy_count += 1
                    skill_heavies[skill_name] += 1
                else:
                    normal_count += 1

                if relative_time <= 60:
                    damage_60s += damage
                    skill_damage_60s[skill_name] += damage
                    skill_counts_60s[skill_name] += 1
                    hit_count_60s += 1
                    if is_crit and is_heavy:
                        crit_heavy_count_60s += 1
                        skill_crits_60s[skill_name] += 1
                        skill_heavies_60s[skill_name] += 1
                    elif is_crit:
                        crit_count_60s += 1
                        skill_crits_60s[skill_name] += 1
                    elif is_heavy:
                        heavy_count_60s += 1
                        skill_heavies_60s[skill_name] += 1
                    else:
                        normal_count_60s += 1
                    hits_60s.append({
                        "timestamp": timestamp.isoformat(),
                        "skill": skill_name,
                        "damage": damage,
                        "is_crit": is_crit,
                        "is_heavy": is_heavy,
                        "target": target,
                        "relative_time": relative_time,
                    })
                hits.append({
                    "timestamp": timestamp.isoformat(),
                    "skill": skill_name,
                    "damage": damage,
                    "is_crit": is_crit,
                    "is_heavy": is_heavy,
                    "target": target,
                    "relative_time": relative_time,
                })

        if hit_count == 0:
            return None

        duration = ((last_hit_time - first_hit_time).total_seconds()
                    if first_hit_time and last_hit_time else 0)
        dps = total_damage / duration if duration > 0 else 0

        skills = _details_skill_list(skill_damage, skill_counts, skill_crits,
                                     skill_heavies, total_damage)

        crit_rate = crit_count / hit_count * 100 if hit_count > 0 else 0
        heavy_rate = heavy_count / hit_count * 100 if hit_count > 0 else 0
        crit_heavy_rate = crit_heavy_count / hit_count * 100 if hit_count > 0 else 0
        normal_rate = normal_count / hit_count * 100 if hit_count > 0 else 0

        top_hits = sorted(hits, key=lambda h: h["damage"], reverse=True)[:10]

        timeline_map: dict[int, int] = defaultdict(int)
        for hit in hits:
            timeline_map[int(hit["relative_time"])] += hit["damage"]

        dps_60s = damage_60s / 60 if damage_60s > 0 else 0
        crit_rate_60s = crit_count_60s / hit_count_60s * 100 if hit_count_60s > 0 else 0
        heavy_rate_60s = heavy_count_60s / hit_count_60s * 100 if hit_count_60s > 0 else 0
        crit_heavy_rate_60s = crit_heavy_count_60s / hit_count_60s * 100 if hit_count_60s > 0 else 0
        normal_rate_60s = normal_count_60s / hit_count_60s * 100 if hit_count_60s > 0 else 0

        skills_60s = _details_skill_list(skill_damage_60s, skill_counts_60s,
                                         skill_crits_60s, skill_heavies_60s, damage_60s)

        return {
            "dps": dps,
            "total_damage": total_damage,
            "duration": duration,
            "hit_count": hit_count,
            "crit_rate": crit_rate,
            "crit_count": crit_count,
            "heavy_rate": heavy_rate,
            "heavy_count": heavy_count,
            "crit_heavy_rate": crit_heavy_rate,
            "crit_heavy_count": crit_heavy_count,
            "normal_rate": normal_rate,
            "normal_count": normal_count,
            "skills": skills,
            "top_hits": top_hits,
            "hit_log": hits,
            "timeline": [timeline_map.get(i, 0) for i in range(int(duration) + 1)],
            "targets": [{"name": target_name, "damage": total_damage}],
            "first_hit": first_hit_time.isoformat() if first_hit_time else "",
            "last_hit": last_hit_time.isoformat() if last_hit_time else "",
            "primary_target": target_name,
            "dps_60s": dps_60s,
            "damage_60s": damage_60s,
            "hit_count_60s": hit_count_60s,
            "crit_rate_60s": crit_rate_60s,
            "crit_count_60s": crit_count_60s,
            "heavy_rate_60s": heavy_rate_60s,
            "heavy_count_60s": heavy_count_60s,
            "crit_heavy_rate_60s": crit_heavy_rate_60s,
            "crit_heavy_count_60s": crit_heavy_count_60s,
            "normal_rate_60s": normal_rate_60s,
            "normal_count_60s": normal_count_60s,
            "skills_60s": skills_60s,
            "rotation_60s": hits_60s,
            "duration_60s": min(60, duration),
            "gap_stats": {},
        }
    except Exception:
        return None


def parse_encounter_hits(log_file_path: Optional[Path], target_name: str,
                         start_time: datetime, skill_settings: dict) -> list[dict]:
    """Canonical hits for one encounter window, rebased to the window's first hit.

    Used by ``load_encounter_data`` to load the *viewed* encounter into the live
    buffer so a follow-up ``save_encounter`` persists THAT encounter (the frontend's
    two-step save-from-history flow). Selection matches :func:`parse_encounter_details`
    exactly — target + ``[start-10s, start+10min]`` + ``damage != 0`` + RAW crit/heavy
    (``skill_settings`` accepted for signature symmetry but NOT applied, as in
    ``parse_encounter_details``) — so the saved record reflects exactly the viewed
    breakdown. Parsed via ``combat_log_parser`` so the hits carry the canonical
    ``time``/``hit_type`` shape a clean recording uses. ``[]`` on missing file / no match.
    """
    from combat_log_parser import finalize_hit, parse_line

    if not log_file_path or not Path(log_file_path).exists():
        return []
    win_start = start_time - _DETAILS_WINDOW_BEFORE
    win_end = start_time + _DETAILS_WINDOW_AFTER
    partials: list[dict] = []
    try:
        with open(log_file_path, "r", encoding="utf-8") as f:
            for line in f:
                pr = parse_line(line, skill_settings=None)  # RAW crit/heavy, like parse_encounter_details
                if pr is None or pr["damage"] == 0:
                    continue
                if pr["target"].strip() != target_name:
                    continue
                ts = pr["_timestamp"]
                if ts < win_start or ts > win_end:
                    continue
                partials.append(pr)
    except OSError:
        return []
    if not partials:
        return []
    start = partials[0]["_timestamp"]
    return [finalize_hit(pr, start) for pr in partials]


def _details_skill_list(skill_damage: dict, skill_counts: dict, skill_crits: dict,
                        skill_heavies: dict, total_damage: int) -> list[dict]:
    """Per-skill breakdown sorted by total damage desc (disasm L842-857 / L884-899).

    8 keys; ``percent``/``crit_percent``/``heavy_percent`` rounded 1dp. Per-skill
    crit/heavy counts include crit+heavy hits (see the cascade in the caller).
    """
    skills: list[dict] = []
    for skill_name in sorted(skill_damage.keys(), key=lambda s: skill_damage[s], reverse=True):
        dmg = skill_damage[skill_name]
        count = skill_counts[skill_name]
        percent = dmg / total_damage * 100 if total_damage > 0 else 0
        crit_rate = skill_crits[skill_name] / count * 100 if count > 0 else 0
        heavy_rate = skill_heavies[skill_name] / count * 100 if count > 0 else 0
        skills.append({
            "name": skill_name,
            "damage": dmg,
            "hits": count,
            "crits": skill_crits[skill_name],
            "heavies": skill_heavies[skill_name],
            "percent": round(percent, 1),
            "crit_percent": round(crit_rate, 1),
            "heavy_percent": round(heavy_rate, 1),
        })
    return skills
