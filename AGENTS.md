# AGENTS.md — STOOP (TL-DPS-Meter)

Read-me-first context for any coding agent in this repo. **Lean by design — pointers, not
contents** (detail lives in the linked files). Hand-maintained; do not auto-generate.

## What this is
STOOP is a **DPS meter / live party scoreboard for Throne & Liberty**. It reads the game's
**local combat log** and displays damage — it does **not** compute damage from coefficients.
**North star: the party DPS scoreboard. That's the product** — judge every feature against it.

## Stack
- **Desktop app** (Windows-only): Python backend (asyncio WebSocket on localhost) + a
  single-file `index.html` frontend rendered in pywebview/WebView2; packaged with PyInstaller
  into a `.exe` (installer + portable zip).
- **Live backend:** a Cloudflare Worker + Durable Objects "party room" (`workers/party/`).
- **Overlay:** a separate transparent WebView2 window (`overlay/`).

## Reading order (resume cold here)
1. **Punchlist** — what to do next (maintained in the `tldps` Claude Code skill →
   `references/punchlist.md`).
2. **`DECISIONS.md`** — load-bearing decisions. Read the relevant entry **before** changing
   architecture; add an entry when you make a new one; mark `Superseded` on reversal.
3. **Private engineering guide** (maintainer-only, not in this public repo):
   `TL-DPS-Meter-oracle/docs/PROJECT-GUIDE/` — deep how/why, debugging playbook, gotchas, bug
   case studies. Consult before touching WebView2 / Durable Objects / PyInstaller / the parser.
4. **`CHANGELOG.md`** — what shipped, per release.

## Build / test / release
- **Test:** from `backend/`, `uv run pytest` (≈109 passed / 21 skipped — parity tests skip
  without the gitignored `gold_*` fixtures). JS: `node --check src/js/*.js party_render.js`.
- **CI** (`.github/workflows/ci.yml`): every push/PR runs pytest on windows-latest + JS
  `node --check` on ubuntu. **Tests must be host-independent** (never depend on the game being
  installed — see DECISIONS ADR-009).
- **Build:** from `backend/`, `uv run python build.py` → `dist/STOOP-Setup.exe` +
  `STOOP-portable.zip` (`--no-installer` skips Inno Setup).
- **Release:** manual GitHub Release, SemVer. Bump **both** `APP_VERSION`
  (`src/js/member-detail-tabs.js`) **and** `MyAppVersion` (`backend/installer/STOOP.iss`), then
  re-inline. A `-test` suffix never ships. (Worker auto-deploys on push to `workers/party/*`;
  the app does not — DECISIONS ADR-006.)

## Hard rules (the ones that bite)
- **Frontend:** edit the module sources in `src/js/*.js` (and `party_render.js`); the build
  **re-inlines** them into `index.html`. **Never edit the inlined copies in `index.html`.** (ADR-003)
- **Worker:** keep every change backward-compatible — many app versions are live at once — and
  do **not** deploy while parties are live. (ADR-004 / ADR-007)
- **Parallel work:** independent segments run as git-worktree "lanes" (own branch, gate-stop,
  no self-merge); the maintainer reviews + merges. Cap ~2–3 concurrent.

> Cold-start map only. Keep it short; fix any line here that goes stale.
> Decisions → `DECISIONS.md` · how/why → PROJECT-GUIDE · what's next → punchlist.
