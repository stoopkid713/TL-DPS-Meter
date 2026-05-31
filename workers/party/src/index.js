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
// TTL/eviction (A4): cap stored encounters per room so a long raid night doesn't grow
// unbounded; evict the oldest (never the active one) once over the cap.
const MAX_ENCOUNTERS = 20;

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
  tevent: "archboss",
  // add more as needed: "morokai": "archboss", "<field boss>": "field_boss", ...
};
const norm = (s) => String(s || "").trim().toLowerCase();

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
      members[user_id] = { username, is_leader, joined_at: Date.now() };
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
          await this.postFight(att.user_id, att.username, msg.fight_ts, msg.targets, msg);
          this.broadcast(await this.buildScoreboard());
          this.broadcast(await this.buildEncounters());
        }
        return;

      case "clear": // leader empties the active board for a fresh pull (keeps the encounter)
        if (att.is_leader) {
          const encs = await this._getEncounters();
          const id = await this.ctx.storage.get("active_encounter_id");
          if (id && encs[id]) { encs[id].submissions = {}; await this.ctx.storage.put("encounters", encs); }
          logEvent("clear", { by: att.username, user_id: att.user_id, encounter_id: id || null });
          this.broadcast(await this.buildScoreboard());
          this.broadcast(await this.buildEncounters());
        }
        return;

      case "encounter_start": // leader: file the current board, arm a fresh encounter for everyone
        if (att.is_leader) {
          const encs = await this._getEncounters();
          const prev = await this.ctx.storage.get("active_encounter_id");
          if (prev && encs[prev]) encs[prev].ended = true; // FILE the closing board (don't wipe)
          const id = String(Date.now());                   // leader-armed encounter id (F1b B1)
          encs[id] = { encounter_id: id, started_at: Date.now(), ended: false, submissions: {} };
          await this.ctx.storage.put("encounters", encs);
          await this.ctx.storage.put("active_encounter_id", id);
          await this.ctx.storage.put("encounter_active", true);
          logEvent("encounter_start", { by: att.username, user_id: att.user_id, encounter_id: id });
          this.broadcast({ type: "encounter_start", by: att.username, encounter_id: id });
          this.broadcast(await this.buildScoreboard());
          this.broadcast(await this.buildEncounters());
        }
        return;

      case "encounter_end": // leader: everyone stop recording + post their fight
        if (att.is_leader) {
          const encs = await this._getEncounters();
          const id = await this.ctx.storage.get("active_encounter_id");
          if (id && encs[id]) { encs[id].ended = true; await this.ctx.storage.put("encounters", encs); }
          await this.ctx.storage.put("encounter_active", false);
          logEvent("encounter_end", { by: att.username, user_id: att.user_id, encounter_id: id || null });
          this.broadcast({ type: "encounter_end", by: att.username, encounter_id: id || null });
          this.broadcast(await this.buildEncounters());
        }
        return;

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
    logEvent("member_offline", { user_id: att.user_id, username: att.username });
    this.broadcast(await this.buildRoster());
    this.broadcastExcept(att.user_id, { type: "member_offline", user_id: att.user_id });
  }

  async webSocketError(ws) {
    try { await this.webSocketClose(ws); } catch (_) {}
  }

  // --- encounter storage helpers ---
  async _getEncounters() {
    return (await this.ctx.storage.get("encounters")) || {};
  }

  // --- state mutations ---
  // Slot this member's latest fight into an encounter. SLOTTING PRECEDENCE (A4):
  //   1. If the active encounter is OPEN (not `ended`) -> slot here regardless of the post's
  //      own encounter_id. This is what merges a multi-PC board: in a coordinated party every
  //      member's post lands in the one open active encounter, and a continuous boss kill has
  //      no boundary so the active stays open the whole fight.
  //   2. Else honor the post's `encounter_id` (create it if new, make it active). This is the
  //      open-world / solo path where the client gap-segments locally: each segment posts a
  //      distinct id, so duplicate bosses & multi-boss runs become distinct encounters.
  //   3. Else (legacy client, no id, no active) the room server-assigns one (F1b fallback).
  // A post flagged `final` (A3: the client closing a segment at a boundary) marks the encounter
  // `ended`, so the NEXT fight rolls forward to a new encounter instead of merging. Single-WS
  // FIFO guarantees a final(A) is delivered before the next encounter's post(B) on that socket,
  // so B never pollutes A's board. The room (not the client) still picks the boss at build time.
  async postFight(user_id, username, fight_ts, targets, payload = {}) {
    const encs = await this._getEncounters();
    const activeId = await this.ctx.storage.get("active_encounter_id");
    const activeOpen = !!(activeId && encs[activeId] && !encs[activeId].ended);
    const postedId = payload.encounter_id != null ? String(payload.encounter_id) : null;
    const ts = Number(fight_ts) || Date.now();

    let id;
    if (activeOpen) {
      id = activeId; // (1) merge into the open active encounter
    } else if (postedId && encs[postedId]) {
      id = postedId; // (2a) an existing encounter named by the client
      if (!encs[postedId].ended) await this.ctx.storage.put("active_encounter_id", id);
    } else if (postedId) {
      id = postedId; // (2b) a fresh client-segmented encounter
      encs[id] = { encounter_id: id, started_at: ts, ended: false, submissions: {} };
      await this.ctx.storage.put("active_encounter_id", id);
      logEvent("encounter_from_post", { encounter_id: id, by: user_id });
    } else {
      id = String(Date.now()); // (3) F1b fallback: server-assigned (no leader, no client id)
      encs[id] = { encounter_id: id, started_at: Date.now(), ended: false, submissions: {} };
      await this.ctx.storage.put("active_encounter_id", id);
      logEvent("encounter_autostart", { encounter_id: id, by: user_id });
    }
    const v = Number(payload.v) || 1; // missing v = legacy Phase-1 client
    encs[id].submissions[user_id] = {
      user_id,
      username,
      v,
      fight_ts: Number(fight_ts) || Date.now(),
      posted_at: Date.now(),
      // `targets` = boss-detection input (read by buildScoreboard).
      targets: targets.slice(0, 64).map((t) => ({
        target: String(t.target || "Unknown").slice(0, 80),
        total_damage: Number(t.total_damage) || 0,
        dps: Number(t.dps) || 0,
        duration: Number(t.duration) || 0,
        hits: Number(t.hits) || 0,
        crit_rate: Number(t.crit_rate) || 0,
        heavy_rate: Number(t.heavy_rate) || 0,
      })),
      // `summary` is tiny (overall totals) — keep it in the KV blob. The HEAVY per-hit detail
      // (skills/rotation) does NOT go here (the KV "encounters" blob is capped at 128 KiB and
      // holds the whole room); it goes to a SQLite row below, fetched lazily on drill-down.
      summary: payload.summary ?? null,
      has_detail: !!(payload.skills || payload.rotation),
    };
    // Heavy per-hit detail -> SQLite (Phase 3 / C1): unbounded vs the 128 KiB KV cap, queryable
    // per (encounter, member), served on demand via get_member_detail. Today's clients send null
    // (no-op); C1b starts sending the full hit slice.
    if (payload.skills || payload.rotation) {
      this._ensureDetailTable();
      this.ctx.storage.sql.exec(
        "INSERT OR REPLACE INTO member_detail (encounter_id, user_id, blob) VALUES (?, ?, ?)",
        id, user_id, JSON.stringify({ skills: payload.skills ?? null, rotation: payload.rotation ?? null })
      );
    }
    // Client closing a segment at a boundary -> file the encounter so the next fight rolls
    // forward to a new one instead of merging into this (now-finished) board.
    if (payload.final) encs[id].ended = true;
    this._evictOldEncounters(encs, id);
    await this.ctx.storage.put("encounters", encs);
    logEvent("post_fight", {
      user_id, username, v, encounter_id: id, final: !!payload.final,
      fight_ts: encs[id].submissions[user_id].fight_ts,
      n_targets: encs[id].submissions[user_id].targets.length,
      has_detail: encs[id].submissions[user_id].has_detail,
    });
  }

  // --- per-member heavy detail (Phase 3 / C1): SQLite-backed, off the KV board blob ---
  _ensureDetailTable() {
    if (this._detailReady) return;
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS member_detail (encounter_id TEXT, user_id TEXT, blob TEXT, PRIMARY KEY (encounter_id, user_id))"
    );
    this._detailReady = true;
  }

  async _sendMemberDetail(ws, encounter_id, user_id) {
    let detail = { skills: null, rotation: null };
    try {
      this._ensureDetailTable();
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

  // TTL/eviction (A4): drop the oldest encounters once over the cap, never the one just
  // touched (`keepId`). Mutates `encs` in place; caller persists.
  _evictOldEncounters(encs, keepId) {
    let ids = Object.keys(encs);
    if (ids.length <= MAX_ENCOUNTERS) return;
    ids.sort((a, b) => (encs[a].started_at || 0) - (encs[b].started_at || 0)); // oldest first
    for (const id of ids) {
      if (Object.keys(encs).length <= MAX_ENCOUNTERS) break;
      if (id === keepId) continue;
      delete encs[id];
      try { this._ensureDetailTable(); this.ctx.storage.sql.exec("DELETE FROM member_detail WHERE encounter_id = ?", id); } catch (_) {}
      logEvent("encounter_evicted", { encounter_id: id });
    }
  }

  async removeMember(user_id) {
    const members = (await this.ctx.storage.get("members")) || {};
    delete members[user_id];
    await this.ctx.storage.put("members", members);
    // Drop this member's submission from every encounter they appear in.
    const encs = await this._getEncounters();
    let touched = false;
    for (const id of Object.keys(encs)) {
      if (encs[id].submissions && encs[id].submissions[user_id]) {
        delete encs[id].submissions[user_id];
        touched = true;
      }
    }
    if (touched) await this.ctx.storage.put("encounters", encs);
    try { this._ensureDetailTable(); this.ctx.storage.sql.exec("DELETE FROM member_detail WHERE user_id = ?", user_id); } catch (_) {}
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
