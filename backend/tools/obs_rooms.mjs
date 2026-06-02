#!/usr/bin/env node
// obs_rooms.mjs — independent ops tool for the tldps-party observability endpoints (Obs #4).
//
// Answers "is anyone using party DPS right now / what's in a given room" without a browser or
// hand-rolled curl. Hits the DEBUG_KEY-gated endpoints on the live worker:
//   GET /rooms                 -> active-party registry (this tool's default)
//   GET /party/<CODE>/debug    -> full x-ray of one room
//   WS  /party/<CODE>          -> live snapshot + per-member skill detail (spectator probe)
//
// The DEBUG_KEY is resolved from (first hit wins):
//   1. env TLDPS_DEBUG_KEY
//   2. <repo>/workers/party/.obs-key   (gitignored local copy of the prod secret)
//   3. ./.obs-key next to this script
// The prod secret itself is set with `wrangler secret put DEBUG_KEY` (Cloudflare can't read a
// secret back, so .obs-key is the canonical local copy — rotate both together if it leaks).
//
// Usage:
//   node backend/tools/obs_rooms.mjs                # active party list (default)
//   node backend/tools/obs_rooms.mjs debug CODE     # x-ray one room (HTTP snapshot)
//   node backend/tools/obs_rooms.mjs ws CODE        # snapshot + skill detail (connects then exits)
//   node backend/tools/obs_rooms.mjs tail CODE      # live event stream (stays connected; Ctrl+C)
//   node backend/tools/obs_rooms.mjs export CODE    # full JSON dump: HTTP debug + WS detail
//   node backend/tools/obs_rooms.mjs history        # hourly usage timeline
//   node backend/tools/obs_rooms.mjs raw            # raw /rooms JSON
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const BASE = process.env.TLDPS_PARTY_BASE || "https://tldps-party.kyle-526.workers.dev";
const here = dirname(fileURLToPath(import.meta.url));

function resolveKey() {
  if (process.env.TLDPS_DEBUG_KEY) return process.env.TLDPS_DEBUG_KEY.trim();
  for (const p of [join(here, "../../workers/party/.obs-key"), join(here, ".obs-key")]) {
    try { const k = readFileSync(p, "utf8").trim(); if (k) return k; } catch (_) {}
  }
  return "";
}
const KEY = resolveKey();
if (!KEY) {
  console.error("No DEBUG_KEY found. Set env TLDPS_DEBUG_KEY or create workers/party/.obs-key");
  process.exit(2);
}

// ── helpers ──────────────────────────────────────────────────────────────────

const ageS = (ts) => (ts ? `${Math.floor((Date.now() - ts) / 1000)}s` : "?");

function fmtDmg(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

async function getJson(path) {
  const sep = path.includes("?") ? "&" : "?";
  const r = await fetch(`${BASE}${path}${sep}key=${encodeURIComponent(KEY)}`);
  if (r.status !== 200) {
    const hint = r.status === 403 ? " (wrong key)"
      : r.status === 404 ? " (DEBUG_KEY unset in prod, or no such room)" : "";
    console.error(`${path} -> HTTP ${r.status}${hint}`);
    process.exit(1);
  }
  return r.json();
}

function requireWebSocket() {
  if (typeof WebSocket === "undefined") {
    console.error("Native WebSocket not available. Requires Node.js 22+.");
    process.exit(1);
  }
}

function makeWsUrl(code) {
  const wsBase = BASE.replace(/^https?:\/\//, "wss://");
  const obsId = `obs_${Date.now()}`;
  return `${wsBase}/party/${encodeURIComponent(code)}?spectator=1&user_id=${encodeURIComponent(obsId)}&username=obs`;
}

// ── WS shared fetch logic ─────────────────────────────────────────────────────

// Internal: connect as spectator, grab full snapshot + all member_detail, return raw data.
// Used by both `ws` (pretty-print) and `export` (JSON dump).
async function fetchWsData(code) {
  requireWebSocket();
  const DETAIL_CAP = 50;
  const TIMEOUT_MS = 10_000;
  const ws = new WebSocket(makeWsUrl(code));
  let welcome = null;
  const detailMap = {}; // "encId:userId" -> member_detail msg
  let pendingDetail = 0;
  let finished = false;

  return new Promise((resolve) => {
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try { ws.close(); } catch (_) {}
      resolve({ welcome, detailMap });
    };

    const timer = setTimeout(() => {
      console.warn("(timed out — using partial data)");
      finish();
    }, TIMEOUT_MS);

    ws.onmessage = (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch (_) { return; }

      if (msg.type === "welcome") {
        welcome = msg;
        const userIds = (msg.roster || []).map((m) => String(m.user_id));
        const withSubs = (msg.encounters || [])
          .filter((e) => e.entries_n > 0)
          .sort((a, b) => b.started_at - a.started_at);

        const requests = [];
        outer: for (const enc of withSubs) {
          for (const uid of userIds) {
            if (requests.length >= DETAIL_CAP) break outer;
            requests.push({ encounter_id: enc.encounter_id, user_id: uid });
          }
        }
        if (requests.length === 0) { finish(); return; }
        pendingDetail = requests.length;
        for (const req of requests) {
          ws.send(JSON.stringify({ type: "get_member_detail", encounter_id: req.encounter_id, user_id: req.user_id }));
        }
        return;
      }

      if (msg.type === "member_detail") {
        if (msg.skills || msg.rotation) {
          detailMap[`${String(msg.encounter_id)}:${String(msg.user_id)}`] = msg;
        }
        if (--pendingDetail <= 0) finish();
      }
    };

    ws.onerror = (err) => {
      if (!finished) {
        const m = err.message || (err.error && err.error.message) || String(err);
        console.error("WS error:", m);
      }
      finish();
    };

    ws.onclose = () => { finish(); };
  });
}

// ── ws subcommand ─────────────────────────────────────────────────────────────

function printWsResult(welcome, detailMap) {
  if (!welcome) { console.log("(no data received)"); return; }
  const { roster = [], scoreboard, encounters = [], active_encounter_id } = welcome;

  console.log(`\nROOM SNAPSHOT  (${roster.length} member${roster.length !== 1 ? "s" : ""})`);

  if (roster.length) {
    console.log("\nROSTER:");
    for (const m of roster) {
      const role = m.is_leader ? " [leader]" : "";
      const status = m.online ? "online" : "offline";
      console.log(`  ${m.username}${role}  ${status}  joined=${m.joined_age_s}s ago`);
    }
  }

  if (scoreboard && scoreboard.entries && scoreboard.entries.length) {
    console.log(`\nACTIVE SCOREBOARD  boss=${scoreboard.boss}  enc=${scoreboard.encounter_id}`);
    for (const e of scoreboard.entries) {
      const dps = e.dps != null ? `  dps=${fmtDmg(e.dps)}` : "";
      console.log(`  #${e.rank} ${e.username}  ${fmtDmg(e.total_damage)}${dps}  hits=${e.hits}  crit=${e.crit_rate}%`);
    }
  }

  const uidToName = {};
  for (const m of roster) uidToName[String(m.user_id)] = m.username;

  console.log(`\nENCOUNTERS (${encounters.length})  active=${active_encounter_id ?? "none"}`);
  for (const enc of encounters) {
    const ts = enc.started_at ? new Date(enc.started_at).toLocaleTimeString() : "?";
    const boss = enc.boss || "(no boss / trash)";
    const state = enc.ended ? "ended" : "active";
    console.log(`  [${ts}] ${boss}  ${state}  n=${enc.entries_n}  dmg=${fmtDmg(enc.total_damage)}  id=${enc.encounter_id}`);

    const encId = String(enc.encounter_id);
    let hadDetail = false;
    for (const [key, detail] of Object.entries(detailMap)) {
      const colonIdx = key.indexOf(":");
      if (key.slice(0, colonIdx) !== encId) continue;
      const uid = key.slice(colonIdx + 1);
      const username = uidToName[uid] || uid;

      if (detail.skills && (Array.isArray(detail.skills) ? detail.skills.length : Object.keys(detail.skills).length)) {
        hadDetail = true;
        const skillArr = Array.isArray(detail.skills)
          ? detail.skills
          : Object.entries(detail.skills).map(([n, v]) => ({ name: n, ...v }));
        const total = skillArr.reduce((s, v) => s + (v.damage || 0), 0);
        const top = [...skillArr].sort((a, b) => (b.damage || 0) - (a.damage || 0)).slice(0, 5);
        console.log(`    ${username} top skills:`);
        for (const s of top) {
          const pct = total > 0 ? ((s.damage / total) * 100).toFixed(1) : "0.0";
          const hits = s.hits != null ? `  ${s.hits}h` : "";
          console.log(`      ${s.name ?? "(unknown)"}: ${fmtDmg(s.damage)} (${pct}%)${hits}`);
        }
      } else if (detail.rotation && detail.rotation.length) {
        hadDetail = true;
        console.log(`    ${username}: rotation only (${detail.rotation.length} entries)`);
      }
    }
    if (!hadDetail && enc.entries_n > 0) {
      console.log("    (no detail stored)");
    }
  }
}

async function probeWs(code) {
  console.log(`Connecting to ${code} as spectator...`);
  const { welcome, detailMap } = await fetchWsData(code);
  printWsResult(welcome, detailMap);
}

// ── tail subcommand ───────────────────────────────────────────────────────────

async function tailWs(code) {
  requireWebSocket();
  console.log(`Tailing ${code} as spectator... (Ctrl+C to stop)\n`);

  const ws = new WebSocket(makeWsUrl(code));
  const PING_MS = 25_000; // keep alive under Cloudflare's idle threshold
  let pingTimer;

  const stop = (label = "stopped") => {
    clearInterval(pingTimer);
    try { ws.close(); } catch (_) {}
    console.log(`\n[${ts()}] ${label}`);
    process.exit(0);
  };

  process.on("SIGINT", () => stop("disconnected (Ctrl+C)"));

  const ts = () => new Date().toLocaleTimeString();

  ws.onopen = () => {
    pingTimer = setInterval(() => {
      try { ws.send(JSON.stringify({ type: "ping" })); } catch (_) {}
    }, PING_MS);
  };

  ws.onmessage = (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch (_) { return; }

    switch (msg.type) {
      case "welcome": {
        const roster = msg.roster || [];
        const encs = msg.encounters || [];
        console.log(`[${ts()}] connected  ${roster.length} member(s)  ${encs.length} encounter(s)  active=${msg.active_encounter_id ?? "none"}`);
        for (const m of roster) {
          const status = m.online ? "online" : "offline";
          console.log(`          member: ${m.username}${m.is_leader ? " [leader]" : ""}  ${status}`);
        }
        break;
      }
      case "scoreboard": {
        const entries = msg.entries || [];
        const boss = msg.boss || "(no boss)";
        const total = fmtDmg(msg.total_damage || 0);
        console.log(`[${ts()}] scoreboard  boss=${boss}  total=${total}  ${entries.length} entr(ies)  enc=${msg.encounter_id ?? "?"}`);
        for (const e of entries) {
          const dps = e.dps != null ? `  dps=${fmtDmg(e.dps)}` : "";
          console.log(`          #${e.rank} ${e.username}  ${fmtDmg(e.total_damage)}  ${e.contribution}%${dps}`);
        }
        break;
      }
      case "encounters": {
        const list = msg.list || [];
        console.log(`[${ts()}] encounters  ${list.length} total  active=${msg.active_id ?? "none"}`);
        break;
      }
      case "roster": {
        const members = msg.members || [];
        console.log(`[${ts()}] roster  ${members.length} member(s)`);
        for (const m of members) {
          const status = m.online ? "online" : "offline";
          console.log(`          member: ${m.username}${m.is_leader ? " [leader]" : ""}  ${status}`);
        }
        break;
      }
      case "member_joined":
        console.log(`[${ts()}] joined   ${msg.username}  (${msg.user_id})`);
        break;
      case "member_left":
        console.log(`[${ts()}] left     ${msg.username ?? msg.user_id}`);
        break;
      case "pong":
        break; // silent keepalive ack
      default:
        console.log(`[${ts()}] ${msg.type}  ${JSON.stringify(msg).slice(0, 140)}`);
    }
  };

  ws.onerror = (err) => {
    const m = err.message || (err.error && err.error.message) || String(err);
    console.error(`[${ts()}] WS error: ${m}`);
  };

  ws.onclose = (event) => {
    clearInterval(pingTimer);
    console.log(`[${ts()}] disconnected  code=${event.code}`);
    process.exit(0);
  };

  return new Promise(() => {}); // resolved only by SIGINT or server close
}

// ── export subcommand ─────────────────────────────────────────────────────────

async function exportRoom(code) {
  process.stderr.write(`Exporting ${code}... `);

  // Fetch HTTP debug and WS data in parallel.
  const [debugData, { welcome, detailMap }] = await Promise.all([
    getJson(`/party/${encodeURIComponent(code)}/debug`),
    fetchWsData(code),
  ]);

  process.stderr.write("done\n");

  // Reshape detailMap: { "encId:uid": msg } → { encId: { uid: { skills, rotation } } }
  const memberDetail = {};
  for (const [key, detail] of Object.entries(detailMap)) {
    const colonIdx = key.indexOf(":");
    const encId = key.slice(0, colonIdx);
    const uid = key.slice(colonIdx + 1);
    if (!memberDetail[encId]) memberDetail[encId] = {};
    memberDetail[encId][uid] = { skills: detail.skills ?? null, rotation: detail.rotation ?? null };
  }

  const result = {
    code,
    exported_at: Date.now(),
    debug: debugData,
    ws_snapshot: welcome ? {
      roster: welcome.roster,
      scoreboard: welcome.scoreboard,
      encounters: welcome.encounters,
      active_encounter_id: welcome.active_encounter_id,
      encounter_active: welcome.encounter_active,
    } : null,
    member_detail: memberDetail,
  };

  console.log(JSON.stringify(result, null, 2));
}

// ── command dispatch ──────────────────────────────────────────────────────────

const [cmd = "rooms", arg] = process.argv.slice(2);
if (cmd === "ws") {
  if (!arg) { console.error("usage: node obs_rooms.mjs ws <CODE>"); process.exit(2); }
  await probeWs(arg.toUpperCase());
} else if (cmd === "tail") {
  if (!arg) { console.error("usage: node obs_rooms.mjs tail <CODE>"); process.exit(2); }
  await tailWs(arg.toUpperCase());
} else if (cmd === "export") {
  if (!arg) { console.error("usage: node obs_rooms.mjs export <CODE>"); process.exit(2); }
  await exportRoom(arg.toUpperCase());
} else if (cmd === "debug") {
  if (!arg) { console.error("usage: node obs_rooms.mjs debug <CODE>"); process.exit(2); }
  console.log(JSON.stringify(await getJson(`/party/${encodeURIComponent(arg.toUpperCase())}/debug`), null, 2));
} else if (cmd === "history") {
  const j = await getJson("/rooms/history");
  console.log(`USAGE TIMELINE: ${j.count} hourly snapshots`);
  let peak = 0;
  for (const s of j.samples) {
    if ((s.active_rooms || 0) > peak) peak = s.active_rooms || 0;
    const bar = "#".repeat(s.active_rooms || 0);
    console.log(`  ${new Date(s.ts).toISOString().slice(0, 16).replace("T", " ")}  ${String(s.active_rooms ?? "?").padStart(2)} ${bar}`);
  }
  if (!j.samples.length) console.log("  (no snapshots yet — the first lands at the top of the next hour)");
  else console.log(`  peak: ${peak} concurrent parties`);
} else if (cmd === "raw") {
  console.log(JSON.stringify(await getJson("/rooms"), null, 2));
} else {
  const j = await getJson("/rooms");
  console.log(`ACTIVE PARTIES: ${j.active_rooms}   (as of ${new Date(j.ts).toISOString()})`);
  for (const room of j.rooms) {
    console.log(`  ${room.code}  ${room.online_count}/${room.member_count} online  leader=${room.leader ?? "?"}  age=${ageS(room.created_at)}  last-activity=${ageS(room.last_activity)} ago`);
  }
  if (!j.rooms.length) console.log("  (no live parties right now)");
}
