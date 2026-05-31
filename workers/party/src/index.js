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
// Wire protocol — see README.md.

const CODE_RE = /^[A-Z0-9]{4,8}$/;
const MAX_MEMBERS = 12;

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
        }
        return;

      case "clear": // leader starts a fresh board (new pull)
        if (att.is_leader) {
          logEvent("clear", { by: att.username, user_id: att.user_id });
          await this.ctx.storage.put("fights", {});
          this.broadcast(await this.buildScoreboard());
        }
        return;

      case "encounter_start": // leader: arm the whole party for a fresh pull
        if (att.is_leader) {
          logEvent("encounter_start", { by: att.username, user_id: att.user_id });
          await this.ctx.storage.put("encounter_active", true);
          await this.ctx.storage.put("fights", {}); // fresh board for the new pull
          this.broadcast({ type: "encounter_start", by: att.username });
          this.broadcast(await this.buildScoreboard());
        }
        return;

      case "encounter_end": // leader: everyone stop recording + post their fight
        if (att.is_leader) {
          logEvent("encounter_end", { by: att.username, user_id: att.user_id });
          await this.ctx.storage.put("encounter_active", false);
          this.broadcast({ type: "encounter_end", by: att.username });
        }
        return;

      case "leave":
        logEvent("leave", { user_id: att.user_id, username: att.username });
        await this.removeMember(att.user_id);
        try { ws.close(1000, "left"); } catch (_) {}
        this.broadcast(await this.buildRoster());
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

  // --- state mutations ---
  // Store this member's latest fight: their full per-target breakdown. The room (not the
  // client) decides which target is the boss at scoreboard-build time.
  async postFight(user_id, username, fight_ts, targets, payload = {}) {
    const fights = (await this.ctx.storage.get("fights")) || {};
    const v = Number(payload.v) || 1; // missing v = legacy Phase-1 client
    fights[user_id] = {
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
      // Enrichment-ready envelope fields — stored OPAQUELY, not read yet (Phase 3 reads
      // skills/rotation). Kept null-safe so legacy clients (no envelope) store nulls.
      summary: payload.summary ?? null,
      skills: payload.skills ?? null,
      rotation: payload.rotation ?? null,
    };
    await this.ctx.storage.put("fights", fights);
    logEvent("post_fight", {
      user_id, username, v,
      fight_ts: fights[user_id].fight_ts,
      n_targets: fights[user_id].targets.length,
      has_skills: fights[user_id].skills != null,
    });
  }

  async removeMember(user_id) {
    const members = (await this.ctx.storage.get("members")) || {};
    const fights = (await this.ctx.storage.get("fights")) || {};
    delete members[user_id];
    delete fights[user_id];
    await this.ctx.storage.put("members", members);
    await this.ctx.storage.put("fights", fights);
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
  async buildScoreboard() {
    const fights = (await this.ctx.storage.get("fights")) || {};
    const submissions = Object.values(fights);
    const boss = this.detectBoss(submissions);
    if (!boss) {
      logEvent("scoreboard_built", { boss: null, entries: 0, total_damage: 0, submissions: submissions.length });
      return { type: "scoreboard", boss: null, boss_category: null, entries: [], total_damage: 0, updated_at: Date.now() };
    }
    logEvent("boss_detected", {
      boss: boss.name, category: boss.category,
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
    logEvent("scoreboard_built", { boss: boss.name, entries: board.length, total_damage: total });
    return {
      type: "scoreboard",
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
    const scoreboard = await this.buildScoreboard();
    const encounter_active = !!(await this.ctx.storage.get("encounter_active"));
    return { roster: roster.members, scoreboard, encounter_active };
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
