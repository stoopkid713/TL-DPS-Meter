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
wss://<host>/party/<CODE>?user_id=<id>&username=<name>&leader=<0|1>
```
- `<CODE>` — 4–8 char uppercase alphanumeric party code. Cap: **12 distinct members** (reconnects free).

**Client → room** (JSON text frames):
| type | payload | meaning |
|---|---|---|
| `post_fight` | `{ fight_ts, targets: [...] }` | post the full per-target breakdown for one completed fight |
| `clear` | — | leader-only: wipe the board for a fresh pull |
| `leave` | — | leave the party (removes member + their data) |
| `ping` | — | keepalive → room replies `pong` |

`post_fight` shape (the client dumps ALL targets it damaged — the room picks the boss):
```jsonc
{
  "type": "post_fight",
  "fight_ts": 1735600000000,        // encounter timestamp (epoch ms)
  "targets": [
    { "target": "Tevent", "total_damage": 300000, "dps": 4700, "duration": 63,
      "hits": 400, "crit_rate": 42.7, "heavy_rate": 18.3 },
    { "target": "Trash Goblin", "total_damage": 50000, "dps": 800, "duration": 63,
      "hits": 120, "crit_rate": 30, "heavy_rate": 10 }
  ]
}
```

**Room → client** (JSON text frames):
| type | payload |
|---|---|
| `welcome` | `{ you, roster:[...], scoreboard:{...} }` — sent to the joiner |
| `roster` | `{ members:[{user_id, username, is_leader, online}] }` |
| `scoreboard` | `{ boss, boss_category, total_damage, updated_at, entries:[{rank, user_id, username, total_damage, dps, duration, hits, crit_rate, heavy_rate, contribution}] }` |
| `member_joined` / `member_left` / `member_offline` | `{ user_id, username? }` |
| `pong` | — |

**Boss detection:** the room aggregates damage per target across all members' latest
submissions and picks the boss = highest-aggregate-damage target (a `KNOWN_BOSSES` entry is
preferred when present and supplies the `boss_category`). Everything that isn't the boss is
trash → excluded from the board. (Phase-1: per-boss history/session view is Phase 2.)

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
