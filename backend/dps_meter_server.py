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
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Optional

import websockets

import debug
import encounter_scan
import persistence as p
from combat_log_parser import parse_line
from combat_stats import (
    CombatStats,
    _skills as _agg_skills,
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

# Seconds of combat silence that auto-closes (idles out) the active party
# encounter and emits the authoritative final frame to the worker.  Mirrors
# the boss gap threshold so a wipe boundary and an idle-out use the same rule.
PARTY_IDLE_CLOSE_S: float = 45.0

# Commands we deliberately no-op. `set_skill_weapon` has no old handler (the old
# exe drops it silently — confirmed live), so we match that.
# (open_overlay / close_overlay ARE handled now — they spawn/kill the Tauri overlay,
#  Workstream B — see _h_open_overlay below.)
SILENTLY_IGNORED = frozenset({
    "set_skill_weapon",     # superseded by assign_skill / bulk_assign_skills
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
        # Wall-clock instant of the last reset. Ingested entries older than this are
        # ignored — the original CK backend's "Ignoring entries before <ts>" mechanism
        # (server.py reset/reset_file_position). Combat-log timestamps are accurate even
        # though TL flushes the file minutes late, so this filter — not file position —
        # is what makes reset a reliable line in the sand. None = accept everything.
        self.reset_after_timestamp = None
        self.party = PartyState()
        # Snapshot of the merged target→category map for the active party recording,
        # so per-hit boundary detection (A3) doesn't rebuild it from disk every hit.
        # Populated when recording starts; None falls back to a lazy build.
        self._party_assignments: Optional[dict[str, str]] = None
        # Wall-clock instant of the last party hit — used by the idle-close checker
        # (see _check_party_idle / PARTY_IDLE_CLOSE_S) to auto-finalize an encounter
        # after a sustained silence without requiring a manual Stop button click.
        self._party_last_hit_time: Optional[datetime] = None
        # True while the user is in an active party session (party_code registered and
        # recording not explicitly stopped).  Gating auto-arm on this flag prevents
        # hits from re-arming after a manual party_stop_recording.
        self._party_session_active: bool = False
        self._overlay_proc: Optional[Any] = None  # spawned tldps-overlay.exe (Tauri)
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
        _kill_overlay(self)  # don't orphan the overlay window when the app closes
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
            await ws.send(json.dumps(payload, default=str))
        except websockets.ConnectionClosed:
            self.clients.discard(ws)

    async def _broadcast(self, payload: dict) -> None:
        if not self.clients:
            return
        # default=str guards against a stray datetime in any payload (e.g. a debug
        # trace record carrying stats.first_ts/last_ts) — bare json.dumps would raise
        # in this fire-and-forget Task and silently drop the broadcast. Mirrors
        # debug._write, which already serializes trace records with default=str.
        data = json.dumps(payload, default=str)
        for ws in list(self.clients):
            try:
                await ws.send(data)
            except websockets.ConnectionClosed:
                self.clients.discard(ws)

    async def _broadcast_loop(self) -> None:
        try:
            while True:
                await asyncio.sleep(self.broadcast_interval)
                # Contract 3: idle-close — auto-finalize the active party encounter
                # after PARTY_IDLE_CLOSE_S seconds of combat silence so the worker
                # receives the authoritative final frame without a manual Stop click.
                self._check_party_idle()
                if self.clients:
                    await self._broadcast(self._stats_envelope())
        except asyncio.CancelledError:
            raise

    def _check_party_idle(self) -> None:
        """Close the active party encounter if combat has been silent long enough.

        Runs every broadcast tick (0.5s by default). Idles out when:
          * a party recording is active (encounter_active),
          * at least one hit has been recorded (party.current is not None),
          * wall-clock silence since the last hit exceeds PARTY_IDLE_CLOSE_S.

        Emits a ``party_final`` frame (via _emit_encounter_final) then disarms.
        Resets ``_party_last_hit_time`` so a subsequent fight auto-re-arms cleanly.
        """
        if not self.party.encounter_active:
            return
        if self.party.current is None:
            return
        if self._party_last_hit_time is None:
            return
        elapsed = (datetime.now() - self._party_last_hit_time).total_seconds()
        if elapsed < PARTY_IDLE_CLOSE_S:
            return
        # Silence threshold crossed — close and finalize.
        enc = self.party.current
        log.debug("party idle-close: encounter %s silent for %.1fs", enc.encounter_id, elapsed)
        self.party.encounter_active = False
        self._party_last_hit_time = None
        # Set current to None so the next auto-arm + record_hit cycle opens a FRESH
        # encounter without triggering the gap/wipe-boundary logic against the old
        # encounter's last_hit_time (which would emit a spurious double-final).
        self.party.current = None
        # Leave _party_session_active True so the NEXT fight auto-arms when combat
        # resumes (the user is still in the room; this was a between-fight gap, not
        # a deliberate Stop).  Only party_stop_recording clears _party_session_active.
        self._emit_encounter_final(enc)  # no hit= → party_final type

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
        cutoff = self.reset_after_timestamp
        added = dropped = 0
        for line in lines:
            partial = parse_line(line)  # RAW: no skill_settings correction here
            if partial is None:
                continue
            # Line-in-the-sand: drop entries that happened before the last reset, even
            # if TL flushes them to the file afterwards (the lagged-backlog clip bug).
            if cutoff is not None and partial["_timestamp"] < cutoff:
                dropped += 1
                continue
            self.stats.add_partial(partial)
            added += 1
            # Contract 1: auto-arm the party encounter on the first combat hit once a
            # party session has been registered (_party_session_active). This removes
            # the requirement for a manual "Start" button click before data is
            # collected.  If encounter_active is already True (user clicked Start or a
            # prior auto-arm fired), this is a no-op. reset_stats is NOT called here —
            # the accumulators are preserved so a late Start click can't wipe a fight
            # already in progress.  Auto-arm does NOT fire after an explicit
            # party_stop_recording (which clears _party_session_active).
            if self._party_session_active and not self.party.encounter_active:
                self.party.arm()
                self._party_assignments = self._effective_target_assignments()
                log.debug("party auto-armed on first combat hit")
            if self.party.encounter_active:
                self._record_party_hit(partial)
        if added or dropped:
            debug.trace("server.ingest", lines_in=len(lines), added=added, dropped=dropped,
                        buffer_hits=len(self.stats.hits),
                        first_ts=str(self.stats.first_ts), last_ts=str(self.stats.last_ts))

    def _party_category(self, target: str) -> str:
        """Category for ``target`` from the recording's cached assignments (A3).

        Lazily snapshots the merged map if a recording armed without one (e.g. a
        direct ``record_hit`` path in tests). Falls back to ``"other"`` for any
        unmapped target — the same default the file-history path uses.
        """
        if self._party_assignments is None:
            self._party_assignments = self._effective_target_assignments()
        return self._party_assignments.get(target, "other")

    def _record_party_hit(self, partial: dict) -> None:
        """Fold one hit into the party accumulator and emit ``party_live_hit``.

        Phase 2 / A3: pass the target's category so the accumulator can segment on a
        gap/wipe boundary (rule #3). The emitted ``totals`` carry the **current**
        encounter's ``encounter_id`` AND ``fight_ts`` so the worker can key everything
        on the real fight-start timestamp. When a boundary closes the previous
        encounter, emit a ``final`` frame for it first so its board is posted
        authoritatively before the new one hydrates.
        """
        # Contract 3: track wall-clock of last hit so the idle-close checker can
        # auto-finalize when combat goes quiet for PARTY_IDLE_CLOSE_S seconds.
        self._party_last_hit_time = datetime.now()

        category = self._party_category(partial["target"])
        prev = self.party.current
        self.party.record_hit(
            target=partial["target"],
            damage=partial["damage"],
            is_crit=partial["is_crit"],
            is_heavy=partial["is_heavy"],
            hit_time=partial["_timestamp"],
            category=category,
            # Per-hit detail (Phase 3 / C1b) — retained for the final post's rotation.
            skill=partial["skill"],
            time=partial["time"],
        )
        cur = self.party.current

        hit = {
            "target": partial["target"],
            "damage": partial["damage"],
            "is_crit": partial["is_crit"],
            "is_heavy": partial["is_heavy"],
        }

        # Boundary crossed: the previous encounter just closed. Emit its final board
        # (flagged so the frontend posts it immediately, bypassing the live debounce)
        # before the new encounter starts hydrating.
        if prev is not None and cur is not prev:
            # Final post for the just-closed encounter — carry the full hit slice
            # (Phase 3 / C1b) and per-skill breakdown (incl. crit/heavy damage).
            self._emit_encounter_final(prev, hit=hit)

        totals = self.party.get_results()
        # Contract 2: emit fight_ts consistently on every live frame so the worker
        # can key each frame to the real fight-start timestamp without relying on the
        # encounter_id string comparison.
        totals["encounter_id"] = cur.encounter_id if cur else None
        totals["fight_ts"] = cur.fight_ts() if cur else None
        self._emit({"type": "party_live_hit", "hit": hit, "totals": totals})

    def _build_detail(self, enc) -> dict:
        """Build the full drill-down detail block for a closed encounter.

        Combines the per-target results with a per-skill breakdown (including
        ``crit_damage`` and ``heavy_damage``) computed from the retained hit list.
        This is the ``detail`` block carried in every final/close frame so the worker
        can store and serve drill-down without a second request.
        """
        results = enc.results(include_hits=True)
        rotation = results.get("rotation", [])
        total_damage = results.get("total_damage", 0)
        skills = _agg_skills(rotation, total_damage) if rotation else []
        return {
            "targets": results.get("targets", []),
            "skills": skills,
            "total_damage": total_damage,
            "duration": results.get("duration", 0),
            "fight_ts": enc.fight_ts(),
            "rotation": rotation,
        }

    def _emit_encounter_final(self, enc, *, hit: Optional[dict] = None) -> None:
        """Emit the authoritative final frame for ``enc`` (wipe boundary or idle-close).

        When called from the wipe-boundary path a ``hit`` dict is provided (the first
        hit of the NEW encounter that triggered the close) so we can re-use the
        ``party_live_hit`` envelope for backwards compat with the existing test suite
        and any already-deployed worker code.  When called from the idle-close path
        (no triggering hit) we use the distinct ``party_final`` type so the worker
        can branch on type rather than the ``final`` flag alone.
        """
        detail = self._build_detail(enc)
        if hit is not None:
            # Wipe-boundary close: keep the party_live_hit envelope (backwards compat)
            # but add the full detail block alongside the legacy totals.
            totals = enc.results()
            totals["encounter_id"] = enc.encounter_id
            totals["fight_ts"] = enc.fight_ts()
            self._emit({
                "type": "party_live_hit",
                "hit": hit,
                "totals": totals,
                "final": True,
                "detail": detail,
            })
        else:
            # Idle-close (no triggering hit): distinct type for clean worker branching.
            self._emit({
                "type": "party_final",
                "final": True,
                "encounter_id": enc.encounter_id,
                "fight_ts": enc.fight_ts(),
                "detail": detail,
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
        debug.trace("server.trigger_reset", path="hotkey",
                    buffer_hits=len(self.stats.hits),
                    watcher_pos=getattr(getattr(self, "watcher", None), "file_position", None))
        self.stats.reset()
        self.reset_after_timestamp = datetime.now()  # ignore combat before this instant
        w = getattr(self, "watcher", None)
        if w is not None:
            w.skip_to_end()  # skip the file backlog we can (perf); the ts filter is the guarantee
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
    """Load a viewed encounter into the live buffer (disasm ``load_encounter_data``).

    Frontend sends ``{target_name, start_time}``. We re-parse that encounter's window
    and (1) reply ``encounter_loaded`` with its breakdown, and (2) **load its hits into
    ``s.stats``** so the frontend's follow-up ``save_encounter`` persists THIS encounter
    rather than the live session. (The old exe replied with the data but never loaded
    the buffer — so save-from-history saved the wrong thing; this completes the
    intended two-step the frontend already drives.)
    """
    from datetime import datetime

    target_name = msg.get("target_name")
    start_time_str = msg.get("start_time")
    if not target_name or not start_time_str:
        return {"type": "error", "message": "Missing target_name or start_time"}
    start_time = datetime.fromisoformat(start_time_str.replace("Z", "+00:00"))
    skills = p.load_skill_settings(s.data_dir).get("skills", {})
    active = s._active_log_file()
    details = encounter_scan.parse_encounter_details(active, target_name, start_time, skills)
    if not details:
        return {"type": "error", "message": f"No data found for encounter: {target_name}"}
    # Replace the live buffer in place (keeps the watcher's reference valid) with the
    # viewed encounter's canonical hits so the next save_encounter persists it.
    hits = encounter_scan.parse_encounter_hits(active, target_name, start_time, skills)
    s.stats.reset()
    for h in hits:
        s.stats.add_hit(h)
    return {"type": "encounter_loaded", "data": details}


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
    debug.trace("server._h_reset", path="command",
                buffer_hits=len(s.stats.hits),
                watcher_pos=getattr(getattr(s, "watcher", None), "file_position", None))
    s.stats.reset()
    s.reset_after_timestamp = datetime.now()  # ignore combat before this instant
    w = getattr(s, "watcher", None)
    if w is not None:
        w.skip_to_end()  # skip the file backlog we can (perf); the ts filter is the guarantee
    return {"type": "reset"}


# --- encounters ------------------------------------------------------------
def _is_dup_save(prev: dict, record: dict, *, window_s: float = 4.0) -> bool:
    """True when ``record`` looks like a double-fired save of ``prev``: identical
    overall stats + target, saved within ``window_s`` seconds. Guards against a
    double-connected frontend creating twin encounters (the duplicate-runs bug)."""
    pov, rov = prev.get("overall") or {}, record.get("overall") or {}
    if (pov.get("total_damage") != rov.get("total_damage")
            or pov.get("hit_count") != rov.get("hit_count")
            or prev.get("primary_target") != record.get("primary_target")):
        return False
    try:
        delta = (datetime.fromisoformat(record["timestamp"])
                 - datetime.fromisoformat(prev["timestamp"])).total_seconds()
    except (KeyError, ValueError, TypeError):
        return False
    return 0 <= delta <= window_s


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
    debug.trace("server.save_encounter", build_tag=msg.get("build_tag"),
                buffer_hits=len(hits),
                overall_dur=record["overall"].get("duration"),
                overall_hits=record["overall"].get("hit_count"),
                first60_hits=len(window),
                first60_open=window[0]["skill"] if window else None,
                first60_anchor=window[0].get("time") if window else None)
    data = p.load_encounters(s.data_dir)
    encs = data.setdefault("encounters", [])
    # Idempotency guard: a double-connected frontend can fire two save_encounter
    # commands for the same buffer within milliseconds. If the newest existing
    # encounter is an identical, just-saved twin, reuse it instead of duplicating.
    if encs and _is_dup_save(encs[0], record):
        debug.trace("server.save_encounter.dedup", reused=encs[0].get("id"),
                    tag=record["build_tag"])
        return {"type": "encounter_saved", "encounter": encs[0],
                "builds": data.get("builds", [])}
    encs.insert(0, record)
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
    # F3 — PERSISTENCE BOUNDARY (Foundations). Saved runs (solo AND party) live LOCALLY in
    # saved_runs.json. A *party* run is the same record + a `party: true` marker + `party_code`;
    # its `encounters` carry the per-encounter party scoreboards (F1 shape) the room produced —
    # Phase 2 fills these in. Solo runs are byte-identical to before (the party fields are added
    # only when msg.party is set), so this is additive.
    #   Party-run schema (saved_runs.json entry):
    #     { id, created_at, run_name, party: true, party_code,
    #       encounters: [ { encounter_id, boss, boss_category, started_at, total_damage,
    #                        entries: [ {username, user_id, total_damage, dps, contribution,
    #                                    crit_rate, heavy_rate, hits} ] } ] }
    #   BOUNDARY (decided at F3, so Phase 4 isn't a 4th migration): global leaderboards /
    #   personal bests are a SEPARATE future worker (KV vs D1 decided at Phase 4). The party-room
    #   Durable Object NEVER holds global/cross-room data; do not wire leaderboards into it.
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
    if msg.get("party"):  # party run — additive marker; solo runs stay byte-identical
        run["party"] = True
        run["party_code"] = msg.get("party_code")
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
    """Arm party recording (optional ``party_code``); reply with live status.

    Contract 1 (idempotent): if a recording is already active (auto-armed by the
    first combat hit), do NOT reset accumulators — just update the party_code if
    one was provided and return the current status.  This keeps the frontend's
    Start button harmless even when combat has already begun.

    If not yet active, full start_recording (arm + reset + code) as before.
    """
    # Mark the session active so auto-arm fires on the next combat hit.
    s._party_session_active = True
    if s.party.encounter_active:
        # Already armed — idempotent: update code without wiping accumulated hits.
        if msg.get("party_code"):
            s.party.party_code = msg.get("party_code")
    else:
        s.party.start_recording(msg.get("party_code"))
        # Snapshot the category map once for this recording's boundary detection (A3).
        s._party_assignments = s._effective_target_assignments()
    return {"type": "party_recording_started", "status": s.party.get_status()}


def _h_party_stop_recording(s: DPSMeterServer, msg: dict) -> dict:
    """Disarm recording; reply with the final results + status (current encounter).

    Emits a ``party_final`` broadcast to all connected clients (the idle-close path
    uses the same helper) so the worker receives the authoritative final frame whether
    the stop was manual or automatic.  Resets ``_party_last_hit_time`` so the idle
    checker does not double-fire after a manual stop.
    """
    enc = s.party.current  # capture before stop_recording disarms
    # Final post — carry the full hit slice for the room to store (Phase 3 / C1b).
    results = s.party.stop_recording(include_hits=True)
    results["encounter_id"] = enc.encounter_id if enc else None
    results["fight_ts"] = enc.fight_ts() if enc else None
    # Reset idle timer + session flag so _check_party_idle / auto-arm don't fire
    # after a manual stop — the user explicitly ended the session.
    s._party_last_hit_time = None
    s._party_session_active = False
    # Broadcast the authoritative final frame to all clients (incl. any room relay).
    if enc is not None:
        s._emit_encounter_final(enc)  # party_final type (no hit= arg)
    return {"type": "party_recording_stopped",
            "results": results, "status": s.party.get_status()}


def _h_party_reset_stats(s: DPSMeterServer, msg: dict) -> dict:
    """Zero the party accumulators (leaves ``encounter_active`` unchanged)."""
    s.party.reset_stats()
    return {"type": "party_stats_reset", "status": s.party.get_status()}


def _h_client_debug(s: DPSMeterServer, msg: dict) -> None:
    """Bridge a frontend debug event into the backend tracer.

    The party/overlay transport is client-side (browser WS to the Cloudflare room),
    invisible to the Python tracer. The frontend forwards its room-WS lifecycle here so
    ``TLDPS_DEBUG=1`` captures the whole party flow in ``tldps-debug.jsonl`` (and the live
    sink → ``_monitor.py``) alongside backend events. No-op when tracing is off; never
    replies (returns ``None`` → dispatch skips the send)."""
    if debug.enabled():
        event = str(msg.get("event", "client.event"))
        fields = msg.get("fields") or {}
        if isinstance(fields, dict):
            debug.trace("client." + event, **fields)
        else:
            debug.trace("client." + event, value=fields)
    return None


# --- party overlay (separate Tauri process, Workstream B) ------------------
def _resolve_overlay_exe() -> Optional[Path]:
    """Locate the bundled/built ``tldps-overlay.exe`` (the Tauri overlay).

    Frozen: bundled next to the app (PyInstaller extracts datas to ``_MEIPASS``).
    Dev: the cargo build output under ``overlay/src-tauri/target/{release,debug}``.
    Returns None if not found (open_overlay then replies with an error)."""
    import sys
    if getattr(sys, "frozen", False):
        cand = Path(getattr(sys, "_MEIPASS", "")) / "tldps-overlay.exe"
        return cand if cand.is_file() else None
    repo = Path(__file__).resolve().parent.parent
    for sub in ("release", "debug"):
        cand = repo / "overlay" / "src-tauri" / "target" / sub / "tldps-overlay.exe"
        if cand.is_file():
            return cand
    return None


def _kill_overlay(s: DPSMeterServer) -> None:
    """Terminate the spawned overlay process if it's still running (best-effort)."""
    proc = getattr(s, "_overlay_proc", None)
    if proc is not None and proc.poll() is None:
        try:
            proc.terminate()
        except OSError:
            pass
    s._overlay_proc = None


def _h_open_overlay(s: DPSMeterServer, msg: dict) -> dict:
    """Spawn the Tauri overlay as a separate process for the current party.

    Relaunches if one is already open (so it always reflects the current code/name).
    The overlay connects to the room as a read-only spectator using ``--code``/``--name``."""
    exe = _resolve_overlay_exe()
    if exe is None:
        return {"type": "overlay_error", "error": "overlay executable not found"}
    _kill_overlay(s)  # relaunch with the current code/name
    code = str(msg.get("code") or "")
    name = str(msg.get("name") or "Overlay")
    import subprocess
    try:
        # --logdir unifies the overlay's debug log into the app's data dir (perma-write,
        # not the bundled exe's _MEIPASS temp). See debug protocol in the tldps skill.
        s._overlay_proc = subprocess.Popen(
            [str(exe), "--code", code, "--name", name, "--logdir", str(s.data_dir)])
    except OSError as exc:
        log.warning("failed to launch overlay: %s", exc)
        return {"type": "overlay_error", "error": str(exc)}
    log.info("overlay launched: %s --code %s --name %s", exe, code, name)
    return {"type": "overlay_opened", "code": code}


def _h_close_overlay(s: DPSMeterServer, msg: dict) -> dict:
    """Kill the spawned overlay process (the overlay's own ✕ also closes it)."""
    _kill_overlay(s)
    return {"type": "overlay_closed"}


def _h_toggle_overlay(s: DPSMeterServer, msg: dict) -> dict:
    """True toggle for the 'Toggle Overlay' button: close it if it's currently open,
    otherwise open it. (If the user closed it via its own ✕, the process is gone and
    this opens a fresh one.)"""
    proc = getattr(s, "_overlay_proc", None)
    if proc is not None and proc.poll() is None:
        _kill_overlay(s)
        return {"type": "overlay_closed"}
    return _h_open_overlay(s, msg)


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


def _open_in_file_browser(path: str) -> None:
    """Reveal a directory in the OS file browser (Win/mac/Linux)."""
    import os
    import subprocess
    import sys

    if sys.platform.startswith("win"):
        os.startfile(path)  # type: ignore[attr-defined]  # Windows-only API
    elif sys.platform == "darwin":
        subprocess.run(["open", path], check=False)
    else:
        subprocess.run(["xdg-open", path], check=False)


def _h_open_data_folder(s: DPSMeterServer, msg: dict) -> Optional[dict]:
    """Open the app's writable data folder (%LOCALAPPDATA%\\TL-DPS-Meter when installed).

    The state files moved out of sight when the app gained a real installer; this
    gives users a one-click way to find them. No reply on success (like
    ``open_logs_folder``)."""
    d = Path(s.data_dir)
    if not d.is_dir():
        return {"type": "error", "message": "Data folder not found"}
    _open_in_file_browser(str(d))
    log.info("opened data folder: %s", d)
    return None


def _h_reset_data(s: DPSMeterServer, msg: dict) -> dict:
    """Clear the accumulating user data — saved encounters + runs — back to empty.

    Leaves functional presets (target categories, dungeons) and tuned settings
    (skill/weapon/target config) intact. Replies ``data_reset`` so the frontend can
    re-fetch its lists."""
    p.save_encounters(dict(p.DEFAULT_ENCOUNTERS), s.data_dir)
    p.save_saved_runs([], s.data_dir)
    log.info("reset app data (encounters + saved runs cleared)")
    return {"type": "data_reset"}


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


def _h_get_suggested_names(s: DPSMeterServer, msg: dict) -> dict:
    """F4 — surface candidate display name(s) so the party UI can DEFAULT the name box instead of
    demanding free-text. Primary candidate = the configured ``player_name``; then a best-effort
    dominant caster (by total damage) from the tail of the active combat log — the player's own
    character is normally the top caster in their own log. Advisory ONLY: log values are spoofable,
    identity is not secured (blueprint §10). This is the backend substrate; the one-tap name-picker
    UI lands with the Onboarding push (shares the identity UI)."""
    names: list[str] = []
    configured = (s.config or {}).get("player_name") or ""
    if configured:
        names.append(configured)
    try:
        from collections import Counter
        from constants import (
            IDX_CASTER, IDX_DAMAGE, IDX_LOG_TYPE, LOG_TYPE_DAMAGE, MIN_DAMAGE_FIELDS,
        )
        log_dir = s._log_dir()
        if log_dir and Path(log_dir).is_dir():
            files = sorted(Path(log_dir).glob("*.txt"))
            if files:
                with open(files[-1], "r", encoding="utf-8", errors="replace") as fh:
                    lines = fh.readlines()[-5000:]  # bounded tail — recent activity only
                dmg: Counter = Counter()
                for line in lines:
                    parts = line.rstrip("\n").rstrip("\r").split(",")
                    if len(parts) < MIN_DAMAGE_FIELDS or parts[IDX_LOG_TYPE] != LOG_TYPE_DAMAGE:
                        continue
                    try:
                        d = int(parts[IDX_DAMAGE])
                    except (ValueError, IndexError):
                        continue
                    caster = parts[IDX_CASTER]
                    if caster:
                        dmg[caster] += d
                for caster, _ in dmg.most_common():
                    if caster not in names:
                        names.append(caster)
                    if len(names) >= 3:
                        break
    except Exception:
        log.debug("get_suggested_names: log scan failed", exc_info=True)
    return {"type": "suggested_names", "names": names}


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
    "get_suggested_names": _h_get_suggested_names,  # F4: default the party name box
    "get_builds": _h_get_builds,
    "get_stats": _h_get_stats,
    "get_encounter_details": _h_get_encounter_details,
    "load_encounter_data": _h_load_encounter_data,
    # GUI / system (restored Phase 8 — were wrongly silent-dropped in Phase 3)
    "open_logs_folder": _h_open_logs_folder,
    "purge_log": _h_purge_log,
    # data lifecycle (new — state moved to %LOCALAPPDATA% with the installer)
    "open_data_folder": _h_open_data_folder,
    "reset_data": _h_reset_data,
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
    "client_debug": _h_client_debug,
    "open_overlay": _h_open_overlay,
    "close_overlay": _h_close_overlay,
    "toggle_overlay": _h_toggle_overlay,
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

    # Diagnostics (off unless TLDPS_DEBUG=1): configure BEFORE the watcher so the
    # startup full-history load is traced too. File trace + live WS debug frames.
    debug.configure(server.data_dir,
                    sink=lambda rec: server._emit({"type": "debug", "data": rec}))
    if debug.enabled():
        log.info("TLDPS_DEBUG on -> tracing to %s", debug.logfile())

    # Tail the combat log into the server (Phase 4). Import here so the server
    # module has no hard dependency on watchdog when used headless (e.g. tests).
    from log_watcher import LogWatcher

    watcher = LogWatcher(server, log_dir=log_dir)
    server.watcher = watcher  # let traces read live file_position
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
