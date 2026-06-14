# STOOP Project Roadmap (internal)

**Date:** 2026-06-14
**Status:** Approved (brainstorm)
**Source of truth for open work:** GitHub Projects board #1 (https://github.com/users/stoopkid713/projects/1)
**North star:** the party DPS scoreboard — judge every item against it (AGENTS.md).

This is the **internal, candid** roadmap. The trimmed public view is derived in `docs/ROADMAP.md`.
Phases are sequenced by a research-validated logic: **earn trust + reach first value → ship safely →
deepen → grow → polish.** Reliability and onboarding come first because a meter that misreports — or
that a user can't get logging turned on for — loses the user on day one.

## Research basis (2026-06-14, web)

- **DPS-meter adoption (arcdps, LOA Logs, Details!):** the sticky loop is **capture → shareable
  log/analysis**; **setup friction is the #1 recurring pain** (meters survive on setup guides + FAQs);
  cultural win = framing as **self-improvement, not toxicity**.
- **Launch sequencing / MVP:** "trust before features"; streamline the core flow to first value; limit scope.
- **Code signing:** unsigned → aggressive SmartScreen "unknown publisher"; signing removes the install
  hurdle + builds SmartScreen reputation → a real download-conversion lever.
- **Onboarding:** the **#1 churn driver** — ~67% of churn is during onboarding, 70–75% abandon in week one
  from poor onboarding; fast Time-to-First-Value (≤3 days) → ~90% retention.
- **Community/Discord:** strong word-of-mouth + fast feedback loops, **but** "don't stand up a big empty
  server early" (the empty-server trap — our own prior lesson) → keep community lean and later.

**Refinements folded in from the research:** (1) onboarding **#9 pulled into Phase 1** (it's the
Time-to-First-Value gateway); (2) share button **#50 pulled up to Phase 2** (the share-your-parse loop is
the proven meter growth engine); (3) **self-improvement framing** added to the public view.

## Dependency spine (respect this ordering)

- **#5** (encounter-combine segmentation) → unblocks **#4** (multi-phase scoreboard) + **#56** (analytics timing).
- **#56** → unblocks **Dashboard P3** (time-based tiles).
- **#58** (D1 PK collision) → must precede leaderboards (**#45/#49**) — leaderboards need clean analytics rows.
- **#34** (sim test battery + release gate) → land early; it protects every later release.
- **Client-release batch** — ship together in one signed release: **#47** accuracy/hit-quality, **#54**
  app-version stamp, **#52** tester telemetry (all need a client release).

---

## Phase 1 — Trust the meter & reach first value
*Theme: a meter that records reliably, reports the true kill total, and that a new user can actually turn on.*

- **Capture/recording reliability:** #7 recorder misses log · #6 logging-detection state machine · #14 leaving a party wipes local logs · #16 encounter switcher floods with "Recording…" · #17 60s-window truncation of long fights · #3 detail-view parse abort
- **Party correctness:** #5 encounter-combine segmentation (keystone) · #4 multi-phase scoreboard total · #12 stale party_code race (blocks party create) · #19 stale encounter after reconnect · #18 overlay stuck "Loading…"
- **Analytics integrity (capture side):** #56 fight start/end timing
- **★ Onboarding (moved up):** #9 combat-log RECORDING is a separate in-game setting users can't find → guided, in-app discovery + standardized setup steps
- **Exit criteria:** a first-time user gets logging on within minutes; recordings never silently drop; the party scoreboard shows the true kill total across phases.

## Phase 2 — Ship with confidence
*Theme: make releases safe, kill the adoption scares, and turn on the growth loop.*

- #34 internal sim test battery (`--smoke`/`--full`) + release gate
- #8 code signing (SignPath Foundation) — removes the "unknown publisher" SmartScreen wall
- **★ #50 easy share button + tiny share URL (moved up)** — the share-your-parse loop is the proven meter growth multiplier
- **Exit criteria:** every release passes an automated gate; the installer no longer trips SmartScreen; users can share a parse in one click.

## Phase 3 — Depth that retains
*Theme: match/beat the gold-standard meters; make cross-party data trustworthy.*

- #46 per-target drill-down (cheap — data already parsed, UI missing)
- Dashboard **P2 (#62)** — Live Ops + Feedback polish · Dashboard **P3** (after #56) — time-based tiles
- #58 D1 PK collision fix + #57 content_type/tier classification (clean analytics rows → enables taxonomy)
- #48 SQLite encounter index
- **Client-release batch:** #47 accuracy/hit-quality + #54 version stamp + #52 tester telemetry
- **Exit criteria:** per-target analysis in the UI; analytics rows are collision-free and classified; one signed release ships the accuracy stat + telemetry.

## Phase 4 — Reach & community
*Theme: growth loops + ecosystem — kept lean (no empty-server trap).*

- #45 leaderboard taxonomy → #49 public leaderboards (gated behind auth)
- #10 explainer content (shorts/clips/gifs) · #59 Discord support ticket bot · #51 feedback READ view/inbox
- #40 spectator JOIN mode · #44 `tldps://` join protocol handler
- **Exit criteria:** public leaderboards live on clean data; a self-serve support + content loop running.

## Phase 5 — Polish & platform
*Theme: nice-to-have depth and platform integration.*

- #36 desktop/OS integration (chrome/tray/start-at-boot/game-detect) · #38 responsive split/quarter-screen
- #39 Solo Lab (mastery-planner + pvp-calc) · #41 vanguard mode · #43 whole-folder ingest · #37 startup speed (measure first) · #53 move update button to header
- Hardening/observability: #28 tier-4 cluster · #29/#30/#31 observability · #32/#33/#35 obs docs · #21/#22/#27 low-sev bugs · #23/#24/#25/#26 frontend correctness nits
- **Exit criteria:** steady-state polish; no load-bearing gaps.

---

## Public view derivation (`docs/ROADMAP.md`)

- **Now** ← Phase 1 (benefit language: "rock-solid recording," "accurate party totals," "set up logging in seconds")
- **Next** ← Phases 2–3 ("signed installer — no scary warnings," "one-click share your parse," "per-target breakdown," "deeper analytics," "accuracy & crit stats")
- **Later** ← Phases 4–5 ("public leaderboards," "spectator mode," "desktop polish," "community tools")
- Strip all issue IDs/internal detail; lead with the **self-improvement** positioning.

## Board reconciliation (optional follow-up)

The board's `Priority` field (Now/Next/Later) roughly maps to phases (Phase 1 → Now; 2–3 → Next; 4–5 → Later).
A follow-up pass can re-tag items to match this roadmap (e.g., promote #9 onboarding to **Now**, #50 to **Next**)
and/or add a `Phase` single-select. The roadmap doc is the source of truth until then.
