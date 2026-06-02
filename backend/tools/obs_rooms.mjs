#!/usr/bin/env node
// obs_rooms.mjs — independent ops tool for the tldps-party observability endpoints (Obs #4).
//
// Answers "is anyone using party DPS right now / what's in a given room" without a browser or
// hand-rolled curl. Hits the DEBUG_KEY-gated endpoints on the live worker:
//   GET /rooms                 -> active-party registry (this tool's default)
//   GET /party/<CODE>/debug    -> full x-ray of one room
//
// The DEBUG_KEY is resolved from (first hit wins):
//   1. env TLDPS_DEBUG_KEY
//   2. <repo>/workers/party/.obs-key   (gitignored local copy of the prod secret)
//   3. ./.obs-key next to this script
// The prod secret itself is set with `wrangler secret put DEBUG_KEY` (Cloudflare can't read a
// secret back, so .obs-key is the canonical local copy — rotate both together if it leaks).
//
// Usage:
//   node backend/tools/obs_rooms.mjs              # active party list (default)
//   node backend/tools/obs_rooms.mjs debug CODE   # x-ray one room
//   node backend/tools/obs_rooms.mjs raw          # raw /rooms JSON
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

const ageS = (ts) => (ts ? `${Math.floor((Date.now() - ts) / 1000)}s` : "?");

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

const [cmd = "rooms", arg] = process.argv.slice(2);
if (cmd === "debug") {
  if (!arg) { console.error("usage: node obs_rooms.mjs debug <CODE>"); process.exit(2); }
  console.log(JSON.stringify(await getJson(`/party/${encodeURIComponent(arg.toUpperCase())}/debug`), null, 2));
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
