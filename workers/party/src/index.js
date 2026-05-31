// tldps-party — Cloudflare Durable Object party relay for TL-DPS-Meter.
//
// Model (see ../../../TL-DPS-Meter-oracle/docs/WORKSTREAM-B-PARTY-REBOOT.md):
//   - One PartyRoom Durable Object instance per party code = the authoritative room.
//   - POST-COMBAT: each member POSTs its full per-target breakdown for a fight; the room
//     identifies THE BOSS (server-side), filters trash, merges everyone's damage-to-the-boss
//     into a ranked scoreboard, and broadcasts it. NO per-hit streaming.
//   - Boss detection lives HERE (not the client) so it's a single source of truth, uses
//     cross-party convergence (the target the whole party hammered), and is updatable by a
//     `wrangler deploy` — no app reship when T&L adds bosses.
//   - Presence = the set of connected WebSockets. Reconnect-safe via WS Hibernation.
//   - Bounded to small parties (<=12).
//
// F1 — ENCOUNTER KEYING (the keystone). Storage is keyed by encounter, not by member:
//   encounters[encounter_id].submissions[user_id]. `active_encounter_id` is the encounter that
//   incoming post_fights land in. The leader's `encounter_start` FILES the closing board (marks
//   it ended, keeps it) and arms a fresh active encounter — everyone files under the id they all
//   heard (F1b leader-stamped boundary). If a post_fight arrives with no armed encounter
//   (open-world, nobody pressed Start), the room server-assigns one (F1b time-bucket fallback).
//   Behavior is held constant: the room still broadcasts ONE (the active) scoreboard. The Phase-2
//   encounter switcher will expose the others; the substrate is in.
//
// Wire protocol — see README.md.

const CODE_RE = /^[A-Z0-9]{4,8}$/;
const MAX_MEMBERS = 12;
// Ghost eviction: members offline longer than this window are pruned from the roster.
// Chosen to survive a typical game crash + re-launch cycle (~5 min) without leaving ghosts
// that persist forever. The timer only fires when a NEW member joins or a post_fight arrives,
// so it never runs on an idle room.
const GHOST_EVICT_MS = 5 * 60 * 1000; // 5 minutes

// Wire protocol version (F2). `welcome` announces it; `post_fight` carries it. A missing `v`
// on an incoming post_fight = a legacy Phase-1 client (stored as v:1) — still slotted in, so an
// un-updated installed app keeps working during rollout. The post_fight envelope is
// enrichment-ready: { v, fight_ts, targets, summary, skills, rotation }. The room reads `targets`
// for boss detection and stores summary/skills/rotation OPAQUELY (Phase 3 fills skills/rotation
// with zero further protocol change).
const PROTOCOL_V = 2;

// Structured logging (F6). One JSON line per meaningful event -> `wrangler tail` becomes a
// real monitor. Mirrors the backend's `debug.trace` philosophy so the whole system traces
// consistently. Pure observability: no behavior change, no protocol change. [observability]
// is already enabled in wrangler.toml, so these lines are queryable in the CF dashboard too.
const logEvent = (t, fields) => {
  try { console.log(JSON.stringify({ t, ts: Date.now(), ...fields })); } catch (_) {}
};

// Optional, deployable boss-name -> category map. Detection works WITHOUT this (pure
// convergence picks the boss); this only adds a category label and disambiguates when a
// known boss is present. Keyed by normalized (lowercased/trimmed) target name. Extend it
// and `wrangler deploy` — no client update needed.
// @gen:known_bosses:start
const KNOWN_BOSSES = {
  "tevent": "archboss",
  "ascended tevent": "archboss",
  "queen bellandir": "archboss",
  "ascended queen bellandir": "archboss",
  "deluzhnoa": "archboss",
  "ascended deluzhnoa": "archboss",
  "giant cordy": "archboss",
  "ascended giant cordy": "archboss",
  "adentus": "field_boss",
  "ahzreil": "field_boss",
  "aridus": "field_boss",
  "ascended adentus": "field_boss",
  "ascended ahzreil": "field_boss",
  "ascended aridus": "field_boss",
  "ascended chernobog": "field_boss",
  "ascended cornelius": "field_boss",
  "ascended excavator-9": "field_boss",
  "ascended grand aelon": "field_boss",
  "ascended junobote": "field_boss",
  "ascended kowazan": "field_boss",
  "ascended lycan kowazan": "field_boss",
  "ascended malakar": "field_boss",
  "ascended minezerok": "field_boss",
  "ascended morokai": "field_boss",
  "ascended nirma": "field_boss",
  "ascended pakilo naru": "field_boss",
  "ascended talus": "field_boss",
  "chernobog": "field_boss",
  "cornelius": "field_boss",
  "excavator-9": "field_boss",
  "grand aelon": "field_boss",
  "junobote": "field_boss",
  "kowazan": "field_boss",
  "malakar": "field_boss",
  "minezerok": "field_boss",
  "morokai": "field_boss",
  "nirma": "field_boss",
  "pakilo naru": "field_boss",
  "talus": "field_boss",
  "calanthia": "raid_boss",
  "calanthia of destruction": "raid_boss",
  "dragaryle": "raid_boss",
  "radeth": "raid_boss",
  "vulkan": "raid_boss",
  "zairos": "raid_boss",
  "belkros": "dungeon_boss",
  "belog": "dungeon_boss",
  "blath": "dungeon_boss",
  "blatras": "dungeon_boss",
  "duke magna": "dungeon_boss",
  "gaitan": "dungeon_boss",
  "grayeye": "dungeon_boss",
  "heliber": "dungeon_boss",
  "kaiser crimson": "dungeon_boss",
  "karnix": "dungeon_boss",
  "king chimaerus": "dungeon_boss",
  "lacune": "dungeon_boss",
  "lequirus": "dungeon_boss",
  "limuny bercant": "dungeon_boss",
  "lucien": "dungeon_boss",
  "red chimaerus": "dungeon_boss",
  "rex chimaerus": "dungeon_boss",
  "shaikal": "dungeon_boss",
  "shakarux": "dungeon_boss",
  "star-engulfed demonhoof head shaman": "dungeon_boss",
  "toublek": "dungeon_boss",
};
// @gen:known_bosses:end
const norm = (s) => String(s || "").trim().toLowerCase();

import { handleSkills } from "./gamedata.js";
import { handleFeedback } from "./feedback.js";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "/health") {
      return new Response("tldps-party ok", { status: 200 });
    }

    // WS join:  /party/<CODE>?user_id=..&username=..&leader=0|1
    const m = url.pathname.match(/^\/party\/([A-Za-z0-9]+)$/);
    if (m) {
      const code = m[1].toUpperCase();
      if (!CODE_RE.test(code)) return new Response("bad party code", { status: 400 });
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("expected websocket", { status: 426 });
      }
      const id = env.PARTY_ROOM.idFromName(code);
      return env.PARTY_ROOM.get(id).fetch(request);
    }

    // Game-data service: app "Update" button pulls the skill->weapon map from here.
    if (url.pathname === "/skills") return handleSkills(request, env);

    // Feedback intake (KV-only). Handler self-handles OPTIONS preflight + method.
    if (url.pathname === "/feedback") return handleFeedback(request, env);

    return new Response("not found", { status: 404 });
  },
};

export class PartyRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  // --- connection (WS upgrade) ---
  async fetch(request) {
    const url = new URL(request.url);
    const code = (url.pathname.split("/").pop() || "").toUpperCase();
    const user_id = url.searchParams.get("user_id") || "";
    const username = (url.searchParams.get("username") || "Anon").slice(0, 32);
    const is_leader = url.searchParams.get("leader") === "1";
    // Spectators (e.g. the read-only overlay window) get the live board WITHOUT joining as a
    // member: they don't count toward the cap, don't appear in the roster, and can't post.
    const is_spectator = url.searchParams.get("spectator") === "1";

    if (!user_id) return new Response("missing user_id", { status: 400 });

    const members = (await this.ctx.storage.get("members")) || {};
    if (!is_spectator && !members[user_id] && Object.keys(members).length >= MAX_MEMBERS) {
      logEvent("party_full", { code, user_id, members: Object.keys(members).length });
      return new Response("party full", { status: 403 });
    }

    // Drop any prior socket for this user (reconnect / duplicate tab).
    for (const old of this.ctx.getWebSockets(user_id)) {
      try { old.close(1000, "replaced"); } catch (_) {}
    }

    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server, [user_id]); // tag = user_id (survives hibernation)
    server.serializeAttachment({ user_id, username, is_leader, code, is_spectator });

    if (!is_spectator) {
      // Reclaim the same slot on reconnect (stable identity — contract item 4).
      // joined_at is preserved from the original join; last_seen is updated each reconnect.
      const existing = members[user_id];
      members[user_id] = {
        username,
        is_leader,
        joined_at: existing ? existing.joined_at : Date.now(),
        last_seen: Date.now(),
      };
      await this.ctx.storage.put("members", members);
    }

    logEvent("join", {
      code, user_id, username, is_leader, is_spectator,
      members: Object.keys(members).length,
    });

    server.send(JSON.stringify({
      type: "welcome",
      v: PROTOCOL_V,
      you: { user_id, username, is_leader, is_spectator },
      ...(await this.snapshot()),
    }));
    if (!is_spectator) {
      this.broadcastExcept(user_id, { type: "member_joined", user_id, username });
      this.broadcast(await this.buildRoster());
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  // --- hibernation handlers ---
  async webSocketMessage(ws, message) {
    const att = ws.deserializeAttachment() || {};
    let msg;
    try { msg = JSON.parse(typeof message === "string" ? message : "{}"); }
    catch (_) { return; }

    // Drill-down: fetch one member's heavy per-hit detail (Phase 3 / C1). Safe read — allowed
    // for members AND spectators (the overlay drills in too).
    if (msg.type === "get_member_detail") {
      await this._sendMemberDetail(ws, msg.encounter_id, msg.user_id);
      return;
    }

    // Spectators (overlay) are read-only: keepalive only, no mutations.
    if (att.is_spectator) {
      if (msg.type === "ping") ws.send(JSON.stringify({ type: "pong" }));
      return;
    }

    switch (msg.type) {
      case "ping":
        ws.send(JSON.stringify({ type: "pong" }));
        return;

      case "post_fight": // member's full per-target breakdown for one fight
        if (Array.isArray(msg.targets)) {
          await this._evictGhosts(); // lazy ghost sweep before mutating roster views
          await this.postFight(att.user_id, att.username, msg.fight_ts, msg.targets, msg);
          this.broadcast(await this.buildScoreboard());
          this.broadcast(await this.buildEncounters());
        }
        return;

      // Contract item 3: backend sends {type:"final_detail", encounter_id:<fight_ts>, detail:{...}}
      // over the WS of the member whose detail this is.  We write the detail blob onto the
      // EXISTING encounter row (identified by fight_ts) without creating a new encounter.
      // `encounter_id` MUST equal the fight_ts string the backend used when posting frames.
      case "final_detail": {
        const eid = msg.encounter_id != null ? String(msg.encounter_id) : null;
        if (eid && msg.detail != null) {
          this._ensureTables();
          // Confirm the encounter row exists before writing — never create a new one.
          const exists = [...this.ctx.storage.sql.exec(
            "SELECT id FROM encounters WHERE id = ?", eid
          )];
          if (exists.length) {
            this.ctx.storage.sql.exec(
              "INSERT OR REPLACE INTO member_detail (encounter_id, user_id, blob) VALUES (?, ?, ?)",
              eid, att.user_id, JSON.stringify(msg.detail)
            );
            // Mark the submission as having detail so the UI drill-down button activates.
            this.ctx.storage.sql.exec(
              "UPDATE submissions SET has_detail = 1 WHERE encounter_id = ? AND user_id = ?",
              eid, att.user_id
            );
            logEvent("final_detail_written", {
              encounter_id: eid, user_id: att.user_id, username: att.username,
            });
            // Re-broadcast scoreboard so has_detail flag reaches the UI immediately.
            this.broadcast(await this.buildScoreboard());
            this.broadcast(await this.buildEncounters());
          } else {
            logEvent("final_detail_no_encounter", {
              encounter_id: eid, user_id: att.user_id,
            });
          }
        }
        return;
      }

      case "clear": // leader empties the active board for a fresh pull (keeps the encounter)
        if (att.is_leader) {
          const id = await this.ctx.storage.get("active_encounter_id");
          if (id) {
            this._ensureTables();
            this.ctx.storage.sql.exec("DELETE FROM submissions WHERE encounter_id = ?", id);
          }
          logEvent("clear", { by: att.username, user_id: att.user_id, encounter_id: id || null });
          this.broadcast(await this.buildScoreboard());
          this.broadcast(await this.buildEncounters());
        }
        return;

      // Contract item 2: encounter_start / encounter_end are legacy manual-boundary signals.
      // The manual Start/End UI is being removed; these messages are tolerated harmlessly.
      // They MUST NOT mint a new encounter id (that was the click-time / orphan-encounter bug).
      case "encounter_start":
        logEvent("encounter_start_noop", { by: att.username, user_id: att.user_id });
        return; // no-op

      case "encounter_end":
        logEvent("encounter_end_noop", { by: att.username, user_id: att.user_id });
        return; // no-op

      // Also tolerate the legacy party_start_recording message shape (no-op).
      case "party_start_recording":
        logEvent("party_start_recording_noop", { by: att.username, user_id: att.user_id });
        return; // no-op

      // Contract item 5: kick — leader removes a named member from roster + submissions.
      case "kick": {
        const target_uid = msg.user_id ? String(msg.user_id) : null;
        if (att.is_leader && target_uid && target_uid !== att.user_id) {
          // Close any live socket for the kicked member.
          for (const kws of this.ctx.getWebSockets(target_uid)) {
            try { kws.close(1000, "kicked"); } catch (_) {}
          }
          await this.removeMember(target_uid);
          logEvent("kick", { by: att.username, kicked: target_uid });
          this.broadcast({ type: "member_kicked", user_id: target_uid, by: att.user_id });
          this.broadcast(await this.buildRoster());
          this.broadcast(await this.buildEncounters());
        }
        return;
      }

      // Contract item 5: reset_roster — leader clears all members + submissions, room stays alive.
      case "reset_roster": {
        if (att.is_leader) {
          // Close all non-leader sockets.
          for (const rws of this.ctx.getWebSockets()) {
            const ratt = rws.deserializeAttachment() || {};
            if (ratt.user_id !== att.user_id) {
              try { rws.close(1000, "roster_reset"); } catch (_) {}
            }
          }
          this._ensureTables();
          this.ctx.storage.sql.exec("DELETE FROM submissions");
          this.ctx.storage.sql.exec("DELETE FROM member_detail");
          // Keep only the leader in the members map.
          const allMembers = (await this.ctx.storage.get("members")) || {};
          const leaderEntry = allMembers[att.user_id];
          const freshMembers = leaderEntry ? { [att.user_id]: leaderEntry } : {};
          await this.ctx.storage.put("members", freshMembers);
          logEvent("reset_roster", { by: att.username, user_id: att.user_id });
          this.broadcast({ type: "roster_reset", by: att.user_id });
          this.broadcast(await this.buildRoster());
          this.broadcast(await this.buildScoreboard());
          this.broadcast(await this.buildEncounters());
        }
        return;
      }

      case "leave":
        logEvent("leave", { user_id: att.user_id, username: att.username });
        await this.removeMember(att.user_id);
        try { ws.close(1000, "left"); } catch (_) {}
        this.broadcast(await this.buildRoster());
        this.broadcast(await this.buildEncounters());
        this.broadcastExcept(att.user_id, { type: "member_left", user_id: att.user_id });
        return;
    }
  }

  async webSocketClose(ws) {
    const att = ws.deserializeAttachment() || {};
    if (att.is_spectator) return; // not a member — nothing to update
    // Stamp last_seen so the eviction window starts from now (contract item 4).
    const members = (await this.ctx.storage.get("members")) || {};
    if (members[att.user_id]) {
      members[att.user_id].last_seen = Date.now();
      await this.ctx.storage.put("members", members);
    }
    logEvent("member_offline", { user_id: att.user_id, username: att.username });
    this.broadcast(await this.buildRoster());
    this.broadcastExcept(att.user_id, { type: "member_offline", user_id: att.user_id });
  }

  async webSocketError(ws) {
    try { await this.webSocketClose(ws); } catch (_) {}
  }

  // --- ghost eviction (contract item 4) ---
  // Removes members whose last_seen is older than GHOST_EVICT_MS AND who have no live WS.
  // Called lazily (on join, post_fight) so it never fires on an idle room.
  async _evictGhosts() {
    const members = (await this.ctx.storage.get("members")) || {};
    const online = new Set(
      this.ctx.getWebSockets().map((ws) => (ws.deserializeAttachment() || {}).user_id)
    );
    const cutoff = Date.now() - GHOST_EVICT_MS;
    const evicted = [];
    for (const [uid, m] of Object.entries(members)) {
      if (!online.has(uid) && (m.last_seen || m.joined_at || 0) < cutoff) {
        evicted.push(uid);
        delete members[uid];
      }
    }
    if (evicted.length) {
      await this.ctx.storage.put("members", members);
      for (const uid of evicted) {
        logEvent("ghost_evicted", { user_id: uid });
        this.broadcast({ type: "member_left", user_id: uid });
      }
    }
    return evicted.length;
  }

  // --- SQLite table setup ---
  // Two tables replace the single KV "encounters" blob:
  //   encounters: one row per encounter (metadata only)
  //   submissions: one row per (encounter, member) — targets JSON stored inline
  // member_detail stays as-is (already SQLite, per-hit heavy data served lazily).
  _ensureTables() {
    if (this._tablesReady) return;
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS encounters (
        id TEXT PRIMARY KEY,
        started_at INTEGER NOT NULL,
        ended INTEGER NOT NULL DEFAULT 0
      )`
    );
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS submissions (
        encounter_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        username TEXT NOT NULL,
        v INTEGER NOT NULL DEFAULT 1,
        fight_ts INTEGER NOT NULL,
        posted_at INTEGER NOT NULL,
        targets TEXT NOT NULL,
        summary TEXT,
        has_detail INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (encounter_id, user_id)
      )`
    );
    // Heavy per-hit detail table (already existed; idempotent)
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS member_detail (encounter_id TEXT, user_id TEXT, blob TEXT, PRIMARY KEY (encounter_id, user_id))"
    );
    this._tablesReady = true;
  }

  // --- encounter storage helpers ---
  // Read all encounters + their submissions from SQLite and reconstruct the same object shape
  // the rest of the code expects: { [id]: { encounter_id, started_at, ended, submissions: { [uid]: sub } } }
  async _getEncounters() {
    this._ensureTables();
    const encRows = [...this.ctx.storage.sql.exec("SELECT id, started_at, ended FROM encounters ORDER BY started_at ASC")];
    if (!encRows.length) return {};
    const subRows = [...this.ctx.storage.sql.exec(
      "SELECT encounter_id, user_id, username, v, fight_ts, posted_at, targets, summary, has_detail FROM submissions"
    )];
    const encs = {};
    for (const r of encRows) {
      encs[r.id] = {
        encounter_id: r.id,
        started_at: r.started_at,
        ended: !!r.ended,
        submissions: {},
      };
    }
    for (const s of subRows) {
      if (!encs[s.encounter_id]) continue; // orphan — skip
      let targets = [];
      try { targets = JSON.parse(s.targets); } catch (_) {}
      encs[s.encounter_id].submissions[s.user_id] = {
        user_id: s.user_id,
        username: s.username,
        v: s.v,
        fight_ts: s.fight_ts,
        posted_at: s.posted_at,
        targets,
        summary: s.summary ? (() => { try { return JSON.parse(s.summary); } catch (_) { return null; } })() : null,
        has_detail: !!s.has_detail,
      };
    }
    return encs;
  }

  // --- state mutations ---
  // Slot this member's latest fight into an encounter. SLOTTING PRECEDENCE (contract item 1+2):
  //   1. The canonical encounter key is ALWAYS `fight_ts` (the real fight-start timestamp from
  //      the backend). The worker NEVER mints a click-time Date.now() id as the encounter key.
  //   2. If a post carries `encounter_id` (= fight_ts), that IS the key — look it up or create it.
  //   3. If there is already an OPEN active encounter AND the post's fight_ts matches it, merge
  //      (multi-PC party convergence: all members' posts for the same fight share the same key).
  //   4. Legacy fallback (no fight_ts, no encounter_id): use String(fight_ts || Date.now()) so
  //      old clients still get bucketed rather than crashing, but this path should not be hit by
  //      any v2+ client.
  // A post flagged `final` marks the encounter `ended` so the NEXT fight creates a new row.
  // The room (not the client) still picks the boss at build time.
  async postFight(user_id, username, fight_ts, targets, payload = {}) {
    this._ensureTables();

    // Update last_seen so this active poster doesn't get ghost-evicted.
    const members = (await this.ctx.storage.get("members")) || {};
    if (members[user_id]) {
      members[user_id].last_seen = Date.now();
      await this.ctx.storage.put("members", members);
    }

    // Contract item 1: encounter_id from payload IS the fight_ts — honor it verbatim.
    // Fall back to the fight_ts parameter, then to server time only as a last resort.
    const postedId = payload.encounter_id != null
      ? String(payload.encounter_id)
      : fight_ts != null ? String(fight_ts) : null;
    const ts = Number(fight_ts) || Date.now();

    const activeId = await this.ctx.storage.get("active_encounter_id");

    // Check if the active encounter is open (not ended) without loading all submissions.
    let activeEnded = true;
    if (activeId) {
      const rows = [...this.ctx.storage.sql.exec("SELECT ended FROM encounters WHERE id = ?", activeId)];
      activeEnded = !rows.length || !!rows[0].ended;
    }
    // Merge into the open active encounter ONLY if the fight_ts matches (same fight).
    // If the posted id differs from the active id it's a NEW fight — don't merge across fights.
    const activeOpen = !!(activeId && !activeEnded && postedId && activeId === postedId);

    let id;
    if (activeOpen) {
      id = activeId; // (1) merge — same fight_ts, active encounter is still open
    } else if (postedId) {
      // Check if this encounter exists already
      const existing = [...this.ctx.storage.sql.exec("SELECT ended FROM encounters WHERE id = ?", postedId)];
      if (existing.length) {
        id = postedId; // (2a) existing encounter named by fight_ts
        if (!existing[0].ended) await this.ctx.storage.put("active_encounter_id", id);
      } else {
        id = postedId; // (2b) lazy-create: first submission for this fight_ts
        this.ctx.storage.sql.exec(
          "INSERT OR REPLACE INTO encounters (id, started_at, ended) VALUES (?, ?, 0)",
          id, ts
        );
        await this.ctx.storage.put("active_encounter_id", id);
        logEvent("encounter_from_fight_ts", { encounter_id: id, fight_ts: ts, by: user_id });
      }
    } else {
      // (3) Legacy fallback: no fight_ts, no encounter_id — server-assign using wall clock.
      // Should only be hit by pre-v2 clients; v2+ always carry fight_ts.
      id = String(Date.now());
      this.ctx.storage.sql.exec(
        "INSERT OR REPLACE INTO encounters (id, started_at, ended) VALUES (?, ?, 0)",
        id, Date.now()
      );
      await this.ctx.storage.put("active_encounter_id", id);
      logEvent("encounter_autostart_legacy", { encounter_id: id, by: user_id });
    }

    const v = Number(payload.v) || 1; // missing v = legacy Phase-1 client
    const postedAt = Date.now();
    const cleanTargets = targets.slice(0, 64).map((t) => ({
      target: String(t.target || "Unknown").slice(0, 80),
      total_damage: Number(t.total_damage) || 0,
      dps: Number(t.dps) || 0,
      duration: Number(t.duration) || 0,
      hits: Number(t.hits) || 0,
      crit_rate: Number(t.crit_rate) || 0,
      heavy_rate: Number(t.heavy_rate) || 0,
    }));
    const has_detail = !!(payload.skills || payload.rotation);
    const summaryJson = payload.summary != null ? JSON.stringify(payload.summary) : null;

    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO submissions
        (encounter_id, user_id, username, v, fight_ts, posted_at, targets, summary, has_detail)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, user_id, username, v,
      Number(fight_ts) || postedAt,
      postedAt,
      JSON.stringify(cleanTargets),
      summaryJson,
      has_detail ? 1 : 0
    );

    // Heavy per-hit detail -> SQLite (Phase 3 / C1): unbounded vs the 128 KiB KV cap, queryable
    // per (encounter, member), served on demand via get_member_detail. Today's clients send null
    // (no-op); C1b starts sending the full hit slice.
    if (has_detail) {
      this.ctx.storage.sql.exec(
        "INSERT OR REPLACE INTO member_detail (encounter_id, user_id, blob) VALUES (?, ?, ?)",
        id, user_id, JSON.stringify({ skills: payload.skills ?? null, rotation: payload.rotation ?? null })
      );
    }

    // Client closing a segment at a boundary -> file the encounter so the next fight rolls
    // forward to a new one instead of merging into this (now-finished) board.
    if (payload.final) {
      this.ctx.storage.sql.exec("UPDATE encounters SET ended = 1 WHERE id = ?", id);
    }

    logEvent("post_fight", {
      user_id, username, v, encounter_id: id, final: !!payload.final,
      fight_ts: Number(fight_ts) || postedAt,
      n_targets: cleanTargets.length,
      has_detail,
    });
  }

  // --- per-member heavy detail (Phase 3 / C1): SQLite-backed, off the KV board blob ---
  _ensureDetailTable() {
    // Now folded into _ensureTables(); keep this as a no-op alias for any external callers.
    this._ensureTables();
  }

  async _sendMemberDetail(ws, encounter_id, user_id) {
    let detail = { skills: null, rotation: null };
    try {
      this._ensureTables();
      const rows = [...this.ctx.storage.sql.exec(
        "SELECT blob FROM member_detail WHERE encounter_id = ? AND user_id = ?",
        String(encounter_id || ""), String(user_id || "")
      )];
      if (rows.length && rows[0].blob) detail = JSON.parse(rows[0].blob);
    } catch (_) {}
    try {
      ws.send(JSON.stringify({
        type: "member_detail", encounter_id, user_id,
        skills: detail.skills ?? null, rotation: detail.rotation ?? null,
      }));
    } catch (_) {}
  }

  async removeMember(user_id) {
    const members = (await this.ctx.storage.get("members")) || {};
    delete members[user_id];
    await this.ctx.storage.put("members", members);
    // Drop this member's submission from every encounter they appear in.
    try {
      this._ensureTables();
      this.ctx.storage.sql.exec("DELETE FROM submissions WHERE user_id = ?", user_id);
      this.ctx.storage.sql.exec("DELETE FROM member_detail WHERE user_id = ?", user_id);
    } catch (_) {}
  }

  // --- boss detection (server-side, cross-party convergence) ---
  // The boss is the target the party converged on: highest aggregate damage across all
  // members' latest submissions. A KNOWN_BOSSES entry is preferred when present (and adds a
  // category label). Trash/adds are everything that isn't the chosen boss -> excluded.
  detectBoss(submissions) {
    const agg = {}; // normalized target -> { name, damage }
    for (const sub of submissions) {
      for (const t of sub.targets) {
        const key = norm(t.target);
        if (!agg[key]) agg[key] = { name: t.target, damage: 0 };
        agg[key].damage += t.total_damage;
      }
    }
    const keys = Object.keys(agg);
    if (!keys.length) return null;
    const knownKeys = keys.filter((k) => KNOWN_BOSSES[k]);
    const pool = knownKeys.length ? knownKeys : keys;
    pool.sort((a, b) => agg[b].damage - agg[a].damage);
    const bossKey = pool[0];
    return {
      name: agg[bossKey].name,
      category: KNOWN_BOSSES[bossKey] || "unknown",
      pool_size: keys.length, // distinct targets seen across all submissions
    };
  }

  // --- views ---
  // Build the ranked boss scoreboard for ONE encounter (default: the active one). The current
  // single-board behaviour = the special case of one (active) encounter.
  async buildScoreboard(encounterId) {
    const encs = await this._getEncounters();
    const id = encounterId || (await this.ctx.storage.get("active_encounter_id")) || null;
    const enc = id && encs[id] ? encs[id] : null;
    const submissions = enc ? Object.values(enc.submissions) : [];
    const boss = this.detectBoss(submissions);
    if (!boss) {
      logEvent("scoreboard_built", { encounter_id: id, boss: null, entries: 0, total_damage: 0, submissions: submissions.length });
      return { type: "scoreboard", encounter_id: id, boss: null, boss_category: null, entries: [], total_damage: 0, updated_at: Date.now() };
    }
    logEvent("boss_detected", {
      encounter_id: id, boss: boss.name, category: boss.category,
      pool_size: boss.pool_size, submissions: submissions.length,
    });
    const bossKey = norm(boss.name);
    // Each member's damage to THE BOSS (trash filtered by definition).
    const board = [];
    for (const sub of submissions) {
      const hit = sub.targets.find((t) => norm(t.target) === bossKey);
      if (hit) board.push({ ...hit, user_id: sub.user_id, username: sub.username });
    }
    const total = board.reduce((s, e) => s + e.total_damage, 0);
    board.sort((a, b) => b.total_damage - a.total_damage);
    logEvent("scoreboard_built", { encounter_id: id, boss: boss.name, entries: board.length, total_damage: total });
    return {
      type: "scoreboard",
      encounter_id: id,
      boss: boss.name,
      boss_category: boss.category,
      total_damage: total,
      updated_at: Date.now(),
      entries: board.map((e, i) => ({
        rank: i + 1,
        user_id: e.user_id,
        username: e.username,
        total_damage: e.total_damage,
        dps: e.dps,
        duration: e.duration,
        hits: e.hits,
        crit_rate: e.crit_rate,
        heavy_rate: e.heavy_rate,
        contribution: total > 0 ? Math.round((e.total_damage / total) * 1000) / 10 : 0,
      })),
    };
  }

  // Enumeration of every stored encounter for the UI switcher (A4). One lightweight entry per
  // encounter (boss label via the same server-side detection, sorted oldest-first), plus which
  // id is active. Broadcast on welcome and whenever an encounter is created/updated/closed.
  async buildEncounters() {
    const encs = await this._getEncounters();
    const active_id = (await this.ctx.storage.get("active_encounter_id")) || null;
    const list = Object.values(encs).map((e) => {
      const subs = Object.values(e.submissions || {});
      const boss = this.detectBoss(subs);
      let total_damage = 0;
      if (boss) {
        const bk = norm(boss.name);
        for (const s of subs) {
          const hit = s.targets.find((t) => norm(t.target) === bk);
          if (hit) total_damage += hit.total_damage;
        }
      }
      return {
        encounter_id: e.encounter_id,
        boss: boss ? boss.name : null,
        boss_category: boss ? boss.category : null,
        started_at: e.started_at || 0,
        ended: !!e.ended,
        entries_n: subs.length,
        total_damage,
      };
    });
    list.sort((a, b) => a.started_at - b.started_at);
    return { type: "encounters", active_id, list };
  }

  async buildRoster() {
    const members = (await this.ctx.storage.get("members")) || {};
    const online = new Set(
      this.ctx.getWebSockets().map((ws) => (ws.deserializeAttachment() || {}).user_id)
    );
    return {
      type: "roster",
      members: Object.entries(members).map(([uid, m]) => ({
        user_id: uid,
        username: m.username,
        is_leader: !!m.is_leader,
        online: online.has(uid),
      })),
    };
  }

  async snapshot() {
    const roster = await this.buildRoster();
    const scoreboard = await this.buildScoreboard(); // active encounter
    const encounters = await this.buildEncounters();
    const encounter_active = !!(await this.ctx.storage.get("encounter_active"));
    return {
      roster: roster.members,
      scoreboard,
      encounters: encounters.list,
      active_encounter_id: encounters.active_id,
      encounter_active,
    };
  }

  // --- broadcast helpers ---
  broadcast(obj) {
    const s = JSON.stringify(obj);
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(s); } catch (_) {}
    }
  }

  broadcastExcept(user_id, obj) {
    const s = JSON.stringify(obj);
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() || {};
      if (att.user_id !== user_id) {
        try { ws.send(s); } catch (_) {}
      }
    }
  }
}
