"""WebSocket dispatch + server for the TL-DPS-Meter backend (rebuild, Phase 3).

The frontend (`index.html`) talks to this over ``ws://localhost:8765`` with a fixed
contract: it sends ``{"command": ..., ...}`` and receives ``{"type": ..., ...}``.
On connect it fires a 9-command init burst (get_config, get_encounters,
get_saved_runs, get_skill_settings, get_weapon_config, get_target_assignments,
get_default_targets, get_dungeons, get_encounter_history) — all must answer before
any tab renders.

Every command routes through ``HANDLERS`` (a dispatch table). Persistence is the
Phase-2 ``persistence.*`` load/save pairs — handlers call those, never re-implement
IO. Live stats use the verified ``combat_stats.build_live_stats`` serializer.

What is wired here vs. deferred to later phases:
  * The 0.5s ``broadcast_stats`` loop emits the live ``stats`` shape captured from
    the old .exe (``fixtures/gold_stats_stream.jsonl``) — verified byte-for-byte.
  * Hits enter via :meth:`ingest_lines` (the Phase-4 watchdog watcher will call it
    per file change; tests call it directly). No log *watching* is done here.
  * ``error`` message type added to the contract so the frontend can distinguish a
    backend that is "thinking" from one that is "dead".
  * Bug-fixes folded in: the dungeon commands are handled (return non-error);
    atomic writes come free from ``persistence``; the old license-expiry check and
    its broken update URL are intentionally omitted (a static perpetual license is
    reported so the frontend's license panel still renders).

Routing resolutions honored (see SCHEMAS.md):
  * ``get_session_encounters`` has no old handler -> aliased to ``get_encounters``.
  * ``set_skill_weapon`` has no old handler -> silently ignored (the real commands
    are ``assign_skill`` / ``bulk_assign_skills``); matches the old exe, which drops
    unknown commands without replying.
  * ``saved_runs.json`` is a bare list on disk; the WS reply wraps it as
    ``{"type": "saved_runs_list", "runs": [...]}``.
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from pathlib import Path
from typing import Any, Callable, Optional

import websockets

import encounter_scan
import persistence as p
from combat_log_parser import parse_line
from combat_stats import (
    CombatStats,
    build_first_60s_block,
    build_overall_block,
    slice_first_60s,
)
from constants import DEFAULT_LOG_SUBDIR, HOST, PORT
from party_state import PartyState

log = logging.getLogger(__name__)

# A perpetual, non-enforcing license stub. The old backend phoned a (now broken)
# URL and hard-stopped after an expiry date; the rebuild drops both checks but
# still reports a license object so the frontend's license panel renders.
PERPETUAL_LICENSE = {"version": "1.0", "days_remaining": None, "expires": None}

# Commands we deliberately no-op. `set_skill_weapon` has no old handler (the old
# exe drops it silently — confirmed live), so we match that. The overlay commands
# DO exist in the old exe (they spawn/kill the separate overlay.exe), but that
# subsystem is out of the rebuild's scope, so we drop them rather than half-wire it.
SILENTLY_IGNORED = frozenset({
    "set_skill_weapon",     # superseded by assign_skill / bulk_assign_skills
    "close_overlay", "open_overlay",  # overlay.exe subsystem — out of rebuild scope
})

class DPSMeterServer:
    """Async WebSocket server: 9-init burst, command dispatch, 0.5s stats broadcast."""

    def __init__(
        self,
        data_dir: str | Path,
        *,
        host: str = HOST,
        port: int = PORT,
        broadcast_interval: float = 0.5,
    ) -> None:
        self.data_dir = str(data_dir)
        self.host = host
        self.port = port
        self.broadcast_interval = broadcast_interval

        self.stats = CombatStats()
        self.party = PartyState()
        self.clients: set[Any] = set()
        self._server: Optional[Any] = None
        self._broadcast_task: Optional[asyncio.Task] = None
        self._loop: Optional[asyncio.AbstractEventLoop] = None

        # In-memory caches refreshed on mutation (config + the skill-settings map,
        # which the 0.5s broadcast reads on every tick).
        self.config = p.load_config(self.data_dir)
        self.skill_settings = p.load_skill_settings(self.data_dir)

    # --- lifecycle ---------------------------------------------------------
    async def start(self) -> "DPSMeterServer":
        """Bind the WS server and launch the broadcast loop. Returns self.

        With ``port=0`` an ephemeral port is chosen; read it back from
        :attr:`port` (tests bind ephemeral to avoid clashing with a live 8765).
        """
        self._loop = asyncio.get_running_loop()
        self._server = await websockets.serve(
            self._handle_client, self.host, self.port, max_size=None)
        # Resolve the actually-bound port (matters when port==0).
        self.port = self._server.sockets[0].getsockname()[1]
        self._broadcast_task = asyncio.create_task(self._broadcast_loop())
        log.info("DPSMeterServer listening on ws://%s:%s", self.host, self.port)
        return self

    async def stop(self) -> None:
        if self._broadcast_task:
            self._broadcast_task.cancel()
            try:
                await self._broadcast_task
            except asyncio.CancelledError:
                pass
        if self._server:
            self._server.close()
            await self._server.wait_closed()

    async def serve_forever(self) -> None:
        await self.start()
        await asyncio.Future()  # run until cancelled

    # --- client handling ---------------------------------------------------
    async def _handle_client(self, ws) -> None:
        self.clients.add(ws)
        try:
            async for raw in ws:
                await self._on_message(ws, raw)
        except websockets.ConnectionClosed:
            pass
        finally:
            self.clients.discard(ws)

    async def _on_message(self, ws, raw: str) -> None:
        try:
            msg = json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            await self._send(ws, {"type": "error", "message": "invalid JSON"})
            return
        command = msg.get("command") if isinstance(msg, dict) else None
        if not command:
            await self._send(ws, {"type": "error", "message": "missing command"})
            return
        if command in SILENTLY_IGNORED:
            log.debug("ignoring command (no-op for parity): %s", command)
            return

        handler = HANDLERS.get(command)
        if handler is None:
            # Unknown command: the old exe drops these silently. Match it.
            log.debug("unknown command dropped: %s", command)
            return

        try:
            response = handler(self, msg)
        except Exception as exc:  # noqa: BLE001 - report, never crash the socket
            log.exception("handler error for %s", command)
            await self._send(ws, {"type": "error", "command": command, "message": str(exc)})
            return

        if response is not None:
            await self._send(ws, response)
        # Commands that change the live stats should reflect immediately rather
        # than waiting up to one broadcast tick.
        if command == "reset":
            await self._broadcast(self._stats_envelope())

    async def _send(self, ws, payload: dict) -> None:
        try:
            await ws.send(json.dumps(payload))
        except websockets.ConnectionClosed:
            self.clients.discard(ws)

    async def _broadcast(self, payload: dict) -> None:
        if not self.clients:
            return
        data = json.dumps(payload)
        for ws in list(self.clients):
            try:
                await ws.send(data)
            except websockets.ConnectionClosed:
                self.clients.discard(ws)

    async def _broadcast_loop(self) -> None:
        try:
            while True:
                await asyncio.sleep(self.broadcast_interval)
                if self.clients:
                    await self._broadcast(self._stats_envelope())
        except asyncio.CancelledError:
            raise

    # --- stats ingestion + serialization -----------------------------------
    def ingest_lines(self, lines) -> None:
        """Parse RAW combat-log lines and accumulate them (watcher/test entry point).

        Lines are parsed without skill-settings correction (the live serializer
        applies that at broadcast time, exposing both raw and adjusted figures).

        While a party recording is active each accumulated hit is also folded into
        :attr:`party` and emitted as a ``party_live_hit`` frame — mirroring the old
        backend's monitor loop (``server.py`` L3370-3399), which recorded the hit
        and broadcast ``{hit, totals}`` for every DamageDone row while
        ``encounter_active``. The party stream is the same player-attributed hits
        that feed the live stats, so no extra caster filter is applied here.
        """
        for line in lines:
            partial = parse_line(line)  # RAW: no skill_settings correction here
            if partial is None:
                continue
            self.stats.add_partial(partial)
            if self.party.encounter_active:
                self._record_party_hit(partial)

    def _record_party_hit(self, partial: dict) -> None:
        """Fold one hit into the party accumulator and emit ``party_live_hit``."""
        self.party.record_hit(
            target=partial["target"],
            damage=partial["damage"],
            is_crit=partial["is_crit"],
            is_heavy=partial["is_heavy"],
            hit_time=partial["_timestamp"],
        )
        self._emit({
            "type": "party_live_hit",
            "hit": {
                "target": partial["target"],
                "damage": partial["damage"],
                "is_crit": partial["is_crit"],
                "is_heavy": partial["is_heavy"],
            },
            "totals": self.party.get_results(),
        })

    def _emit(self, payload: dict) -> None:
        """Schedule a broadcast of ``payload`` on the event loop, from any thread.

        ``call_soon_threadsafe`` is safe whether ``ingest_lines`` runs on the loop
        thread (tests, and the Phase-4 watcher poll) or off it; a no-op before the
        server has started (``_loop is None``)."""
        loop = self._loop
        if loop is None:
            return
        loop.call_soon_threadsafe(
            lambda: asyncio.ensure_future(self._broadcast(payload)))

    def _stats_envelope(self) -> dict:
        return {
            "type": "stats",
            "data": self.stats.live(self.skill_settings.get("skills", {})),
            "license": dict(PERPETUAL_LICENSE),
            "log_info": self._log_info(),
            "party_status": self.party.get_status(),
        }

    def _current_skills(self) -> list[str]:
        """Distinct skills from the current stats, in first-seen order.

        This is the runtime ``currentSkills`` the old backend derives from the
        active combat session (absent from ``weapon_config.json`` on disk).
        """
        seen: dict[str, None] = {}
        for h in self.stats.hits:
            seen.setdefault(h["skill"], None)
        return list(seen)

    # --- helper payloads ---------------------------------------------------
    def _config_public(self) -> dict:
        return {k: v for k, v in self.config.items() if k != "last_updated"}

    def _skill_settings_payload(self) -> dict:
        return {
            "current_skills": self._current_skills(),
            "settings": self.skill_settings.get("skills", {}),
        }

    def _log_dir(self) -> Optional[Path]:
        configured = self.config.get("log_path") or ""
        candidate = Path(configured) if configured else _default_log_dir()
        return candidate if candidate.is_dir() else None

    def _log_info(self) -> dict:
        d = self._log_dir()
        if d is None:
            return {"current_file": None, "file_count": 0,
                    "file_size": "0 B", "folder_size": "0 B"}
        txts = sorted(d.glob("*.txt"))
        latest = max(txts, default=None, key=lambda f: f.name)
        folder = sum(f.stat().st_size for f in txts)
        return {
            "current_file": latest.name if latest else None,
            "file_count": len(txts),
            "file_size": _human_size(latest.stat().st_size) if latest else "0 B",
            "folder_size": _human_size(folder),
        }

    def _active_log_file(self) -> Optional[Path]:
        """The active combat-log file = newest ``*.txt`` by name (old ``self.log_file``).

        Matches the watcher's active-file rule and ``_log_info``'s ``latest``. The
        encounter-scan path parses this single file, not the whole directory.
        """
        d = self._log_dir()
        if d is None:
            return None
        return max(d.glob("*.txt"), default=None, key=lambda f: f.name)

    def _effective_target_assignments(self) -> dict[str, str]:
        """Merged ``{name: category}`` map: bundled defaults (inverted) + user overrides.

        Mirrors the old ``load_target_assignments`` (disasm L369) — the same merged
        view served to the frontend by ``get_target_assignments`` and used to route
        encounter categories (archboss / *_boss / adds / other).
        """
        defaults = p.load_default_targets(self.data_dir)
        assignments: dict[str, str] = {}
        for category, names in defaults.items():
            if isinstance(names, list):
                for name in names:
                    assignments[name] = category
        assignments.update(p.load_target_assignments(self.data_dir).get("assignments", {}))
        return assignments

    def _encounter_history(self) -> list[dict]:
        """Encounter summaries for the Encounters tab (disasm ``get_encounter_history``).

        Re-parses the active log file via ``encounter_scan.parse_encounters_from_log``
        (category-specific archboss/boss/adds segmentation) and serializes to the WS
        entry shape. Returns [] when no log file is present.
        """
        encounters = encounter_scan.parse_encounters_from_log(
            self._active_log_file(),
            {"assignments": self._effective_target_assignments()},
        )
        return encounter_scan.encounter_history_payload(encounters)

    # --- introspection for the watcher/host (Phase 4+) ---------------------
    def schedule_broadcast(self) -> None:
        """Thread-safe nudge for an immediate stats broadcast (used by the watcher)."""
        if self._loop is not None:
            self._loop.call_soon_threadsafe(
                lambda: asyncio.ensure_future(self._broadcast(self._stats_envelope())))

    async def trigger_reset(self) -> None:
        """Reset stats and broadcast the reset + a zeroed stats frame to all clients.

        Shared by the hotkey path (Phase 5). The `reset` COMMAND replies to its
        single requester then broadcasts the zeroed frame; this broadcasts the
        `reset` signal to everyone (there is no requester for a hotkey press).
        """
        self.stats.reset()
        await self._broadcast({"type": "reset"})
        await self._broadcast(self._stats_envelope())

    def request_reset(self) -> None:
        """Thread-safe reset trigger — called from the hotkey listener thread."""
        if self._loop is not None:
            asyncio.run_coroutine_threadsafe(self.trigger_reset(), self._loop)


# ===========================================================================
# Command handlers. Each takes (server, msg) and returns a response dict or None.
# ===========================================================================

# --- reads / init burst ----------------------------------------------------
def _h_get_config(s: DPSMeterServer, msg: dict) -> dict:
    return {"type": "config", "data": s._config_public()}


def _h_get_encounters(s: DPSMeterServer, msg: dict) -> dict:
    return {"type": "encounters", "data": p.load_encounters(s.data_dir)}


def _h_get_saved_runs(s: DPSMeterServer, msg: dict) -> dict:
    # On-disk bare list -> WS envelope.
    return {"type": "saved_runs_list", "runs": p.load_saved_runs(s.data_dir)}


def _h_get_skill_settings(s: DPSMeterServer, msg: dict) -> dict:
    return {"type": "skill_settings", "data": s._skill_settings_payload()}


def _h_get_weapon_config(s: DPSMeterServer, msg: dict) -> dict:
    wc = p.load_weapon_config(s.data_dir)
    return {
        "type": "weapon_config",
        "currentSkills": s._current_skills(),
        "skillAssignments": wc.get("skillAssignments", {}),
    }


def _h_get_target_assignments(s: DPSMeterServer, msg: dict) -> dict:
    # The effective assignments are the bundled defaults inverted (category ->
    # [names] becomes name -> category) with the user's overrides laid on top.
    # The old exe serves this merged view even when no user file exists.
    return {"type": "target_assignments",
            "data": {"assignments": s._effective_target_assignments()}}


def _h_get_default_targets(s: DPSMeterServer, msg: dict) -> dict:
    return {"type": "default_targets", "data": p.load_default_targets(s.data_dir)}


def _h_get_dungeons(s: DPSMeterServer, msg: dict) -> dict:
    return {"type": "dungeons_list", "dungeons": p.load_dungeons(s.data_dir)}


def _h_get_encounter_history(s: DPSMeterServer, msg: dict) -> dict:
    return {"type": "encounter_history", "encounters": s._encounter_history()}


def _h_get_builds(s: DPSMeterServer, msg: dict) -> dict:
    return {"type": "builds", "data": p.load_encounters(s.data_dir).get("builds", [])}


def _h_get_stats(s: DPSMeterServer, msg: dict) -> dict:
    return s._stats_envelope()


def _h_get_encounter_details(s: DPSMeterServer, msg: dict) -> dict:
    """Re-parse the active log for one encounter window (disasm ``get_encounter_details``).

    The frontend sends ``{target_name, start_time}`` (an ISO timestamp, NOT a saved
    UUID). We re-scan the active log file for the ``[start_time-10s, +10min]`` window
    via ``encounter_scan.parse_encounter_details`` and return the live-stats-shaped
    ``data.hit_log`` the Encounters-row breakdown renders.
    """
    from datetime import datetime

    target_name = msg.get("target_name")
    start_time_str = msg.get("start_time")
    if not target_name or not start_time_str:
        return {"type": "error", "message": "Missing target_name or start_time"}
    start_time = datetime.fromisoformat(start_time_str.replace("Z", "+00:00"))
    skill_settings = p.load_skill_settings(s.data_dir).get("skills", {})
    details = encounter_scan.parse_encounter_details(
        s._active_log_file(), target_name, start_time, skill_settings)
    if details:
        details["start_time"] = start_time_str
        details["target_name"] = target_name
        return {"type": "encounter_details", "data": details}
    return {"type": "error", "message": f"No data found for encounter: {target_name}"}


def _h_load_encounter_data(s: DPSMeterServer, msg: dict) -> dict:
    enc_id = msg.get("encounter_id") or msg.get("id")
    encounters = p.load_encounters(s.data_dir).get("encounters", [])
    match = next((e for e in encounters if e.get("id") == enc_id), None)
    return {"type": "encounter_loaded", "data": match}


# --- config / player -------------------------------------------------------
def _h_set_config(s: DPSMeterServer, msg: dict) -> dict:
    updates = {k: v for k, v in msg.items() if k != "command"}
    s.config = {**s.config, **updates}
    p.save_config(s.config, s.data_dir)
    return {"type": "config_saved", "data": s._config_public()}


def _h_set_player(s: DPSMeterServer, msg: dict) -> dict:
    s.config = {**s.config, "player_name": msg.get("player_name", "")}
    p.save_config(s.config, s.data_dir)
    return {"type": "config_saved", "data": s._config_public()}


# --- stats reset -----------------------------------------------------------
def _h_reset(s: DPSMeterServer, msg: dict) -> dict:
    s.stats.reset()
    return {"type": "reset"}


# --- encounters ------------------------------------------------------------
def _h_save_encounter(s: DPSMeterServer, msg: dict) -> dict:
    hits = s.stats.hits
    window = slice_first_60s(hits)
    targets = build_overall_block(hits).get("targets", [])
    record = {
        "id": uuid.uuid4().hex,
        "timestamp": p._now_iso(),
        "build_tag": msg.get("build_tag", "Unnamed Build"),
        "notes": msg.get("notes", ""),
        "primary_target": targets[0]["name"] if targets else "Unknown",
        "player_class": msg.get("player_class", ""),
        "overall": build_overall_block(hits),
        "first_60s": build_first_60s_block(window),
    }
    data = p.load_encounters(s.data_dir)
    data.setdefault("encounters", []).insert(0, record)
    builds = data.setdefault("builds", [])
    tag = record["build_tag"]
    if tag and tag not in builds:
        builds.append(tag)
    p.save_encounters(data, s.data_dir)
    return {"type": "encounter_saved", "encounter": record, "builds": builds}


def _h_update_encounter(s: DPSMeterServer, msg: dict) -> dict:
    enc_id = msg.get("encounter_id") or msg.get("id")
    fields = {k: v for k, v in msg.items()
              if k not in ("command", "encounter_id", "id")}
    data = p.load_encounters(s.data_dir)
    updated = None
    for e in data.get("encounters", []):
        if e.get("id") == enc_id:
            e.update(fields)
            updated = e
            break
    p.save_encounters(data, s.data_dir)
    return {"type": "encounter_updated", "encounter": updated}


def _h_delete_encounter(s: DPSMeterServer, msg: dict) -> dict:
    enc_id = msg.get("encounter_id") or msg.get("id")
    data = p.load_encounters(s.data_dir)
    before = data.get("encounters", [])
    data["encounters"] = [e for e in before if e.get("id") != enc_id]
    p.save_encounters(data, s.data_dir)
    return {"type": "encounter_deleted", "encounter_id": enc_id}


def _h_merge_encounters(s: DPSMeterServer, msg: dict) -> dict:
    ids = msg.get("encounter_ids") or []
    target_name = msg.get("target_name")
    if not target_name or not ids:
        return {"type": "error", "message": "Missing target_name or start times"}
    data = p.load_encounters(s.data_dir)
    chosen = [e for e in data.get("encounters", []) if e.get("id") in ids]
    return {"type": "encounter_saved", "merged": len(chosen), "target_name": target_name}


# --- saved runs ------------------------------------------------------------
def _h_save_run(s: DPSMeterServer, msg: dict) -> dict:
    runs = p.load_saved_runs(s.data_dir)
    run_id = time.strftime("%Y%m%d_%H%M%S")
    run = {
        "id": run_id,
        "run_name": msg.get("run_name", ""),
        "dungeon_category": msg.get("dungeon_category", ""),
        "dungeon_name": msg.get("dungeon_name", ""),
        "dungeon_info": msg.get("dungeon_info"),
        "player_class": msg.get("player_class", ""),
        "build_tag": msg.get("build_tag", ""),
        "contribution_percent": msg.get("contribution_percent"),
        "got_loot": msg.get("got_loot", False),
        "loot_item": msg.get("loot_item"),
        "encounters": msg.get("encounters", []),
        "stats": msg.get("stats", {}),
        "created_at": p._now_iso(),
    }
    runs.append(run)
    p.save_saved_runs(runs, s.data_dir)
    return {"type": "run_saved", "run_id": run_id,
            "message": f'Run "{run["run_name"]}" saved successfully'}


def _h_update_run(s: DPSMeterServer, msg: dict) -> dict:
    run_id = msg.get("run_id") or msg.get("id")
    fields = {k: v for k, v in msg.items() if k not in ("command", "run_id", "id")}
    runs = p.load_saved_runs(s.data_dir)
    for r in runs:
        if r.get("id") == run_id:
            r.update(fields)
            break
    p.save_saved_runs(runs, s.data_dir)
    return {"type": "run_updated", "run_id": run_id}


def _h_delete_run(s: DPSMeterServer, msg: dict) -> dict:
    run_id = msg.get("run_id") or msg.get("id")
    runs = [r for r in p.load_saved_runs(s.data_dir) if r.get("id") != run_id]
    p.save_saved_runs(runs, s.data_dir)
    return {"type": "run_deleted", "run_id": run_id}


# --- dungeons (the previously-dead commands, now wired) --------------------
def _h_add_dungeon_type(s: DPSMeterServer, msg: dict) -> dict:
    name = msg.get("type_name", "")
    dungeons = p.load_dungeons(s.data_dir)
    dungeons.setdefault(name, [])
    p.save_dungeons(dungeons, s.data_dir)
    return {"type": "dungeon_type_added", "type_name": name, "dungeons": dungeons}


def _h_add_dungeon(s: DPSMeterServer, msg: dict) -> dict:
    category = msg.get("category", "")
    dungeon_name = msg.get("dungeon_name", "")
    dungeons = p.load_dungeons(s.data_dir)
    entries = dungeons.setdefault(category, [])
    if dungeon_name and dungeon_name not in entries:
        entries.append(dungeon_name)
    p.save_dungeons(dungeons, s.data_dir)
    return {"type": "dungeon_added", "category": category,
            "dungeon_name": dungeon_name, "dungeons": dungeons}


def _h_delete_dungeon(s: DPSMeterServer, msg: dict) -> dict:
    category = msg.get("category", "")
    dungeon_name = msg.get("dungeon_name", "")
    dungeons = p.load_dungeons(s.data_dir)
    if category in dungeons:
        dungeons[category] = [d for d in dungeons[category] if d != dungeon_name]
    p.save_dungeons(dungeons, s.data_dir)
    return {"type": "dungeon_deleted", "category": category,
            "dungeon_name": dungeon_name, "dungeons": dungeons}


def _h_delete_dungeon_type(s: DPSMeterServer, msg: dict) -> dict:
    name = msg.get("type_name", "")
    dungeons = p.load_dungeons(s.data_dir)
    dungeons.pop(name, None)
    p.save_dungeons(dungeons, s.data_dir)
    return {"type": "dungeon_type_deleted", "type_name": name, "dungeons": dungeons}


# --- weapon / skill assignment ---------------------------------------------
def _h_assign_skill(s: DPSMeterServer, msg: dict) -> dict:
    skill_name = msg.get("skill_name", "")
    category = msg.get("category", "unassigned")
    wc = p.load_weapon_config(s.data_dir)
    assignments = wc.setdefault("skillAssignments", {})
    assignments[skill_name] = category
    p.save_weapon_config(wc, s.data_dir)
    return {"type": "skill_assigned", "skill_name": skill_name, "category": category,
            "assignments": assignments, "currentSkills": s._current_skills()}


def _h_bulk_assign_skills(s: DPSMeterServer, msg: dict) -> dict:
    incoming = msg.get("assignments", {})
    wc = p.load_weapon_config(s.data_dir)
    assignments = wc.setdefault("skillAssignments", {})
    assignments.update(incoming)
    p.save_weapon_config(wc, s.data_dir)
    return {"type": "skills_bulk_assigned", "assignments": assignments,
            "currentSkills": s._current_skills()}


# --- skill settings (crit/heavy correction flags) --------------------------
def _h_set_skill_setting(s: DPSMeterServer, msg: dict) -> dict:
    name = msg.get("skill_name", "")
    s.skill_settings.setdefault("skills", {})[name] = {
        "cannot_crit": bool(msg.get("cannot_crit", False)),
        "cannot_heavy": bool(msg.get("cannot_heavy", False)),
    }
    p.save_skill_settings(s.skill_settings, s.data_dir)
    return {"type": "skill_settings", "data": s._skill_settings_payload()}


def _h_delete_skill_setting(s: DPSMeterServer, msg: dict) -> dict:
    name = msg.get("skill_name", "")
    s.skill_settings.setdefault("skills", {}).pop(name, None)
    p.save_skill_settings(s.skill_settings, s.data_dir)
    return {"type": "skill_settings", "data": s._skill_settings_payload()}


# --- target assignments ----------------------------------------------------
def _h_set_target_assignment(s: DPSMeterServer, msg: dict) -> dict:
    target_name = msg.get("target_name", "")
    category = msg.get("category", "")
    ta = p.load_target_assignments(s.data_dir)
    ta.setdefault("assignments", {})[target_name] = category
    p.save_target_assignments(ta, s.data_dir)
    return {"type": "target_assignment_saved",
            "target_name": target_name, "category": category}


# --- hotkey / party --------------------------------------------------------
def _h_test_hotkey(s: DPSMeterServer, msg: dict) -> dict:
    return {"type": "hotkey_test", "success": True}


def _h_party_start_recording(s: DPSMeterServer, msg: dict) -> dict:
    """Arm party recording (optional ``party_code``); reply with live status."""
    s.party.start_recording(msg.get("party_code"))
    return {"type": "party_recording_started", "status": s.party.get_status()}


def _h_party_stop_recording(s: DPSMeterServer, msg: dict) -> dict:
    """Disarm recording; reply with the final results + status."""
    results = s.party.stop_recording()
    return {"type": "party_recording_stopped",
            "results": results, "status": s.party.get_status()}


def _h_party_reset_stats(s: DPSMeterServer, msg: dict) -> dict:
    """Zero the party accumulators (leaves ``encounter_active`` unchanged)."""
    s.party.reset_stats()
    return {"type": "party_stats_reset", "status": s.party.get_status()}


# --- GUI / system commands -------------------------------------------------
def _h_open_logs_folder(s: DPSMeterServer, msg: dict) -> Optional[dict]:
    """Open the combat-log directory in the OS file browser.

    Faithful to the old exe (disasm L18645-18729): ``os.startfile`` on Windows,
    ``open`` on macOS, ``xdg-open`` on Linux; an ``error`` reply when the directory
    is missing. On success the old exe sends NO reply (returns ``None``) — dispatch
    skips the send for ``None``.

    Regression note: this command (and ``purge_log``) were mis-bucketed as silent
    GUI no-ops in Phase 3; the old exe actually handled both. Restored in the
    Phase-8 interactive pass after the "Open Logs Folder" button did nothing.
    """
    import os
    import subprocess
    import sys

    log_dir = s._log_dir()
    if not log_dir or not Path(log_dir).exists():
        return {"type": "error", "message": "Logs folder not found"}
    path = str(log_dir)
    if sys.platform.startswith("win"):
        os.startfile(path)  # type: ignore[attr-defined]  # Windows-only API
    elif sys.platform == "darwin":
        subprocess.run(["open", path], check=False)
    else:
        subprocess.run(["xdg-open", path], check=False)
    log.info("opened logs folder: %s", path)
    return None


def _h_purge_log(s: DPSMeterServer, msg: dict) -> dict:
    """Truncate the active combat-log file (newest ``*.txt`` by name); reply log_purged.

    Faithful to the old exe (disasm L18445-18642, error string "No log file found
    to purge"). The watcher tolerates the truncation: its next poll sees
    ``size < file_position`` and restarts from byte 0 (``log_watcher.read_new_lines``
    re-seeks), so no desync. Stats are left intact — the old exe only clears the
    file, it does not reset the meter.
    """
    log_dir = s._log_dir()
    if not log_dir or not Path(log_dir).is_dir():
        return {"type": "error", "message": "No log file found to purge"}
    files = sorted(Path(log_dir).glob("*.txt"))
    if not files:
        return {"type": "error", "message": "No log file found to purge"}
    active = files[-1]  # newest by name — same active-file rule as the watcher
    with open(active, "w", encoding="utf-8"):
        pass  # truncate to zero length
    log.info("purged active log file: %s", active)
    return {"type": "log_purged"}


HANDLERS: dict[str, Callable[[DPSMeterServer, dict], Optional[dict]]] = {
    # init burst (9)
    "get_config": _h_get_config,
    "get_encounters": _h_get_encounters,
    "get_saved_runs": _h_get_saved_runs,
    "get_skill_settings": _h_get_skill_settings,
    "get_weapon_config": _h_get_weapon_config,
    "get_target_assignments": _h_get_target_assignments,
    "get_default_targets": _h_get_default_targets,
    "get_dungeons": _h_get_dungeons,
    "get_encounter_history": _h_get_encounter_history,
    # get_session_encounters has no old handler -> alias to get_encounters (the fix)
    "get_session_encounters": _h_get_encounters,
    # other reads
    "get_builds": _h_get_builds,
    "get_stats": _h_get_stats,
    "get_encounter_details": _h_get_encounter_details,
    "load_encounter_data": _h_load_encounter_data,
    # GUI / system (restored Phase 8 — were wrongly silent-dropped in Phase 3)
    "open_logs_folder": _h_open_logs_folder,
    "purge_log": _h_purge_log,
    # config / player
    "set_config": _h_set_config,
    "set_player": _h_set_player,
    # stats
    "reset": _h_reset,
    # encounters
    "save_encounter": _h_save_encounter,
    "update_encounter": _h_update_encounter,
    "delete_encounter": _h_delete_encounter,
    "merge_encounters": _h_merge_encounters,
    # saved runs
    "save_run": _h_save_run,
    "update_run": _h_update_run,
    "delete_run": _h_delete_run,
    # dungeons (formerly dead -> now handled)
    "add_dungeon_type": _h_add_dungeon_type,
    "add_dungeon": _h_add_dungeon,
    "delete_dungeon": _h_delete_dungeon,
    "delete_dungeon_type": _h_delete_dungeon_type,
    # weapon / skill assignment
    "assign_skill": _h_assign_skill,
    "bulk_assign_skills": _h_bulk_assign_skills,
    # skill settings
    "set_skill_setting": _h_set_skill_setting,
    "delete_skill_setting": _h_delete_skill_setting,
    # target assignments
    "set_target_assignment": _h_set_target_assignment,
    # hotkey / party
    "test_hotkey": _h_test_hotkey,
    "party_start_recording": _h_party_start_recording,
    "party_stop_recording": _h_party_stop_recording,
    "party_reset_stats": _h_party_reset_stats,
}


# ===========================================================================
# Module helpers
# ===========================================================================
def _default_log_dir() -> Path:
    import os
    base = os.environ.get("LOCALAPPDATA", str(Path.home()))
    return Path(base) / DEFAULT_LOG_SUBDIR


def _human_size(num: int) -> str:
    size = float(num)
    for unit in ("B", "KB", "MB", "GB"):
        if size < 1024 or unit == "GB":
            return f"{size:.1f} {unit}" if unit != "B" else f"{int(size)} B"
        size /= 1024
    return f"{size:.1f} GB"


async def _run_app(
    data_dir: str,
    *,
    host: str = HOST,
    port: int = PORT,
    log_dir: str | Path | None = None,
    on_ready: Optional[Callable[["DPSMeterServer"], None]] = None,
    stop_event: Optional[asyncio.Event] = None,
) -> None:
    """Bind the server, attach the watcher + hotkey, and run until stopped.

    Single source of truth for the runtime wiring shared by the CLI entry point
    (:func:`main`) and the windowed entry point (``main.py``). Parameters let the
    caller drive it without touching the contract:

    * ``port=0`` binds an ephemeral port (tests; never the live 8765).
    * ``log_dir`` overrides the watched combat-log directory (tests point it at a
      temp dir; the default resolves the real TL CombatLogs folder).
    * ``on_ready`` is invoked once the WS is bound and the watcher/hotkey are up —
      the windowed launcher waits on this before opening the native window so the
      frontend's 9-init burst answers instantly.
    * ``stop_event`` is awaited instead of running forever; setting it (from any
      thread via ``loop.call_soon_threadsafe``) triggers the clean-shutdown path.
    """
    server = DPSMeterServer(data_dir, host=host, port=port)
    await server.start()
    # Tail the combat log into the server (Phase 4). Import here so the server
    # module has no hard dependency on watchdog when used headless (e.g. tests).
    from log_watcher import LogWatcher

    watcher = LogWatcher(server, log_dir=log_dir)
    watcher.start()

    # Global reset hotkey (Phase 5). Skip when disabled in config.
    hotkeys = None
    if server.config.get("hotkey_enabled", True):
        from hotkey import HotkeyManager

        hotkeys = HotkeyManager(server.request_reset,
                                hotkey=server.config.get("hotkey", "ctrl+tab"))
        hotkeys.start()

    if on_ready is not None:
        on_ready(server)

    try:
        if stop_event is not None:
            await stop_event.wait()
        else:
            await asyncio.Future()  # run until cancelled
    finally:
        if hotkeys is not None:
            hotkeys.stop()
        watcher.stop()
        await server.stop()


def main() -> None:
    import os

    logging.basicConfig(level=logging.INFO)
    data_dir = os.environ.get("TLDPS_DATA_DIR", str(Path.cwd()))
    asyncio.run(_run_app(data_dir))


if __name__ == "__main__":
    main()
