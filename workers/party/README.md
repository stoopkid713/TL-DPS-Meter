# tldps-party

Cloudflare **Durable Object** party relay for TL-DPS-Meter — the owned replacement for the
dead CK-Supabase party feature. One `PartyRoom` instance per party code is the **authoritative
room**: members POST their **per-target breakdown** for a fight, and the room **identifies the
boss server-side**, filters trash, and broadcasts a merged, ranked **boss scoreboard**.
Post-combat model (T&L logs flush on combat-exit) — no per-hit streaming.

Full design: `TL-DPS-Meter-oracle/docs/WORKSTREAM-B-PARTY-REBOOT.md`.

## Why boss detection lives in the worker
Single source of truth (every member sees the same boss/board), **cross-party convergence**
(the boss is the target the whole party hammered — a better signal than any one client has),
and **server-side updatable** (new T&L bosses → one `wrangler deploy`, no app reship).

## Wire protocol

**Connect (WebSocket):**
```
wss://<host>/party/<CODE>?user_id=<id>&username=<name>&leader=<0|1>[&spectator=1]
```
- `<CODE>` — 4–8 char uppercase alphanumeric party code. Cap: **12 distinct members** (reconnects free).
- `spectator=1` — read-only consumer (e.g. the overlay window): receives `welcome` + all broadcasts (roster/scoreboard) but does **not** count toward the cap, does **not** appear in the roster, and **cannot** post/clear/end. `welcome.you.is_spectator` is `true`.

**Client → room** (JSON text frames):
| type | payload | meaning |
|---|---|---|
| `post_fight` | `{ v:2, fight_ts, encounter_id?, final?, targets:[...], summary, skills, rotation }` | post the full per-target breakdown for one completed fight (v2 envelope). `encounter_id` (Phase 2) names the segment; `final:true` files it |
| `encounter_start` | — | leader-only: arm the party for a fresh pull (clears the board, broadcasts `encounter_start`) |
| `encounter_end` | — | leader-only: signal everyone to stop recording + `post_fight` (broadcasts `encounter_end`) |
| `clear` | — | leader-only: wipe the board for a fresh pull |
| `get_member_detail` | `{ encounter_id, user_id }` | fetch one member's heavy per-hit detail for an encounter (Phase 3 / C1) — replies `member_detail`. Allowed for members + spectators (read-only) |
| `leave` | — | leave the party (removes member + their data) |
| `ping` | — | keepalive → room replies `pong` |

Leader-coordinated encounters: the leader sends `encounter_start`/`encounter_end`; the room relays them so every member arms/stops local recording in sync (and a late-joiner reads `encounter_active` from `welcome`). Each member posts its own `post_fight` on stop — the room merges them into the boss scoreboard.

`post_fight` shape — **protocol v2 envelope** (the client dumps ALL targets it damaged — the room
picks the boss from `targets`). The room reads `targets` for boss detection and stores
`summary`/`skills`/`rotation` **opaquely** (Phase 3 will populate `skills`/`rotation` with no further
protocol bump). A `post_fight` with **no `v`** = a legacy Phase-1 client → stored as `v:1`, still
works (graceful rollout):
```jsonc
{
  "type": "post_fight",
  "v": 2,                           // protocol version (omitted by legacy clients = v1)
  "fight_ts": 1735600000000,        // encounter timestamp (epoch ms)
  "targets": [                      // boss-detection input (read by the room)
    { "target": "Tevent", "total_damage": 300000, "dps": 4700, "duration": 63,
      "hits": 400, "crit_rate": 42.7, "heavy_rate": 18.3 },
    { "target": "Trash Goblin", "total_damage": 50000, "dps": 800, "duration": 63,
      "hits": 120, "crit_rate": 30, "heavy_rate": 10 }
  ],
  "summary":  { "total_damage": 350000, "duration": 63 }, // opaque (overall top-level)
  "skills":   null,                 // Phase 3: per-skill array (stored opaquely until then)
  "rotation": null,                 // Phase 3: per-second buckets
  "encounter_id": "1735600000000",  // Phase 2 (A4): which segment; falls back to fight_ts
  "final": false                    // Phase 2 (A4): true on the closing post of a segment
}
```

**Room → client** (JSON text frames):
| type | payload |
|---|---|
| `welcome` | `{ v:2, you, roster:[...], scoreboard:{...}, encounters:[...], active_encounter_id, encounter_active }` — sent to the joiner (announces protocol version) |
| `roster` | `{ members:[{user_id, username, is_leader, online}] }` |
| `scoreboard` | `{ encounter_id, boss, boss_category, total_damage, updated_at, entries:[{rank, user_id, username, total_damage, dps, duration, hits, crit_rate, heavy_rate, contribution}] }` — the board for the **active** encounter |
| `encounters` | `{ active_id, list:[{ encounter_id, boss, boss_category, started_at, ended, entries_n, total_damage }] }` — enumeration of all stored encounters (oldest-first) for the switcher; broadcast on any encounter create/update/close (Phase 2 / A4) |
| `member_detail` | `{ encounter_id, user_id, skills, rotation }` — one member's heavy per-hit breakdown, served on `get_member_detail` (Phase 3 / C1). `null`s when none stored |
| `encounter_start` / `encounter_end` | `{ by, encounter_id }` — leader-relayed; clients arm/stop local recording |
| `member_joined` / `member_left` / `member_offline` | `{ user_id, username? }` |
| `pong` | — |

**Boss detection:** the room aggregates damage per target across all members' latest
submissions and picks the boss = highest-aggregate-damage target (a `KNOWN_BOSSES` entry is
preferred when present and supplies the `boss_category`). Everything that isn't the boss is
trash → excluded from the board. (Phase-1: per-boss history/session view is Phase 2.)

**Encounters (F1 + Phase 2/A4):** storage is keyed by encounter, not member —
`encounters[encounter_id].submissions[user_id]`. `active_encounter_id` is the encounter incoming
post_fights land in. The leader's `encounter_start` **files** the closing board (marks it `ended`,
keeps it) and arms a fresh active encounter, broadcasting its `encounter_id`.

**Slotting precedence (A4)** — where a `post_fight` lands:
1. **active encounter is open** (not `ended`) → slot here regardless of the post's `encounter_id`.
   This merges a multi-PC board (every member's post joins the one open active encounter; a
   continuous boss kill never crosses a boundary, so the active stays open the whole fight).
2. else **honor the post's `encounter_id`** (create it if new, make it active) — the open-world /
   solo path where the client gap-segments locally, so duplicate bosses & multi-boss runs become
   distinct encounters.
3. else **server-assign** one (`encounter_autostart`) — legacy client, no id, no active.

A post flagged **`final:true`** marks its encounter `ended`, so the next fight rolls forward to a
new encounter instead of merging. (Single-WS FIFO guarantees a `final(A)` arrives before the next
encounter's `post(B)` on that socket, so B never pollutes A's board.)

The room broadcasts the **active** `scoreboard` plus an **`encounters`** enumeration (all filed +
active boards) for the Phase-2 switcher. Stored encounters are capped at **20** per room
(`MAX_ENCOUNTERS`); the oldest (never the active) are evicted (`encounter_evicted`).

**Heavy per-hit detail (Phase 3 / C1):** the KV `"encounters"` blob (capped 128 KiB, holds the
whole room) stays **light** — top-level per-target + tiny `summary` only. A member's heavy
`skills`/`rotation` (full per-hit) goes to a **SQLite** table `member_detail(encounter_id, user_id,
blob)` (the DO is SQLite-backed; no 128 KiB-per-value cap, GBs of headroom), written on `post_fight`
and served lazily via `get_member_detail` → `member_detail`. Cleaned up on member-leave + encounter-
eviction. (Today's clients send `null` → no-op; C1b starts sending the full hit slice.)

## Local dev (no Cloudflare account needed)
```
cd workers/party
wrangler dev          # runs the DO locally in miniflare
node _test-room.mjs   # 2-client integration test (with trash targets)
```

## Validate config/build (no auth)
```
wrangler deploy --dry-run
```

## Bootstrap (one-time, to deploy live)
1. **Cloudflare account** (the business account, now under the personal email).
2. **Durable Objects:** SQLite-backed DOs are intended to be **free-tier eligible** — verify;
   only enable Workers Paid ($5/mo) if the dashboard says it's required for this worker.
3. **CF API token** ("Edit Workers" scope) → GitHub Actions secret `CLOUDFLARE_API_TOKEN`.

## Deploy
`wrangler deploy` (manual) or push to `main` (CI auto-deploys — see `.github/workflows/`).

## Observability — usage & room introspection (Obs #4)

Three read-only endpoints, all gated by a shared `DEBUG_KEY` secret (unset → `404`; wrong key → `403`):

| Endpoint | What it shows |
|---|---|
| `GET /rooms?key=<KEY>` | active parties right now — `{active_rooms, rooms:[{code, member_count, online_count, leader, created_at, last_activity}]}` |
| `GET /party/<CODE>/debug?key=<KEY>` | full x-ray of one room (members, online/ghost state, encounters, id-map) |
| `GET /rooms/history?key=<KEY>` | hourly usage timeline (`{ts, active_rooms}` series), recorded by the `scheduled()` cron |

How it works: each room writes a `room:<CODE>` summary to **`ROOMS_KV`** on roster changes (DOs can't
be enumerated, so this registry is how `/rooms` lists them); a 2 h TTL drops stale rooms. The hourly
cron (`[triggers]` in `wrangler.toml`) samples that registry into `hist:<ts>` entries (30-day TTL).

**CLI:** `node backend/tools/obs_rooms.mjs [rooms | debug <CODE> | history | raw]`.

### DEBUG_KEY — set / rotate (the one piece of housekeeping)
The key lives in exactly two places: the Cloudflare **secret** (used by the worker) and a gitignored
local file (used by the CLI). Cloudflare can't show a secret back, so the local file is the only
readable copy — they must hold the **same value**. To set or rotate:

```bash
cd workers/party
node -e "require('fs').writeFileSync('.obs-key', require('crypto').randomBytes(24).toString('base64url'))"
wrangler secret put DEBUG_KEY < .obs-key   # pushes the same value to Cloudflare
```

- **Never** put the key in `wrangler.toml` as a `[vars]` entry — a plaintext var of the same name
  shadows the secret and resets it to `""` on every deploy. Secrets-only.
- Lost `.obs-key` (new machine, deleted file)? You can't read the old secret back — just run the two
  commands above to mint a fresh key; old copies stop working, which is the point.
- The CLI also accepts `TLDPS_DEBUG_KEY` as an env var instead of the file.
