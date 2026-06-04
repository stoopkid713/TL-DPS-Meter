# Decisions (ADR-lite)

Append-only log of **load-bearing decisions** — the ones a future session (human or AI
agent) would otherwise re-question or accidentally reverse. One short entry per decision:
*Context · Decision · Consequences*. This is the "why is it this way" layer; it pairs with
`CHANGELOG.md` (what changed, user-facing) and the project guide / gotchas (how to work).

**Before changing architecture, read the relevant entry here.** When you make a new
load-bearing call, add an entry. When a decision is reversed, mark the old one `Superseded`
and add a new entry that links back — never delete.

> Seeded 2026-06-04 from decisions already scattered across the project skill, the oracle
> gold-standard/roadmap docs, and the punchlist. Dates are the decision's origin where known,
> else the seed date.

---

## ADR-001 — Keep Python + pywebview; do NOT rewrite in Rust
**Status:** Accepted · **Date:** 2026-06-02
**Context:** Gold-standard comparison vs LOA Logs (Rust/Tauri), arcdps, etc. raised "should
this be Rust?" Recurs because comparables are native.
**Decision:** Stay on Python + pywebview/WebView2 + PyInstaller.
**Consequences:** STOOP captures by **reading the local combat-log file** — there is no
packet-capture/injection hot path where Rust's performance would matter. A rewrite buys
nothing and costs everything. Revisit only if capture ever moves off log-file reads.

## ADR-002 — Capture is log-file-read ONLY (no memory/packet/injection)
**Status:** Accepted · **Date:** 2026-06-02
**Context:** Feature requests recur for death/defensive timelines, buff-uptime,
phase-by-boss-HP — and the project sits in a ToS gray area for third-party tools.
**Decision:** Only ever read the game's local combat log. Never inject, hook, or sniff packets.
**Consequences:** Hard ban-risk posture *and* a hard feature bound: TL's log is **self-only,
outgoing-damage-only** (no incoming/heal/death/boss-HP/buff rows), so those features are **not
buildable** — the answer to "can we add X" is "is X in the log?" What IS underused: per-target
damage and `hit_type` (accuracy/hit-quality). See the roadmap doc.

## ADR-003 — Frontend ships as a single inlined index.html (inline-bundle pattern)
**Status:** Accepted · **Date:** 2026-05-31
**Context:** The frontend was modularized into `src/js/*.js` (12 modules). Tempting to serve
them as raw ES modules.
**Decision:** Author the modules in `src/js/`, but **re-inline them into one `index.html` at
build** (`build.py inline_js_modules()` / `inline_party_render()`). Never edit the inlined
copies in `index.html`; never ship raw modules.
**Consequences:** A local `file://` pywebview app gains nothing from separate module requests.
Modularization (done) is for parallel-lane editing, not runtime. **Frontend structure is
settled — features > further refactoring.**

## ADR-004 — Worker↔client wire protocol must stay backward/forward compatible
**Status:** Accepted · **Date:** 2026-06-02
**Context:** "Cluster A" shipped a coordinated worker+frontend fix; the worker deployed before
users updated the app → old clients broke in prod. The party worker always serves a **mix of
app versions** (users update on their own schedule).
**Decision:** Every worker change is **additive / capability-gated**, keyed on the `v:` protocol
version the client announces. The worker must degrade gracefully for the oldest client still in
use; never assume the matching frontend shipped.
**Consequences:** App releases become an *improvement* layer, not a hard dependency. The test
battery needs an old-client-vs-current-worker scenario. Coordinated frontend+worker fixes are
the trap.

## ADR-005 — Party lifecycle: leader-leave TRANSFERS leadership; room closes on empty/idle only
**Status:** Accepted · **Date:** 2026-06-03 · **Supersedes:** an earlier disband-on-leader-leave approach
**Context:** A brief disband-on-leader-leave design (cda24a2) killed live rooms when the leader
left and the battery had encoded that as correct.
**Decision:** Leader leaving **transfers leadership** to the next member (+ a manual "Make
Leader"). The room disbands only when **empty** (or idle-TTL). Backwards-compatible: old v1.0.3
clients get the crown via roster `is_leader`.
**Consequences:** Reversed the disband design and its battery scenario. Reset-roster evicts
only offline members, not present ones.

## ADR-006 — Two deploy lifecycles: worker auto-deploys; app is versioned + manually released
**Status:** Accepted · **Date:** 2026-06-01
**Context:** The party worker and the desktop app change at different rates and risk levels.
**Decision:** The **worker** auto-deploys on push to `workers/party/*` via git-connect
(always-latest, no version). The **app** is SemVer-versioned and shipped only via a **manual
GitHub Release**; the in-app update check compares `APP_VERSION` to the latest release tag.
Pushing `main` never ships a new app build.
**Consequences:** Don't conflate them. A push can ship worker changes with no app release. The
in-app update check is **manual-only — no auto-check** (per owner).

## ADR-007 — No worker deploy while parties are live (the quiet-gate)
**Status:** Accepted · **Date:** 2026-06-01
**Context:** The party worker is a live service. A deploy restarts the Durable Object hosting an
active party → a reconnect blip (durable state persists; it's not a data reset).
**Decision:** Before any push touching `workers/party/*` (auto-deploy) or any direct
`wrangler deploy`, confirm no/active rooms are live. Frontend-only and app pushes are safe
anytime. Override only with explicit owner say-so, logged.
**Consequences:** Worker lanes hold for a deploy window; frontend/app lanes ship freely. The
real fix (make restarts harmless) is largely in place — critical room state persists to
`ctx.storage`/SQLite; only WS connections drop and clients re-hydrate.

## ADR-008 — Feedback stored in Cloudflare KV (D1 deferred)
**Status:** Accepted · **Date:** 2026-06-01
**Context:** v1.0.3 added in-app bug/feedback reports needing a backing store.
**Decision:** Store reports in **KV** (`POST /feedback` → `{ok,ref}`). No inbox UI.
**Consequences:** Fine for low write volume + simple key reads. Reading is via the CF dashboard
/ `wrangler kv key list --remote` (the `--remote` flag is mandatory — local store returns `[]`).
Move to **D1** only if querying feedback by version/date becomes painful.

## ADR-009 — CI runs pytest on windows-latest; tests must be host-independent
**Status:** Accepted · **Date:** 2026-06-04
**Context:** The app ships Windows-only (PyInstaller + WebView2). The first CI run exposed 3
tests that passed locally only because `_log_dir()` fell back to the installed-TL default path
— i.e. they depended on the host having the game installed.
**Decision:** Run the pytest gate on **windows-latest** (test on the ship platform). Tests must
**configure their own deterministic fixtures** and never depend on `_default_log_dir()` or any
host install.
**Consequences:** CI green now reflects a clean environment, not the owner's machine. JS
`node --check` runs on ubuntu (platform-agnostic, faster). Build-gate (PyInstaller exe) is a
deferred follow-up.

## ADR-010 — Work tracking stays in markdown (not GitHub Issues) for now
**Status:** Accepted · **Date:** 2026-06-04
**Context:** The system of record is a markdown punchlist (in the project skill). GitHub Issues
were considered.
**Decision:** Keep markdown — it's cold-readable by a stateless agent (`cat` it); Issues need
API/MCP calls and add triage overhead with no payoff at solo + a-few-testers scale.
**Consequences:** Migrate (or add Issues alongside) only at a real threshold: ≥2 recurring
external contributors, OR the active list exceeds ~40–50 live items, OR user-facing issue
linkage is needed. Until then: prune the punchlist on each release; keep open/shipped separate.
