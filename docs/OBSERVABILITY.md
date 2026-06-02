# Party Observability Toolkit

How to see **who's using the party-DPS feature** — live and over time — and inspect any room.
Built on the `tldps-party` Cloudflare worker (Obs #4). Everything here is **read-only** and
**auth-gated**; nothing changes party state.

---

## TL;DR — the one command

```bash
node backend/tools/obs_rooms.mjs            # who's in a party right now
node backend/tools/obs_rooms.mjs history    # usage trend over time
node backend/tools/obs_rooms.mjs debug AB12  # full x-ray of one room
```

If it prints `HTTP 404 (DEBUG_KEY unset…)`, the key isn't set up — see **Setup** below.

---

## The tools at a glance

| Tool | Answers | How |
|---|---|---|
| `obs_rooms.mjs` (default / `rooms`) | "Is anyone using it **right now**? Who?" | live list of active parties |
| `obs_rooms.mjs history` | "Is usage **growing**? When's it busiest?" | hourly snapshots, last 30 days |
| `obs_rooms.mjs debug <CODE>` | "What's **inside** this specific room?" | members, live connections, encounters, ghosts |
| `obs_rooms.mjs raw` | machine-readable `/rooms` JSON | for piping/scripting |

The CLI is the front door. Under it sit three worker endpoints (below) — you rarely call them directly.

---

## CLI reference

**Location:** `backend/tools/obs_rooms.mjs` (committed; works from any machine with the key).

**Key resolution** (first hit wins): `TLDPS_DEBUG_KEY` env var → `workers/party/.obs-key` → `./.obs-key`.

### `rooms` (default) — live usage
```
$ node backend/tools/obs_rooms.mjs
ACTIVE PARTIES: 1   (as of 2026-06-02T05:32:33Z)
  G66V  1/1 online  leader=Esha  age=1635s  last-activity=388s ago
```
- `online/member` — how many of the room's members currently have a live connection (see the
  ⚠️ stale-count caveat under **Gotchas** — this number can lag for idle members).
- `age` — how long the room has existed. `last-activity` — seconds since the room last did anything.

### `history` — usage trend
```
$ node backend/tools/obs_rooms.mjs history
USAGE TIMELINE: 14 hourly snapshots
  2026-06-02 06:00    0
  2026-06-02 07:00    1 #
  2026-06-02 08:00    3 ###
  ...
  peak: 3 concurrent parties
```
One row per hour (recorded automatically by the worker — no PC needs to be on). Empty until the
first snapshot lands at the top of the next hour.

### `debug <CODE>` — one-room x-ray
Full JSON: member list with **live** online status + idle age, spectators, every encounter +
submission, ghost candidates, the id-redirect map. This is the **authoritative** view of a single
room (its `online_count` is computed live at request time, unlike the cached `rooms` list).

---

## Endpoints (under the hood)

All gated by a shared `DEBUG_KEY` (unset → `404`; wrong key → `403`):

| Endpoint | Returns |
|---|---|
| `GET /rooms?key=<KEY>` | `{active_rooms, rooms:[{code, member_count, online_count, leader, created_at, last_activity}]}` |
| `GET /party/<CODE>/debug?key=<KEY>` | full room x-ray (live socket counts, encounters, ghosts) |
| `GET /rooms/history?key=<KEY>` | `{count, samples:[{ts, active_rooms}]}` — the hourly series |

Base URL: `https://tldps-party.kyle-526.workers.dev`.

### How it works
- **`/rooms` registry** — Durable Objects can't be enumerated, so each room writes a `room:<CODE>`
  summary into the **`ROOMS_KV`** namespace on roster changes (join/leave/kick/reset/ghost-evict).
  A 2-hour TTL means a crashed/abandoned room drops off on its own.
- **`/rooms/history`** — an hourly cron (`[triggers]` in `wrangler.toml` → the worker's
  `scheduled()` handler) samples that registry into `hist:<ts>` entries (30-day TTL).
- All writes are throttled/guarded so this never adds meaningful load or breaks the party flow.

---

## Setup (one-time) + key rotation

The key lives in **exactly two places that must match**: the Cloudflare **secret** (used by the
worker) and a **gitignored local file** (used by the CLI). Cloudflare can't show a secret back, so
the local file is the only readable copy.

```bash
cd workers/party
node -e "require('fs').writeFileSync('.obs-key', require('crypto').randomBytes(24).toString('base64url'))"
wrangler secret put DEBUG_KEY < .obs-key   # pushes the SAME value to Cloudflare
```

- **Never** declare `DEBUG_KEY` as a `[vars]` entry in `wrangler.toml` — a plaintext var of the
  same name shadows the secret and resets it to `""` on every deploy. Secrets only.
- **Lost `.obs-key`** (new machine, deleted file)? You can't recover the old secret — just run the
  two commands above to mint a fresh one. Old copies stop working, which is the point.
- The CLI also accepts `TLDPS_DEBUG_KEY` as an env var instead of the file.

---

## Operational notes / gotchas

### Is it safe to deploy the worker right now?
Pushing any change under `workers/party/*` auto-deploys and **restarts the room servers**, which
**drops live connections** (the app must reconnect, and that path isn't fully hardened yet). So
before deploying, check it's quiet:
- Trust **`last-activity` age** from `rooms` (e.g. >5 min idle = effectively dormant), and
- for certainty on a specific room, trust the **`debug <CODE>` live `online_count`**.
- **Do NOT trust the `rooms` list's `online` count** to mean "connected right now" — see below.

### ⚠️ The `rooms` "online" count can be stale
`/rooms` reads a cached registry summary that only updates when a member *does something*. An idle
or already-disconnected member stays frozen at their last state — so `rooms` can show `1/1 online`
for someone who left 10 minutes ago. The **`debug <CODE>`** x-ray computes online status from the
*live* socket set at request time and is always accurate. (Learned the hard way: a "surviving"
party turned out to be a ghost.)

### What survives a worker rebuild
- ✅ **Room data** — members list, encounters, scoreboard — lives in durable storage; a rebuild
  never wipes it. The registry/history in KV survive too.
- ❌ **Live connections** — a rebuild restarts the server; connected apps get dropped and must
  reconnect. Not yet proven to ride through cleanly. → that's why deploy timing matters.

### Stale / ghost members
A disconnected member lingers in a room's list until cleanup runs — and cleanup is **lazy** (only
fires when someone new joins or posts a fight), or the room's 2-hour TTL expires. So a room can
advertise a member who's long gone. Known behavior, on the bug list.

### Auth is fail-closed
No key set → endpoints return `404` (invisible). Wrong key → `403`. The key never leaves the
server in either case — only the comparison happens server-side.
