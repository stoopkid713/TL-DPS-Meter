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

// Idle room TTL for the alarm-based self-clean (Change 1). A room is considered idle when it
// has zero online members. The alarm is re-armed on every roster mutation; if it fires and the
// room is still empty, we evict ghosts and — if the room is truly member-less — tear it down
// (delete all storage + deregister from ROOMS_KV). 10 minutes is generous enough to survive a
// short crash-reload cycle without being so long that orphaned DOs accumulate indefinitely.
const IDLE_ALARM_TTL_MS = 10 * 60 * 1000; // 10 minutes

// Merge window for concurrent same-boss submissions. Party members start combat a few seconds
// apart (different fight_ts) → their posts would otherwise create separate 1-person boards.
// When there is an OPEN active encounter and an incoming post's fight_ts is within this window
// of the active encounter's started_at, we merge it onto the active encounter rather than
// creating a new one. 30 s is generous: real party members stagger combat starts by ≤ a few
// seconds; a genuine wipe/retry has a much larger gap (travel time + respawn > 60 s).
const MERGE_WINDOW_MS = 30_000; // 30 seconds

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
const KNOWN_BOSSES = {
// @gen:known_bosses:start
  "adentus": "field_boss",
  "agile ogre spy": "boss",
  "ahzreil": "field_boss",
  "akman": "boss",
  "archwizard royal guard": "boss",
  "aridus": "field_boss",
  "arkeum golem": "boss",
  "arthur talon": "boss",
  "ascended adentus": "field_boss",
  "ascended ahzreil": "field_boss",
  "ascended aridus": "field_boss",
  "ascended arkman": "boss",
  "ascended chernobog": "field_boss",
  "ascended cornelius": "field_boss",
  "ascended daigon": "boss",
  "ascended deckman": "boss",
  "ascended deluzhnoa": "archboss",
  "ascended excavator-9": "field_boss",
  "ascended giant cordy": "archboss",
  "ascended grand aelon": "field_boss",
  "ascended junobote": "field_boss",
  "ascended kowazan": "field_boss",
  "ascended leviathan": "boss",
  "ascended lycan kowazan": "field_boss",
  "ascended malakar": "field_boss",
  "ascended manticus brothers": "boss",
  "ascended minezerok": "field_boss",
  "ascended morokai": "field_boss",
  "ascended nirma": "field_boss",
  "ascended pakilo naru": "field_boss",
  "ascended queen bellandir": "archboss",
  "ascended talus": "field_boss",
  "ascended tevent": "archboss",
  "berge": "boss",
  "bound shadowmancer": "boss",
  "calanthia": "archboss",
  "calanthia of destruction": "archboss",
  "chaos archwizard": "boss",
  "chaos golem-115": "boss",
  "chaos golem-17": "boss",
  "chaos wraith": "boss",
  "chernobog": "field_boss",
  "chief orc gatekeeper": "boss",
  "cornelius": "field_boss",
  "daigon": "boss",
  "dancing giant butcher": "boss",
  "deckman": "boss",
  "deluzhnoa": "archboss",
  "despair dark enforcer": "boss",
  "deus chimaerus": "boss",
  "dragaryle": "archboss",
  "draug": "boss",
  "dren": "boss",
  "duke magna": "dungeon_boss",
  "elleia": "boss",
  "embergourd": "boss",
  "excavator-9": "field_boss",
  "excited giant goblin": "boss",
  "exodus": "boss",
  "exploding flame desert wizard": "boss",
  "fierce orc chieftain": "boss",
  "frenzied ancient weapon": "boss",
  "frenzied red pyromancer": "boss",
  "gaitan": "dungeon_boss",
  "gaudian": "boss",
  "ghost of lazarus": "boss",
  "giant ant commander": "boss",
  "giant cordy": "archboss",
  "giant cordy ghost": "archboss",
  "giant monstrous wraith": "boss",
  "gnoller": "boss",
  "grand aelon": "field_boss",
  "grayeye": "dungeon_boss",
  "grimturg": "boss",
  "guardian of the ancient forest": "boss",
  "havres": "boss",
  "haylock": "boss",
  "heliber": "dungeon_boss",
  "immortal guardian": "boss",
  "incomplete giant goblin": "boss",
  "junobote": "field_boss",
  "kaiser crimson": "dungeon_boss",
  "kaligras": "boss",
  "karnix": "dungeon_boss",
  "kertaki": "boss",
  "king chimaerus": "dungeon_boss",
  "king khanzaizin": "boss",
  "king verte": "boss",
  "kowazan": "field_boss",
  "lacune": "dungeon_boss",
  "lazarus ghost": "boss",
  "leonardas": "boss",
  "lequirus": "dungeon_boss",
  "leviathan": "boss",
  "lightning jump attacker": "boss",
  "limuny bercant": "dungeon_boss",
  "lionhead": "boss",
  "long-armed ogre fighter": "boss",
  "lucien": "dungeon_boss",
  "lycan kowazan": "boss",
  "lyxara": "boss",
  "malakar": "field_boss",
  "manticus brothers": "boss",
  "marta": "boss",
  "mind's eye knight": "boss",
  "minezerok": "field_boss",
  "molgras": "boss",
  "morokai": "field_boss",
  "murdock": "boss",
  "nerzatum": "boss",
  "nightmare conductor": "boss",
  "nightmare's shadow": "boss",
  "nirma": "field_boss",
  "norn bercant": "boss",
  "oblivion skeleton commander": "boss",
  "old wizard's eye": "boss",
  "one-eyed ogre clubber": "boss",
  "pakilo naru": "field_boss",
  "porfos": "boss",
  "queen bellandir": "archboss",
  "radeth": "archboss",
  "resurrected zaroth": "boss",
  "revenger skeleton commander": "boss",
  "rex chimaerus": "dungeon_boss",
  "risieth": "boss",
  "roaring avolos umbramancer": "boss",
  "rough ogre shieldman": "boss",
  "rusted armor warrior": "boss",
  "scorpos": "boss",
  "shade knight": "boss",
  "shaikal": "dungeon_boss",
  "shakarux": "dungeon_boss",
  "shiwatuki": "boss",
  "star-engulfed avolos umbramancer": "boss",
  "star-engulfed dark enforcer": "boss",
  "star-engulfed demonhoof head shaman": "dungeon_boss",
  "star-engulfed eccentric gourmand": "boss",
  "star-engulfed elite grinding golem": "boss",
  "star-engulfed giant acid ant": "boss",
  "star-engulfed guard captain": "boss",
  "star-engulfed living armor archwizard": "boss",
  "star-engulfed lord commander": "boss",
  "star-engulfed monstrous wraith": "boss",
  "star-engulfed mutant chef": "boss",
  "star-engulfed reptilian butcher": "boss",
  "star-engulfed shade wizard": "boss",
  "star-engulfed shrouded knight-master golem": "boss",
  "star-engulfed wraith harbinger": "boss",
  "starving giant zombie": "boss",
  "starving shadow": "boss",
  "talus": "field_boss",
  "tarberon": "boss",
  "tevent": "archboss",
  "thorny vine witch": "boss",
  "toublek": "dungeon_boss",
  "toublek husk": "boss",
  "tower armored warrior": "boss",
  "tower chief orc": "boss",
  "tower dark enforcer": "boss",
  "tower giant ant": "boss",
  "tower giant butcher": "boss",
  "tower giant goblin": "boss",
  "tower giant zombie": "boss",
  "tower queen spider": "boss",
  "tower red pyromancer": "boss",
  "tower shadowmancer": "boss",
  "turka": "boss",
  "two-handed ogre clubber": "boss",
  "umbrakan": "boss",
  "velentra": "boss",
  "venomous queen spider": "boss",
  "verence": "boss",
  "vulkan": "archboss",
  "white-shoulder thuban": "boss",
  "zairos": "archboss",
  "zarek": "boss",
  "zaroth": "boss",
// @gen:known_bosses:end
};
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
    // Debug:    GET /party/<CODE>/debug?key=<DEBUG_KEY>  (Obs #4)
    const mDebug = url.pathname.match(/^\/party\/([A-Za-z0-9]+)\/debug$/);
    if (mDebug) {
      // Auth gate: disabled entirely if DEBUG_KEY env var is unset.
      if (!env.DEBUG_KEY) return new Response("not found", { status: 404 });
      if (url.searchParams.get("key") !== env.DEBUG_KEY) {
        return new Response("forbidden", { status: 403 });
      }
      const code = mDebug[1].toUpperCase();
      if (!CODE_RE.test(code)) return new Response("bad party code", { status: 400 });
      const id = env.PARTY_ROOM.idFromName(code);
      return env.PARTY_ROOM.get(id).fetch(request);
    }

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

    // Active-room registry (Obs #4, part B): GET /rooms?key=<DEBUG_KEY> -> live parties.
    // Same DEBUG_KEY gate as /debug (unset -> 404 invisible; wrong key -> 403). DOs can't be
    // enumerated, so each room maintains a `room:<CODE>` summary in ROOMS_KV; we list it. The
    // summary rides in KV metadata, so this is ONE list() call (no per-key gets).
    if (url.pathname === "/rooms") {
      if (!env.DEBUG_KEY) return new Response("not found", { status: 404 });
      if (url.searchParams.get("key") !== env.DEBUG_KEY) {
        return new Response("forbidden", { status: 403 });
      }
      if (!env.ROOMS_KV) {
        return new Response(JSON.stringify({ active_rooms: 0, rooms: [], note: "ROOMS_KV not bound" }, null, 2),
          { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
      }
      const { keys } = await env.ROOMS_KV.list({ prefix: "room:" });
      const rooms = keys
        .map((k) => ({ code: k.name.slice(5), ...(k.metadata || {}) }))
        .sort((a, b) => (b.last_activity || 0) - (a.last_activity || 0));
      return new Response(JSON.stringify({ active_rooms: rooms.length, ts: Date.now(), rooms }, null, 2),
        { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
    }

    // Usage timeline (Obs #4): GET /rooms/history?key=<DEBUG_KEY> -> the hourly snapshots the
    // scheduled() handler records. Returns the lightweight {ts, active_rooms} series (from KV
    // metadata) so you can see usage over time. Same DEBUG_KEY gate.
    if (url.pathname === "/rooms/history") {
      if (!env.DEBUG_KEY) return new Response("not found", { status: 404 });
      if (url.searchParams.get("key") !== env.DEBUG_KEY) {
        return new Response("forbidden", { status: 403 });
      }
      if (!env.ROOMS_KV) {
        return new Response(JSON.stringify({ samples: [], note: "ROOMS_KV not bound" }, null, 2),
          { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
      }
      const { keys } = await env.ROOMS_KV.list({ prefix: "hist:" });
      const samples = keys
        .map((k) => k.metadata || { ts: Number(k.name.slice(5)) || 0, active_rooms: null })
        .sort((a, b) => (a.ts || 0) - (b.ts || 0));
      return new Response(JSON.stringify({ count: samples.length, samples }, null, 2),
        { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
    }

    return new Response("not found", { status: 404 });
  },

  // Hourly usage snapshot (Obs #4, cron-triggered — see [triggers] in wrangler.toml). Samples
  // the live active-room registry and records a timestamped history entry so /rooms/history can
  // show a usage timeline. Pure read of ROOMS_KV + one write; no party state touched. Guards a
  // missing binding so a misconfig never throws in the scheduled context.
  async scheduled(event, env, _ctx) {
    if (!env.ROOMS_KV) return;
    try {
      const { keys } = await env.ROOMS_KV.list({ prefix: "room:" });
      const rooms = keys.map((k) => ({ code: k.name.slice(5), ...(k.metadata || {}) }));
      const ts = Date.now();
      const snapshot = {
        ts,
        active_rooms: rooms.length,
        rooms: rooms.map((r) => ({
          code: r.code, member_count: r.member_count ?? null,
          online_count: r.online_count ?? null, leader: r.leader ?? null,
        })),
      };
      logEvent("usage_snapshot", { active_rooms: snapshot.active_rooms, ts });
      // 30-day retention; light {ts, active_rooms} summary in metadata for one-call timeline reads.
      await env.ROOMS_KV.put(`hist:${ts}`, JSON.stringify(snapshot), {
        metadata: { ts, active_rooms: snapshot.active_rooms },
        expirationTtl: 2592000,
      });
    } catch (_) {}
  },
};

export class PartyRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  // --- connection (WS upgrade) + Obs #4 debug x-ray ---
  async fetch(request) {
    const url = new URL(request.url);

    // Obs #4: room introspection endpoint.
    // Route: GET /party/<CODE>/debug  (auth already verified in the global fetch handler)
    // Returns a JSON x-ray of all live room state — for active-room probing, battery assertions,
    // deploy-timing checks, and ghost/eviction debugging. No behavior change to the party flow.
    if (url.pathname.endsWith("/debug") && request.method === "GET") {
      return this._handleDebug();
    }

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
      // Stamp the room's identity once so the registry writer (no request URL) knows its own
      // code + age, then publish this room to the active-room registry (Obs #4 part B).
      if (!(await this.ctx.storage.get("code"))) await this.ctx.storage.put("code", code);
      if (!(await this.ctx.storage.get("created_at"))) await this.ctx.storage.put("created_at", Date.now());
      await this._touchRegistry();
      // Heal no-leader rooms: if this join finds a room with members but no leader
      // (orphan state seen live), _ensureLeader promotes the oldest-joined present member.
      // No-op when a leader already exists. Runs on every join so a reconnect also heals.
      await this._ensureLeader();
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
          // #14: a member's first post flips their roster has_posted false->true. Rebroadcast the
          // roster so the leader's "not logging" badge clears live (was only refreshed on
          // join/leave/kick/reset). Roster is <=12 members and post_fight is debounced -> cheap.
          this.broadcast(await this.buildRoster());
        }
        return;

      // Contract item 3: backend sends {type:"final_detail", encounter_id:<fight_ts>, detail:{...}}
      // over the WS of the member whose detail this is.  We write the detail blob onto the
      // EXISTING encounter row (identified by fight_ts) without creating a new encounter.
      // `encounter_id` MUST equal the fight_ts string the backend used when posting frames.
      // MERGE RESOLUTION: when this member's post_fight was merged onto a different (earlier)
      // active encounter, encounter_id_map holds the redirect from their fight_ts to the
      // canonical encounter id — we resolve through the map so has_detail lands on the board
      // row that is actually displayed, making drill-down reachable.
      case "final_detail": {
        const rawEid = msg.encounter_id != null ? String(msg.encounter_id) : null;
        let eid = rawEid;
        if (eid) {
          this._ensureTables();
          // Resolve through the merge-redirect map (no-op if this member wasn't merged).
          const mapRows = [...this.ctx.storage.sql.exec(
            "SELECT canonical_id FROM encounter_id_map WHERE posted_id = ?", eid
          )];
          if (mapRows.length) {
            eid = mapRows[0].canonical_id;
            logEvent("final_detail_redirected", {
              posted_id: rawEid, canonical_id: eid, user_id: att.user_id,
            });
          }
        }
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
        } else {
          logEvent("kick_rejected", {
            user_id: att.user_id, is_leader: !!att.is_leader,
            target_uid: target_uid || null, self_kick: target_uid === att.user_id,
          });
        }
        return;
      }

      // make_leader (new, additive): current leader transfers crown to a present member.
      // Old clients (v1.0.3) never send this — they simply never have the button. Backwards
      // compatible: no old-client code path changes; the result is a roster broadcast with
      // updated is_leader flags, which old clients already render as the crown.
      case "make_leader": {
        const targetUid = msg.user_id ? String(msg.user_id) : null;
        if (!att.is_leader) {
          logEvent("make_leader_rejected_not_leader", { sender: att.user_id, target: targetUid });
          return;
        }
        if (!targetUid || targetUid === att.user_id) {
          logEvent("make_leader_rejected_invalid_target", { sender: att.user_id, target: targetUid });
          return;
        }
        const mlMembers = (await this.ctx.storage.get("members")) || {};
        if (!mlMembers[targetUid]) {
          logEvent("make_leader_rejected_target_absent", { sender: att.user_id, target: targetUid });
          return;
        }
        // Transfer: demote sender, promote target.
        mlMembers[att.user_id].is_leader = false;
        mlMembers[targetUid].is_leader = true;
        await this.ctx.storage.put("members", mlMembers);
        // Update the departing leader's own WS attachment.
        for (const dws of this.ctx.getWebSockets(att.user_id)) {
          try {
            const datt = dws.deserializeAttachment() || {};
            dws.serializeAttachment({ ...datt, is_leader: false });
          } catch (_) {}
        }
        // Update the new leader's WS attachment.
        for (const nws of this.ctx.getWebSockets(targetUid)) {
          try {
            const natt = nws.deserializeAttachment() || {};
            nws.serializeAttachment({ ...natt, is_leader: true });
          } catch (_) {}
        }
        logEvent("make_leader", { from: att.user_id, to: targetUid });
        this.broadcast(await this.buildRoster());
        // Additive event: new clients act on it; old clients already see the crown update
        // in the roster broadcast above and can safely ignore leader_changed.
        this.broadcast({ type: "leader_changed", user_id: targetUid });
        return;
      }

      // Contract item 5: reset_roster — leader evicts OFFLINE (not-present) members and clears
      // their submissions. ONLINE members are kept — they are actively participating and must
      // not be disconnected by a reset. This fixes the prior behavior where reset_roster closed
      // ALL non-leader sockets including present members. Old v1.0.3 clients: the message shape
      // and roster broadcast are unchanged — they already handle roster updates gracefully.
      case "reset_roster": {
        if (att.is_leader) {
          const rrOnline = new Set(
            this.ctx.getWebSockets().map((ws) => (ws.deserializeAttachment() || {}).user_id)
          );
          const rrMembers = (await this.ctx.storage.get("members")) || {};

          // Evict ONLY offline members (not in rrOnline set).
          const evictedUids = [];
          for (const [uid, m] of Object.entries(rrMembers)) {
            if (!rrOnline.has(uid)) {
              evictedUids.push(uid);
              delete rrMembers[uid];
            }
          }

          // Clear submissions for evicted members (keep online members' combat data).
          if (evictedUids.length) {
            this._ensureTables();
            for (const uid of evictedUids) {
              this.ctx.storage.sql.exec("DELETE FROM submissions WHERE user_id = ?", uid);
              this.ctx.storage.sql.exec("DELETE FROM member_detail WHERE user_id = ?", uid);
            }
          }

          await this.ctx.storage.put("members", rrMembers);
          await this._touchRegistry();
          logEvent("reset_roster", {
            by: att.username, user_id: att.user_id,
            evicted: evictedUids.length, kept_online: rrOnline.size,
          });
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

      default:
        // Unknown / future message type — log so wrangler tail catches frames from newer
        // clients hitting an older worker, or typos in custom tooling. [observability]
        logEvent("unknown_msg_type", {
          type: msg.type != null ? String(msg.type).slice(0, 64) : null,
          user_id: att.user_id, code: att.code,
        });
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
    await this._touchRegistryThrottled(); // online_count changed; throttled (offline storms)
    this.broadcast(await this.buildRoster());
    this.broadcastExcept(att.user_id, { type: "member_offline", user_id: att.user_id });
    // Arm the idle alarm: if nobody reconnects within IDLE_ALARM_TTL_MS the room self-cleans.
    await this._armIdleAlarm();
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
      await this._touchRegistry(); // roster shrank (maybe to empty -> deregister)
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
    // Merge-redirect map: when a post's fight_ts is absorbed into an already-open active
    // encounter (concurrent same-boss submissions), record posted_id -> canonical_id so that
    // the subsequent final_detail frame (which carries the member's own fight_ts as
    // encounter_id) is written to the correct canonical encounter row instead of being dropped.
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS encounter_id_map (
        posted_id   TEXT PRIMARY KEY,
        canonical_id TEXT NOT NULL
      )`
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
  // Slot this member's latest fight into an encounter. SLOTTING PRECEDENCE (contract items 1-4):
  //   1. The canonical encounter key is ALWAYS the FIRST member's fight_ts that started the
  //      encounter. The worker NEVER mints a click-time Date.now() id as the encounter key.
  //   2. PROXIMITY MERGE (the key fix): if there is an OPEN (not ended) active encounter and the
  //      incoming post's fight_ts is within MERGE_WINDOW_MS of that encounter's started_at, merge
  //      it onto the active encounter regardless of whether the exact fight_ts matches. This covers
  //      the common case where party members engage the same boss a few seconds apart — each member's
  //      local fight_ts differs, but they're all fighting the same encounter. A mapping of
  //      (postedId → canonical active id) is written to encounter_id_map so that the subsequent
  //      final_detail frame for that member (which carries their own fight_ts as encounter_id) is
  //      written to the CORRECT encounter row. This is what makes drill-down reachable on the
  //      merged board.
  //   3. If the active encounter is ENDED, or the time gap exceeds MERGE_WINDOW_MS, honor the
  //      posted encounter_id (= fight_ts) to create/activate a new encounter. This preserves
  //      --multiboss behavior (distinct bosses stay distinct rows) and wipe/retry segmentation
  //      (the same boss re-engaged after a large gap gets a fresh encounter).
  //   4. Legacy fallback (no fight_ts, no encounter_id): server-assign using wall clock. Should
  //      only be hit by pre-v2 clients; v2+ always carry fight_ts.
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

    // Check if the active encounter exists and get its started_at for proximity check.
    // NOTE: we intentionally do NOT gate on `ended` here — concurrent members post `final:true`
    // at nearly the same time. The first one closes the encounter; subsequent members from the
    // same fight arrive moments later and should still merge in, not create orphan rows.
    // The wipe/retry guard (preventing re-merge after a genuine new encounter) comes from the
    // time-proximity window: a real wipe + re-engage is >> MERGE_WINDOW_MS away.
    let activeStartedAt = 0;
    if (activeId) {
      const rows = [...this.ctx.storage.sql.exec(
        "SELECT started_at FROM encounters WHERE id = ?", activeId
      )];
      if (rows.length) {
        activeStartedAt = rows[0].started_at || 0;
      }
    }

    // Proximity merge: merge into the most-recent active encounter when the fight_ts is within
    // MERGE_WINDOW_MS of that encounter's started_at. This covers the common case where party
    // members start combat a few seconds apart — each member's local fight_ts differs but they
    // are all on the same boss. Works even when the first member's final:true has already closed
    // the encounter, because concurrent same-boss finals arrive within seconds.
    // Exact-match (activeId === postedId) is the single-machine / same-ts case — always merge.
    // A genuinely new boss or wipe/retry has a gap >> MERGE_WINDOW_MS from the last started_at.
    const withinWindow = ts > 0 && activeStartedAt > 0
      && Math.abs(ts - activeStartedAt) <= MERGE_WINDOW_MS;
    const shouldMerge = !!(activeId && postedId && (activeId === postedId || withinWindow));

    let id;
    if (shouldMerge) {
      id = activeId; // (1)/(2) merge — same fight or within proximity window
      // If this member posted a different fight_ts, record the redirect so their final_detail
      // frame (which carries their own fight_ts as encounter_id) resolves to the canonical id.
      if (postedId && postedId !== activeId) {
        this.ctx.storage.sql.exec(
          "INSERT OR REPLACE INTO encounter_id_map (posted_id, canonical_id) VALUES (?, ?)",
          postedId, activeId
        );
        logEvent("encounter_merge", {
          posted_id: postedId, canonical_id: activeId, by: user_id,
          fight_ts: ts, active_started_at: activeStartedAt,
          delta_ms: Math.abs(ts - activeStartedAt),
        });
      }
      // If the encounter was already ended (concurrent final:true from another member), reopen
      // it so this member's data lands and the final from THIS member can close it cleanly.
      // The ended flag will be set again when this post's final:true is processed below.
      this.ctx.storage.sql.exec(
        "UPDATE encounters SET ended = 0 WHERE id = ? AND ended = 1", id
      );
    } else if (postedId) {
      // Check if this encounter exists already (e.g. a second post from the same member).
      const existing = [...this.ctx.storage.sql.exec("SELECT ended FROM encounters WHERE id = ?", postedId)];
      if (existing.length) {
        id = postedId; // (3a) existing encounter named by fight_ts
        if (!existing[0].ended) await this.ctx.storage.put("active_encounter_id", id);
      } else {
        id = postedId; // (3b) lazy-create: first submission for this fight_ts
        this.ctx.storage.sql.exec(
          "INSERT OR REPLACE INTO encounters (id, started_at, ended) VALUES (?, ?, 0)",
          id, ts
        );
        await this.ctx.storage.put("active_encounter_id", id);
        logEvent("encounter_from_fight_ts", { encounter_id: id, fight_ts: ts, by: user_id });
      }
    } else {
      // (4) Legacy fallback: no fight_ts, no encounter_id — server-assign using wall clock.
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
      crit_heavy_rate: Number(t.crit_heavy_rate) || 0,
      crit_heavy_count: Number(t.crit_heavy_count) || 0,
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

    // Hydrate one-liner: stamp encounter_active so late-joining clients receive
    // welcome.encounter_active = true (was always false because the flag was never written
    // during active combat — only cleared on disband). Safe to call on every post_fight;
    // the flag is cleared by _disbandRoom -> deleteAll(). No behavior change for existing
    // clients: they already check encounter_active in the welcome snapshot.
    await this.ctx.storage.put("encounter_active", true);

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

    await this._touchRegistryThrottled(); // keep last_activity fresh during combat (≤1 write/30s)
  }

  // --- per-member heavy detail (Phase 3 / C1): SQLite-backed, off the KV board blob ---
  _ensureDetailTable() {
    // Now folded into _ensureTables(); keep this as a no-op alias for any external callers.
    this._ensureTables();
  }

  async _sendMemberDetail(ws, encounter_id, user_id) {
    let detail = { skills: null, rotation: null };
    let found = false;
    try {
      this._ensureTables();
      const rows = [...this.ctx.storage.sql.exec(
        "SELECT blob FROM member_detail WHERE encounter_id = ? AND user_id = ?",
        String(encounter_id || ""), String(user_id || "")
      )];
      if (rows.length && rows[0].blob) { detail = JSON.parse(rows[0].blob); found = true; }
    } catch (_) {}
    // Observability (2026-05-31): the drill-down detail fetch was a blind spot — logging every
    // request bisects client-not-sending vs server-not-finding (keying) vs client-not-rendering.
    logEvent("get_member_detail", {
      encounter_id: encounter_id != null ? String(encounter_id) : null,
      user_id: user_id != null ? String(user_id) : null,
      found,
      has_skills: !!(detail && detail.skills),
      has_rotation: !!(detail && detail.rotation),
      rotation_n: (detail && Array.isArray(detail.rotation)) ? detail.rotation.length : 0,
    });
    try {
      ws.send(JSON.stringify({
        type: "member_detail", encounter_id, user_id,
        skills: detail.skills ?? null, rotation: detail.rotation ?? null,
      }));
    } catch (_) {}
  }

  async removeMember(user_id) {
    const members = (await this.ctx.storage.get("members")) || {};
    const leavingMember = members[user_id];
    const wasLeader = !!(leavingMember && leavingMember.is_leader);
    delete members[user_id];
    await this.ctx.storage.put("members", members);
    // Drop this member's submission from every encounter they appear in.
    try {
      this._ensureTables();
      this.ctx.storage.sql.exec("DELETE FROM submissions WHERE user_id = ?", user_id);
      this.ctx.storage.sql.exec("DELETE FROM member_detail WHERE user_id = ?", user_id);
    } catch (_) {}

    // Close on empty: if no members remain, tear the room down immediately.
    const remaining = Object.keys(members);
    if (remaining.length === 0) {
      logEvent("room_empty_disband", { last_user: user_id, was_leader: wasLeader });
      await this._disbandRoom();
      return; // _disbandRoom handles deregistration; nothing more to do
    }

    // Leader-leave → succession (not disband). Transfer leadership to the next present
    // (online) member so the room stays alive. Old clients never send make_leader and
    // never need to act on the succession — they just see an updated roster where a
    // different member has is_leader:true (the crown they already render). Fully backwards
    // compatible: v1.0.3 clients render the crown from the roster field.
    if (wasLeader) {
      await this._ensureLeader(members);
      // Re-read after _ensureLeader may have mutated and saved.
      const updatedMembers = (await this.ctx.storage.get("members")) || {};
      const newLeader = Object.entries(updatedMembers).find(([, m]) => m.is_leader);
      logEvent("leader_left_succession", {
        departed: user_id,
        new_leader: newLeader ? newLeader[0] : null,
        remaining: Object.keys(updatedMembers).length,
      });
    }

    await this._touchRegistry(); // roster changed (leave/kick); deregisters if now empty
    // Arm the idle alarm whenever a member leaves: if nobody reconnects within IDLE_ALARM_TTL_MS
    // the alarm handler will tear down the room.
    await this._armIdleAlarm();
  }

  // Ensure the room always has exactly one leader among present members.
  // If no leader exists (leader left, desync, or import of old state), promote the
  // oldest-joined present member. "Present" = in the members map regardless of online status,
  // which mirrors the pre-existing ghost-eviction model (a ghost still has a slot). If we
  // want to prefer an ONLINE member, we bias toward online first; fall back to any member.
  // This is also the fix for the live orphan-room state (both members is_leader:false).
  // Call this after any roster mutation that might leave the room leaderless.
  async _ensureLeader(membersArg) {
    const members = membersArg || (await this.ctx.storage.get("members")) || {};
    const ids = Object.keys(members);
    if (!ids.length) return; // empty room — no leader needed
    const alreadyLeader = ids.find((uid) => members[uid].is_leader);
    if (alreadyLeader) return; // already fine

    // No leader: pick one. Prefer online, then oldest joined.
    const online = new Set(
      this.ctx.getWebSockets().map((ws) => (ws.deserializeAttachment() || {}).user_id)
    );
    const onlineIds = ids.filter((uid) => online.has(uid));
    const pool = onlineIds.length ? onlineIds : ids;
    // Among the pool, pick the oldest-joined member (smallest joined_at).
    pool.sort((a, b) => (members[a].joined_at || 0) - (members[b].joined_at || 0));
    const picked = pool[0];
    members[picked].is_leader = true;
    await this.ctx.storage.put("members", members);

    // Also update the WS attachment so the promoted member's own is_leader flag is live.
    for (const ws of this.ctx.getWebSockets(picked)) {
      try {
        const att = ws.deserializeAttachment() || {};
        ws.serializeAttachment({ ...att, is_leader: true });
      } catch (_) {}
    }

    logEvent("leader_healed", { promoted: picked, username: members[picked].username });
    // Broadcast the updated roster so every client's crown re-renders immediately.
    this.broadcast(await this.buildRoster());
    // Additive leader_changed event — new clients can act on it; old clients ignore it.
    this.broadcast({ type: "leader_changed", user_id: picked });
  }

  // --- Change 1: room teardown helpers ---

  // Full room teardown: clear all storage and deregister from ROOMS_KV.
  // Called on leader-leave disband and from alarm() when idle TTL expires.
  async _disbandRoom() {
    // Read the room code BEFORE wiping storage, so the registry deregistration below
    // still has it (deleteAll() removes "code" too).
    let code = null;
    try { code = await this.ctx.storage.get("code"); } catch (_) {}
    try {
      // Wipe all persistent state.
      await this.ctx.storage.deleteAll();
      // Cancel any pending alarm — the room is gone.
      await this.ctx.storage.deleteAlarm();
    } catch (_) {}
    // deleteAll() drops the SQLite tables. Clear the in-memory guard so the next
    // _ensureTables() recreates them — otherwise queries hit "no such table: encounters"
    // (SQLITE_ERROR -> 500) if this DO instance handles another request after disband.
    this._tablesReady = false;
    // Deregister from the active-room registry.
    try {
      if (this.env.ROOMS_KV && code) await this.env.ROOMS_KV.delete("room:" + code);
    } catch (_) {}
    logEvent("room_disbanded", { code: code || null });
  }

  // Arm (or re-arm) the DO alarm for idle-TTL self-clean. Called after roster events that
  // could leave the room empty (member leave, webSocketClose). If an alarm is already pending
  // within IDLE_ALARM_TTL_MS we leave it alone — don't push it further out on every event.
  async _armIdleAlarm() {
    try {
      const existing = await this.ctx.storage.getAlarm();
      const target = Date.now() + IDLE_ALARM_TTL_MS;
      // Only set if no alarm is pending, or it is set too far in the future.
      if (!existing || existing > target + 60_000) {
        await this.ctx.storage.setAlarm(target);
        logEvent("idle_alarm_armed", { fires_at: target, in_ms: IDLE_ALARM_TTL_MS });
      }
    } catch (_) {}
  }

  // DO alarm() handler — called by the CF runtime when the scheduled alarm fires.
  // If the room is still empty/idle, run ghost eviction and tear it down.
  // If there are online members, the room is active — re-arm the alarm so we check again later.
  async alarm() {
    logEvent("alarm_fired", {});
    try {
      await this._evictGhosts();
      const members = (await this.ctx.storage.get("members")) || {};
      const online = new Set(
        this.ctx.getWebSockets().map((ws) => (ws.deserializeAttachment() || {}).user_id)
      );
      const hasOnline = Object.keys(members).some((uid) => online.has(uid));
      if (hasOnline) {
        // Room is active — re-arm so we check again after another TTL period.
        const target = Date.now() + IDLE_ALARM_TTL_MS;
        await this.ctx.storage.setAlarm(target);
        logEvent("alarm_room_active_rearm", { fires_at: target, member_count: Object.keys(members).length });
        return;
      }
      // Room is empty or all members are ghosts (already evicted above).
      const remaining = Object.keys((await this.ctx.storage.get("members")) || {});
      if (remaining.length === 0) {
        logEvent("alarm_idle_teardown", { reason: "no_members_after_eviction" });
        await this._disbandRoom();
      } else {
        // Ghost-only members survived eviction window — re-arm and check again.
        const target = Date.now() + IDLE_ALARM_TTL_MS;
        await this.ctx.storage.setAlarm(target);
        logEvent("alarm_ghosts_remain_rearm", { remaining: remaining.length, fires_at: target });
      }
    } catch (err) {
      logEvent("alarm_error", { error: String(err) });
    }
  }

  // --- boss detection (server-side, cross-party convergence) ---
  // The boss is the target the party converged on: highest aggregate damage across all
  // members' latest submissions. A KNOWN_BOSSES entry is preferred when present (and adds a
  // category label). Trash/adds are everything that isn't the chosen boss -> excluded.
  //
  // Trash-exclusion floor: if NONE of the targets in this submission set is a known boss,
  // return null (no boss detected) rather than crowning a Practice Dummy or training mob.
  // KNOWN_BOSSES now covers ~182 real bosses (boss + archboss from questlog), so a real
  // encounter will almost always match. Unknown-target promotion is never correct — it only
  // produced false positives (dummies, city NPCs, trash packs) in open-world/training sessions.
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
    // Trash-exclusion floor: require at least one KNOWN_BOSSES hit.
    // If nothing matches, return null so dummies/trash are never crowned as the boss.
    if (!knownKeys.length) return null;
    knownKeys.sort((a, b) => agg[b].damage - agg[a].damage);
    const bossKey = knownKeys[0];
    return {
      name: agg[bossKey].name,
      category: KNOWN_BOSSES[bossKey],
      pool_size: keys.length, // distinct targets seen across all submissions
    };
  }

  // --- Change 2: multi-phase boss aggregation helper ---
  // For a single submission, collect ALL targets that are known boss-category entries
  // (any entry in KNOWN_BOSSES), sum their damage, and recompute combined rates weighted
  // by hit count. This correctly handles multi-phase bosses (e.g. Calanthia phase-1 +
  // Calanthia of Destruction phase-2) which appear as two separate named targets in one
  // submission but belong to the same kill.
  //
  // For single-phase bosses (one matching target) the result is identical to the old
  // `find` path — no regression. Trash (non-KNOWN_BOSSES targets) is excluded by the
  // KNOWN_BOSSES gate, same as before.
  //
  // Stat merge strategy:
  //   total_damage  — summed directly.
  //   hits          — summed directly (raw count).
  //   crit_heavy_count — summed directly (raw count).
  //   crit_rate / heavy_rate / crit_heavy_rate — weighted average by hits so the combined
  //     rate reflects the actual hit distribution across phases.
  //   dps / duration — taken from the highest-damage phase (the "primary" phase); a true
  //     combined DPS would require the union of per-hit timestamps which we don't have.
  //   Other fields (target, has_detail) — taken from the highest-damage phase entry.
  _aggregateBossTargets(sub) {
    // Collect all targets that are known bosses (any category).
    const bossTargets = sub.targets.filter((t) => KNOWN_BOSSES[norm(t.target)]);
    if (!bossTargets.length) return null;

    // Sort descending by damage so [0] is the primary/highest-damage phase.
    bossTargets.sort((a, b) => (b.total_damage || 0) - (a.total_damage || 0));
    const primary = bossTargets[0];

    if (bossTargets.length === 1) {
      // Fast path: single phase — return as-is (no change in behavior).
      return primary;
    }

    // Multi-phase: aggregate.
    let totalDamage = 0;
    let totalHits = 0;
    let totalCritHeavyCount = 0;
    let weightedCrit = 0;
    let weightedHeavy = 0;
    let weightedCritHeavy = 0;

    for (const t of bossTargets) {
      const dmg = Number(t.total_damage) || 0;
      const hits = Number(t.hits) || 0;
      totalDamage += dmg;
      totalHits += hits;
      totalCritHeavyCount += Number(t.crit_heavy_count) || 0;
      // Weight rates by hits for a correct blended rate.
      weightedCrit += (Number(t.crit_rate) || 0) * hits;
      weightedHeavy += (Number(t.heavy_rate) || 0) * hits;
      weightedCritHeavy += (Number(t.crit_heavy_rate) || 0) * hits;
    }

    const combinedCritRate = totalHits > 0 ? weightedCrit / totalHits : 0;
    const combinedHeavyRate = totalHits > 0 ? weightedHeavy / totalHits : 0;
    const combinedCritHeavyRate = totalHits > 0 ? weightedCritHeavy / totalHits : 0;

    logEvent("multiphase_aggregate", {
      user_id: sub.user_id,
      phases: bossTargets.length,
      phase_names: bossTargets.map((t) => t.target),
      total_damage: totalDamage,
      primary_damage: primary.total_damage,
    });

    return {
      // Identity fields from primary phase (the detected boss name / highest-damage phase).
      target: primary.target,
      // Combined stats.
      total_damage: totalDamage,
      hits: totalHits,
      crit_rate: combinedCritRate,
      heavy_rate: combinedHeavyRate,
      crit_heavy_rate: combinedCritHeavyRate,
      crit_heavy_count: totalCritHeavyCount,
      // DPS/duration from primary — we lack timestamps to merge across phases.
      dps: Number(primary.dps) || 0,
      duration: Number(primary.duration) || 0,
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
    // Change 2: aggregate ALL known-boss targets per submission (multi-phase fix).
    // Old code: sub.targets.find(t => norm(t.target) === bossKey) — kept only the single
    // detectBoss winner, dropping other phase targets (e.g. Calanthia phase-2 dropped ~28M).
    // New code: _aggregateBossTargets sums all KNOWN_BOSSES targets in the submission.
    const board = [];
    for (const sub of submissions) {
      const hit = this._aggregateBossTargets(sub);
      if (hit) board.push({ ...hit, user_id: sub.user_id, username: sub.username, has_detail: !!sub.has_detail });
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
        crit_heavy_rate: e.crit_heavy_rate ?? 0,
        crit_heavy_count: e.crit_heavy_count ?? 0,
        has_detail: !!e.has_detail,
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
        // Change 2: use _aggregateBossTargets so multi-phase encounters report correct totals.
        for (const s of subs) {
          const hit = this._aggregateBossTargets(s);
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

    // Per-member transmit indicator (#14): surface whether each member has posted
    // at least one fight to the ACTIVE encounter so the leader can spot members
    // whose combat logging is off (connected but silent).
    //
    // A brand-new member legitimately has 0 submissions for the first ~30 s (T&L
    // flushes the log in bursts, not per-hit, so the first post arrives at the end
    // of the first combat segment).  We surface THREE states so the UI can be
    // appropriately calm for brand-new members:
    //   has_posted: true   — member posted ≥1 fight this session → "transmitting"
    //   has_posted: false  — member registered but zero posts yet
    //   joined_age_s       — seconds since joined_at so the UI can distinguish
    //                        "just arrived (≤ ~60 s)" from "been here 10 min with 0 posts"
    //
    // We query the ACTIVE encounter only (most recent context), not all time, so a
    // member who posted in a previous encounter but is silent in the current one is
    // correctly flagged as not-yet-transmitting for the current fight.
    let postedSet = new Set();
    try {
      this._ensureTables();
      const activeId = await this.ctx.storage.get("active_encounter_id");
      if (activeId) {
        const rows = [...this.ctx.storage.sql.exec(
          "SELECT user_id FROM submissions WHERE encounter_id = ?", activeId
        )];
        for (const r of rows) postedSet.add(r.user_id);
      }
    } catch (_) {}

    const now = Date.now();
    return {
      type: "roster",
      members: Object.entries(members).map(([uid, m]) => ({
        user_id: uid,
        username: m.username,
        is_leader: !!m.is_leader,
        online: online.has(uid),
        has_posted: postedSet.has(uid),
        joined_age_s: Math.floor((now - (m.joined_at || now)) / 1000),
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

  // --- Obs #4: room x-ray (debug endpoint) ---
  // Called only from _handleDebug() which is reached only after the global fetch handler
  // verifies env.DEBUG_KEY. Pure read — no mutations, no behavior change to party flow.
  async _handleDebug() {
    try {
      const members = (await this.ctx.storage.get("members")) || {};
      const active_encounter_id = (await this.ctx.storage.get("active_encounter_id")) || null;
      const encounter_active_flag = !!(await this.ctx.storage.get("encounter_active"));

      // Live socket state from hibernation registry.
      const liveSockets = this.ctx.getWebSockets();
      const onlineIds = new Set(
        liveSockets.map((ws) => (ws.deserializeAttachment() || {}).user_id).filter(Boolean)
      );

      // Member rows with online status and last_seen age.
      const now = Date.now();
      const memberList = Object.entries(members).map(([uid, m]) => ({
        user_id: uid,
        username: m.username,
        is_leader: !!m.is_leader,
        online: onlineIds.has(uid),
        last_seen: m.last_seen || m.joined_at || 0,
        last_seen_age_s: Math.floor((now - (m.last_seen || m.joined_at || now)) / 1000),
        joined_at: m.joined_at || 0,
        joined_age_s: Math.floor((now - (m.joined_at || now)) / 1000),
      }));

      // Spectators (overlay) — connected but not in members map.
      const spectatorCount = liveSockets.filter((ws) => {
        const att = ws.deserializeAttachment() || {};
        return !!att.is_spectator;
      }).length;

      // Encounters + submission counts from SQLite.
      let encounterList = [];
      let encounterIdMapRows = [];
      try {
        this._ensureTables();
        const encRows = [...this.ctx.storage.sql.exec(
          "SELECT id, started_at, ended FROM encounters ORDER BY started_at ASC"
        )];
        for (const enc of encRows) {
          const subRows = [...this.ctx.storage.sql.exec(
            "SELECT user_id, has_detail FROM submissions WHERE encounter_id = ?", enc.id
          )];
          const detailRows = [...this.ctx.storage.sql.exec(
            "SELECT user_id FROM member_detail WHERE encounter_id = ?", enc.id
          )];
          encounterList.push({
            encounter_id: enc.id,
            started_at: enc.started_at,
            started_age_s: Math.floor((now - (enc.started_at || now)) / 1000),
            ended: !!enc.ended,
            is_active: enc.id === active_encounter_id,
            submission_count: subRows.length,
            detail_count: detailRows.length,
            submitters: subRows.map((r) => ({ user_id: r.user_id, has_detail: !!r.has_detail })),
          });
        }
        encounterIdMapRows = [...this.ctx.storage.sql.exec(
          "SELECT posted_id, canonical_id FROM encounter_id_map ORDER BY posted_id ASC"
        )].map((r) => ({ posted_id: r.posted_id, canonical_id: r.canonical_id }));
      } catch (sqlErr) {
        encounterList = [{ error: String(sqlErr) }];
      }

      // Ghost candidates: offline members within / beyond eviction window.
      const ghosts = memberList
        .filter((m) => !m.online)
        .map((m) => ({
          user_id: m.user_id,
          username: m.username,
          last_seen_age_s: m.last_seen_age_s,
          evict_in_s: Math.max(0, Math.floor(GHOST_EVICT_MS / 1000) - m.last_seen_age_s),
          eligible_for_eviction: m.last_seen_age_s >= Math.floor(GHOST_EVICT_MS / 1000),
        }));

      const xray = {
        ts: now,
        member_count: memberList.length,
        online_count: onlineIds.size,
        spectator_count: spectatorCount,
        members: memberList,
        active_encounter_id,
        encounter_active_flag,
        encounter_count: encounterList.length,
        encounters: encounterList,
        encounter_id_map: encounterIdMapRows,
        ghost_candidates: ghosts,
        tables_ready: !!this._tablesReady,
      };

      logEvent("debug_xray", { member_count: xray.member_count, encounter_count: xray.encounter_count });
      return new Response(JSON.stringify(xray, null, 2), {
        status: 200,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: String(err) }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  // --- Obs #4 part B: active-room registry ---
  // Publish (or remove) this room's summary in ROOMS_KV so the worker's GET /rooms can list
  // live parties without enumerating DOs (the /debug endpoint x-rays a code you already know;
  // /rooms answers "how many parties are live right now"). Called on every roster mutation.
  // The summary rides in KV metadata so /rooms is a single list() with no per-key gets. An
  // expirationTtl is the safety net: a room that crashes without a clean leave falls off on its
  // own. Empty room -> delete the key (deregister). Guards a missing binding.
  async _touchRegistry() {
    this._lastReg = Date.now(); // reset the post_fight throttle window on any roster event
    if (!this.env.ROOMS_KV) return;
    try {
      const code = await this.ctx.storage.get("code");
      if (!code) return;
      const key = "room:" + code;
      const members = (await this.ctx.storage.get("members")) || {};
      const ids = Object.keys(members);
      if (!ids.length) { await this.env.ROOMS_KV.delete(key); return; }
      const online = new Set(
        this.ctx.getWebSockets().map((ws) => (ws.deserializeAttachment() || {}).user_id)
      );
      const leader = Object.values(members).find((m) => m.is_leader);
      const summary = {
        member_count: ids.length,
        online_count: ids.filter((u) => online.has(u)).length,
        leader: leader ? leader.username : null,
        created_at: (await this.ctx.storage.get("created_at")) || Date.now(),
        last_activity: Date.now(),
      };
      // 2 h TTL: comfortably longer than a real session; a stuck/orphaned room still expires.
      await this.env.ROOMS_KV.put(key, JSON.stringify(summary), {
        metadata: summary, expirationTtl: 7200,
      });
    } catch (_) {}
  }

  // Throttled variant for high-frequency events (post_fight, offline storms): at most one
  // registry write per 30 s, keeping well under KV's per-key write limit. Roster events call
  // _touchRegistry directly (and reset this window) so transitions are never missed.
  async _touchRegistryThrottled() {
    const now = Date.now();
    if (this._lastReg && now - this._lastReg < 30_000) return;
    await this._touchRegistry();
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
