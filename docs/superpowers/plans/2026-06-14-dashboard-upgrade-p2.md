# STOOP Dashboard Upgrade — Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Flesh out the **Live Ops** drill-down (enhanced live-room x-ray + submission-completeness health metric) and **polish the Feedback** inbox (type filter + per-type counts), on top of the shipped P1 dashboard.

**Architecture:** One additive backend metric — `submission_completeness` (a pure, unit-tested transform over `encounter_analytics.submission_count` vs `party_size`) added to `buildAnalyticsBlock`. Frontend: a dedicated `renderLiveOps(data)` panel (relabel the "Live Rooms" tab → "Live Ops") and an enhanced `renderFeedback(data)` with client-side type filtering. All additive; auth and existing keys unchanged.

**Tech Stack:** Cloudflare Worker + D1, vanilla client JS + inline SVG (existing P1 `SVGChart` toolkit), `node:test`, `node --check`, `wrangler deploy --dry-run`.

**Spec:** `docs/superpowers/specs/2026-06-14-dashboard-upgrade-design.md` (P2 scope)
**Builds on:** P1 (shipped `e3e995e`). Reuses `dashboard_analytics.js` + `SVGChart`.

**Data contract — additive analytics key:**
```
submission_completeness: { avg_ratio: number, full_pct: number, n: number } | null
// avg_ratio  = mean of min(1, submission_count/party_size) over the 7d window
// full_pct   = fraction of encounters where everyone reported (submission_count >= party_size)
// n          = encounters counted (party_size > 0); null when none
```

---

## File Structure

- **Modify** `workers/party/src/dashboard_analytics.js` — add pure `computeCompleteness(rows)`; add its query to `buildAnalyticsBlock` (new `submission_completeness` key).
- **Modify** `workers/party/test/dashboard_analytics.test.mjs` — tests for `computeCompleteness` + assert the new key in the assembler.
- **Modify** `workers/party/src/dashboard.js` — relabel tab → "Live Ops"; add `renderLiveOps(data)` (rooms table + completeness card + active-rooms/hour); enhance `renderFeedback` with a type filter.

---

## Task 1: `computeCompleteness` pure transform (TDD)

**Files:**
- Modify: `workers/party/src/dashboard_analytics.js`
- Test: `workers/party/test/dashboard_analytics.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
import { computeCompleteness } from "../src/dashboard_analytics.js";

test("computeCompleteness averages capped ratio and full %", () => {
  const rows = [
    { submission_count: 4, party_size: 4 }, // ratio 1.0, full
    { submission_count: 2, party_size: 4 }, // ratio 0.5
  ];
  const c = computeCompleteness(rows);
  assert.ok(Math.abs(c.avg_ratio - 0.75) < 1e-9);
  assert.ok(Math.abs(c.full_pct - 0.5) < 1e-9);
  assert.equal(c.n, 2);
});

test("computeCompleteness skips party_size<=0 and returns null when empty", () => {
  assert.equal(computeCompleteness([{ submission_count: 3, party_size: 0 }]), null);
  assert.equal(computeCompleteness([]), null);
});

test("computeCompleteness caps ratio at 1 when over-submitted", () => {
  const c = computeCompleteness([{ submission_count: 6, party_size: 4 }]);
  assert.equal(c.avg_ratio, 1);
  assert.equal(c.full_pct, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd workers/party && node --test test/dashboard_analytics.test.mjs`
Expected: FAIL — `computeCompleteness is not a function`.

- [ ] **Step 3: Write minimal implementation** (append to `dashboard_analytics.js`)

```js
export function computeCompleteness(rows) {
  let n = 0, sum = 0, full = 0;
  for (const r of rows || []) {
    const ps = Number(r.party_size) || 0;
    const sc = Number(r.submission_count) || 0;
    if (ps <= 0) continue;
    sum += Math.min(1, sc / ps);
    if (sc >= ps) full++;
    n++;
  }
  if (!n) return null;
  return { avg_ratio: sum / n, full_pct: full / n, n };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd workers/party && node --test test/dashboard_analytics.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add workers/party/src/dashboard_analytics.js workers/party/test/dashboard_analytics.test.mjs
git commit -m "feat(dashboard): submission-completeness aggregate (P2)"
```

---

## Task 2: wire `submission_completeness` into the assembler (TDD)

**Files:**
- Modify: `workers/party/src/dashboard_analytics.js` (`buildAnalyticsBlock`)
- Test: `workers/party/test/dashboard_analytics.test.mjs`

- [ ] **Step 1: Extend the assembler test** — in the existing "assembles all sub-blocks" test, add to the fake DB map and assert:

```js
// add to fakeDB map in the assembler test:
"SELECT submission_count": [{ submission_count: 4, party_size: 4 }],
// add assertion:
assert.equal(a.submission_completeness.full_pct, 1);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd workers/party && node --test test/dashboard_analytics.test.mjs`
Expected: FAIL — `a.submission_completeness` is undefined.

- [ ] **Step 3: Add the query + key** — in `buildAnalyticsBlock`, before the `return`:

```js
  const submission_completeness = await q(env,
    "SELECT submission_count, party_size FROM encounter_analytics WHERE created_at >= ? AND party_size > 0",
    [sinceWin], computeCompleteness, null);
```

and add `submission_completeness,` to the returned object (next to `hit_quality`).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd workers/party && node --test test/dashboard_analytics.test.mjs`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add workers/party/src/dashboard_analytics.js workers/party/test/dashboard_analytics.test.mjs
git commit -m "feat(dashboard): include submission_completeness in analytics block"
```

---

## Task 3: Live Ops drill-down panel

**Files:**
- Modify: `workers/party/src/dashboard.js`

**Acceptance (contract):**
- Relabel the nav button `data-tab="rooms"` from "Live Rooms" → **"Live Ops"**.
- Add `renderLiveOps(data)` called from `load()`; it renders into the rooms panel:
  - **Submission completeness card:** from `data.analytics.submission_completeness` — show `avg_ratio` as a % big stat + `full_pct` (% of fights where everyone reported) + `n`. Null → "no data".
  - **Active rooms / hour** bars (reuse `SVGChart.bars` over `data.history.slice(-72)`).
  - The existing **live parties table** (keep the current `renderRooms` table + the staleness note).
- No new endpoint; all from the existing `/dashboard.json`. Independent null-handling (no throw).

- [ ] **Step 1:** Relabel the tab; build `renderLiveOps(data)` (completeness card + history bars + existing table) and call it from `load()`. Keep `renderRooms` for the table body. Iterate locally.
- [ ] **Step 2: Syntax** — `cd workers/party && node --check src/dashboard.js` → exit 0.
- [ ] **Step 3: Acceptance** — regenerate the preview (`node .superpowers/brainstorm/<session>/_gen.mjs` style harness, or `wrangler dev`) and confirm the Live Ops tab shows completeness + history + table; null analytics degrades cleanly.
- [ ] **Step 4: Commit**

```bash
git add workers/party/src/dashboard.js
git commit -m "feat(dashboard): Live Ops drill-down (completeness + history + rooms)"
```

---

## Task 4: Feedback polish — type filter + counts

**Files:**
- Modify: `workers/party/src/dashboard.js`

**Acceptance (contract):**
- Above the feedback list, render filter chips: **All · 🐛 Bug · 💡 Idea · 💬 Feedback**, each with its count (derived from `data.feedback` by `type`).
- Clicking a chip filters the rendered cards client-side (no refetch); "All" shows everything. Active chip is visually highlighted.
- Card styling retained from P1; empty filtered result shows an "empty" state.
- The header count (`#fb-count`) reflects the total (unchanged).

- [ ] **Step 1:** Add the chip row + a `feedbackFilter` state + filter logic in `renderFeedback`; wire chip clicks (reuse the existing `esc`/badge helpers). Iterate locally.
- [ ] **Step 2: Syntax** — `node --check src/dashboard.js` → exit 0.
- [ ] **Step 3: Acceptance** — preview/`wrangler dev`: chips show correct counts; filtering works; "All" resets.
- [ ] **Step 4: Commit**

```bash
git add workers/party/src/dashboard.js
git commit -m "feat(dashboard): feedback inbox type filter + counts"
```

---

## Task 5: Final verification + ship

- [ ] **Step 1: Unit tests** — `cd workers/party && node --test test/dashboard_analytics.test.mjs` → all PASS.
- [ ] **Step 2: Syntax** — `node --check src/dashboard.js src/dashboard_analytics.js` → exit 0.
- [ ] **Step 3: Build** — `wrangler deploy --dry-run` → bundles clean.
- [ ] **Step 4: Backward-compat** — `/dashboard.json` keeps all P1 keys; `submission_completeness` is additive under `analytics`.
- [ ] **Step 5: Live-deploy gate** — `node backend/tools/obs_rooms.mjs rooms`; deploy only when quiet (or with explicit go). Then `git push origin main`.
- [ ] **Step 6: Post-deploy smoke** — load `/dashboard?key=…`; confirm Live Ops completeness + feedback filter render against live data; `analytics.submission_completeness` present in `/dashboard.json`.
- [ ] **Step 7: Board** — move the P2 issue to Done with the commit hash.

---

## Out of scope (P3)

Time-based tiles (fight duration, DPS/sec, phase splits, gap analysis) — **blocked on #56**. Separate plan once #56 lands.
