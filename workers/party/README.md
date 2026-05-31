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
| `post_fight` | `{ v:2, fight_ts, targets:[...], summary, skills, rotation }` | post the full per-target breakdown for one completed fight (v2 envelope) |
| `encounter_start` | — | leader-only: arm the party for a fresh pull (clears the board, broadcasts `encounter_start`) |
| `encounter_end` | — | leader-only: signal everyone to stop recording + `post_fight` (broadcasts `encounter_end`) |
| `clear` | — | leader-only: wipe the board for a fresh pull |
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
  "rotation": null                  // Phase 3: per-second buckets
}
```

**Room → client** (JSON text frames):
| type | payload |
|---|---|
| `welcome` | `{ v:2, you, roster:[...], scoreboard:{...}, encounter_active }` — sent to the joiner (announces protocol version) |
| `roster` | `{ members:[{user_id, username, is_leader, online}] }` |
| `scoreboard` | `{ encounter_id, boss, boss_category, total_damage, updated_at, entries:[{rank, user_id, username, total_damage, dps, duration, hits, crit_rate, heavy_rate, contribution}] }` — the board for the **active** encounter |
| `encounter_start` / `encounter_end` | `{ by, encounter_id }` — leader-relayed; clients arm/stop local recording |
| `member_joined` / `member_left` / `member_offline` | `{ user_id, username? }` |
| `pong` | — |

**Boss detection:** the room aggregates damage per target across all members' latest
submissions and picks the boss = highest-aggregate-damage target (a `KNOWN_BOSSES` entry is
preferred when present and supplies the `boss_category`). Everything that isn't the boss is
trash → excluded from the board. (Phase-1: per-boss history/session view is Phase 2.)

**Encounters (F1):** storage is keyed by encounter, not member —
`encounters[encounter_id].submissions[user_id]`. `active_encounter_id` is the encounter incoming
post_fights land in. The leader's `encounter_start` **files** the closing board (marks it `ended`,
keeps it) and arms a fresh active encounter, broadcasting its `encounter_id` so every member files
under the same id. If a post_fight arrives with no armed encounter (open-world, nobody pressed
Start), the room **server-assigns** one (`encounter_autostart`). The room still broadcasts ONE (the
active) `scoreboard`; the Phase-2 switcher will expose the filed encounters.

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
