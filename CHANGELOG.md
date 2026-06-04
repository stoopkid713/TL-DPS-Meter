# Changelog

All notable changes are documented here. Format loosely based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

---

## [1.1.0] - 2026-06-03

### Changed
- **Rebrand: ツCKヤ DPS Meter → STOOP** — new product name, palette, and visual identity.
  - App title, window chrome, sidebar wordmark, and About text updated to STOOP.
  - **Night & Brick + palette** — deep midnight navy bg (`#080C14`), brick primary (`#D96444`),
    sky secondary (`#5B92D4`), amber accent (`#F0B845`). Replaces the teal/purple CK design.
  - Font stack updated to Bebas Neue (wordmark) + Barlow Condensed + Barlow + JetBrains Mono.
  - Installer publisher updated to OhStoopKid.

---

## [1.0.3] - 2026-06-01

Party polish + quality-of-life. Validated in a live 2-player session.

### Added
- **Trophies tab** — party superlatives: hardest single hit, highest sustained DPS,
  most damage on one boss, biggest crit+heavy hit.
- **Feedback / report a bug** — a button right in the app to send feedback or a bug
  report (with optional, consent-gated diagnostics — no combat logs, no account info).
- **"Are you logging?" detection** — an unmissable warning when your combat logging is
  off, and the party leader can see which members aren't transmitting yet.
- **Crit + Heavy %** on the party scoreboard, plus a crit-heavy column in the skill breakdown.

### Changed
- **Party-first layout** — Party DPS is now the 2nd tab; the solo analysis tools tuck into
  a **Solo Lab** menu; the left sidebar auto-collapses on the party view (hover to peek) so
  the scoreboard gets more room.
- **Check for updates** is now a prominent button (checks on demand).

### Fixed
- **Boss detection** — a real, current boss list + a trash filter, so practice dummies and
  trash no longer get mistaken for bosses.
- **Buttons that did nothing now work** — Leave / Clear / Kick / Reset Roster and several
  Settings actions (they relied on a dialog the app couldn't show).
- The app no longer crashes if you accidentally open a second copy.

---

## [1.0.2] - 2026-06-01

The **Party DPS** release — the party feature is now a real, shared boss scoreboard.

### Added
- **Party DPS — live shared boss scoreboard.** Everyone in the party runs the app and
  joins the same code; each boss kill produces one merged, ranked board with every
  member's damage, contribution %, DPS, hits, and crit / heavy rates.
- **Drill into any teammate** — their full per-skill breakdown and rotation timeline,
  the same depth as your own solo view.
- **Head-to-head compare** — pick any two members and compare their skills side-by-side.
- **Multi-boss runs** — each kill is kept as its own board; flip between them with the
  encounter switcher.
- **In-game overlay** — a transparent, click-through board you can float over the game
  (`Ctrl+Shift+O` toggles click-through).
- **Easy join** — a 4-character party code or a one-click invite link.

### Fixed
- **Party breakdowns no longer get stuck on "Loading…".** Opening a teammate's breakdown
  before their fight finished could leave it spinning forever, even after their data
  arrived. Breakdowns now load reliably, update automatically the moment a teammate's
  fight ends, and show "still in combat" instead of a dead spinner.
- **No more duplicate / ghost members** after closing and reopening the app — your
  identity now persists across launches.
- **Reliable merged board** — two players who pulled the same boss a few seconds apart
  now land on one board instead of splitting into separate ones.

---

## [1.0.1] - 2026-05-30

### Fixed
- **Build-test reset now reliably starts a fresh measurement.** TL writes its combat
  log with a multi-minute lag, so a reset's file-position skip alone let stale pre-reset
  combat flood back in — the 60s window clipped to an old encounter and your real test
  was lost. Restored the original "ignore entries before the reset" timestamp filter
  (plus the file-position skip) on both the reset button and the ctrl+tab hotkey.
- **Saved runs delete again** — the confirmation now removes the row (a response field
  mismatch left it on screen even though it was deleted).
- **No more duplicate saved runs** — a double-connected window could store twin
  encounters; identical back-to-back saves are now de-duplicated.

### Added
- **UI zoom** — `Ctrl +` / `Ctrl −` / `Ctrl 0` (or Settings → Display); scales the whole
  interface and is remembered next launch.
- **Check for Updates** — Settings → Links compares your version to the latest release.
- **Diagnostics** — an opt-in internal trace layer (`TLDPS_DEBUG=1`) for faster bug triage.

---

## [1.0.0] - 2026-05-30

First public release as an owned product.

### Added
- **Rebuilt backend** — the lost-source compiled backend was reimplemented from
  scratch as fresh, owned Python (`backend/`) behind the same WebSocket contract,
  with a full pytest suite.
- **Single native window** — the app now runs in one pywebview window instead of a
  server-plus-browser-tab.
- **Two packages** — a per-user **installer** (`TL-DPS-Meter-Setup.exe`, Start Menu +
  uninstaller, data in `%LOCALAPPDATA%`) and a true-portable **zip**
  (`TL-DPS-Meter-portable.zip`, data stored next to the exe, USB-movable).
- **First-run presets** + in-app data controls (reveal data folder, reset fight data).
- MIT [LICENSE](LICENSE) + upstream [NOTICE](NOTICE).

### Changed
- Installer offers reinstall/repair/uninstall when already installed.

### Notes
- The earlier fork's frontend features (below) are preserved. The original
  reverse-engineering material (the old binaries, disassembly, and capture fixtures)
  is kept privately, out of this repo.

---

## [state-current] - 2026-05-19

The active production state. Tag `state-current` points at this commit on `main`.

### Added
- **Cross-Skill Matrix** in Compare view — side-by-side per-skill breakdown across two runs
- **Compare Key Findings** insights — auto-computed observations about run differences
- **Sidebar toggle** — collapsible navigation
- **Weapon group toggles** — filter the Weapons tab by weapon group
- `samples/encounters_sample.json` — 2.4 MB real-data fixture (sourced from the
  former `CKDPS - Copy` folder, the richest captured session) for development
  and regression testing
- `server.disasm.txt` — `pydisasm` output of `server.pyc` for backend
  reference (the only readable record — see [docs/disasm-notes.md](docs/disasm-notes.md))

### Notes
- Backend (`server.pyc`) remains binary-only. Compiled with Python 3.14;
  no automated decompiler supports that version. `server.disasm.txt` is the
  authoritative reference for backend behavior.
- Local Beta - Copy folder (the source of this state) was never pushed before
  this recovery — features above existed only on the developer's machine since
  ~mid-April.

---

## [snapshot-pre-recovery-2026-05-19] - 2026-04-08

Tag pointing at the previous `main` HEAD (commit `32b122d`), preserved before
the May 2026 recovery and reorganization. Functionally equivalent to
`state-runlab` plus minor README/HOW-TO-USE wording.

---

## [state-runlab] - 2026-04-08

### Added
- **Run Lab UI** — purpose-built side-by-side run comparison tool with skill
  matrix, cast timeline, and cast drilldown
- **Stacked DPS chart** — per-second damage broken down by skill, color-coded

---

## [state-session-queue] - 2026-04-08

### Added
- **Session Queue** — between-run workflow that auto-saves completed 60-second
  tests with placeholder tags (`__sq_*__`), inline tagging, A/B slot
  assignment for Run Lab, and bulk Save All

---

## [state-baseline] - 2026-04-07

Initial fork from [mjb6967/CKdpsApp](https://github.com/mjb6967/CKdpsApp) by SirPHz.

### Added
- Forked the v1.0 SirPHz release as-is
- Personal build tag list seeded (`4 Piece Blood`, `4 Piece Veiled`,
  `Guild Raids`, `World Boss`, `4 Piece Blood CDR`, etc.)

---

## Lineage notes

The pre-1.0 fork states above (`state-baseline` → `state-current`) and the
original reverse-engineering material are preserved privately, outside this
public repo. See [LINEAGE.md](LINEAGE.md) for the full narrative.

The sibling project [TL-DPS-Auto](https://github.com/stoopkid713/TL-DPS-Auto)
is a separate codebase — not a successor to this tool.
