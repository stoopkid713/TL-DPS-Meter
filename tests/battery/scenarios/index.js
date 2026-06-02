'use strict';
/**
 * Scenario registry — every scenario in the battery.
 *
 * Each entry: { name, runtime, tags, fn(ctx) }
 *   runtime: 'browser'  — automated runner handles it (raw index.html + real WS → wrangler dev)
 *   runtime: 'real-app' — must pass on the built .exe (B-gate); tagged+reported, not auto-run
 *
 * tags: array of strings. 'smoke' = included in --smoke run (fast core paths).
 *
 * fn(ctx) must throw (with message) on FAIL, or return/resolve on PASS.
 * ctx = { code, wranglerHost, wranglerHttp, indexHtml, genCode, runSim, getBrowser }
 *
 * Phase-2 regression tags:
 *   'regression'    — Cluster A lifecycle / undercount regression guard
 *   'cluster-a'     — Cluster A lifecycle bug set (stale-code, ghost, disband, full-room)
 *   'expected-fail' — will FAIL against current main; goes GREEN after the fix lane merges
 */

const smokeBoot         = require('./smoke-boot');
const lifecycleBasic    = require('./lifecycle-basic');
const singleBossBoard   = require('./single-boss-board');
const drillDownBoth     = require('./drill-down-both-sides');

// ── Phase-2 regression scenarios ──────────────────────────────────────────
const staleCodeClobber      = require('./stale-code-clobber');
const reconnectNoGhost      = require('./reconnect-no-ghost');
const maxPartyChurn         = require('./max-party-churn');
const disbandOnLeaderLeave  = require('./disband-on-leader-leave');
const idleTtl               = require('./idle-ttl');
const multiPhaseUndercount  = require('./multi-phase-undercount');

const scenarios = [
  // ── S1.3 SMOKE SCENARIOS (runtime: browser) ────────────────────────────
  {
    name:    'boot-clean',
    runtime: 'browser',
    tags:    ['smoke', 'boot'],
    fn:      smokeBoot,
  },
  {
    name:    'lifecycle-create-join-leave',
    runtime: 'browser',
    tags:    ['smoke', 'lifecycle'],
    fn:      lifecycleBasic,
  },
  {
    name:    'single-boss-board-renders',
    runtime: 'browser',
    tags:    ['smoke', 'scoreboard'],
    fn:      singleBossBoard,
  },
  {
    name:    'drill-down-both-sides',
    runtime: 'browser',
    tags:    ['smoke', 'drill-down', 'both-sides'],
    fn:      drillDownBoth,
  },

  // ── PHASE-2 REGRESSION SCENARIOS (runtime: browser) ───────────────────
  // Guards against Cluster A lifecycle bugs and the multi-phase undercount.
  // expected-fail = currently fails on main; must go green after fix lane merges.
  // expected-pass-now = already passing on main (regression guard only).
  {
    name:    'stale-code-clobber',
    runtime: 'browser',
    tags:    ['regression', 'lifecycle', 'cluster-a', 'expected-fail'],
    fn:      staleCodeClobber,
  },
  {
    name:    'reconnect-no-ghost',
    runtime: 'browser',
    tags:    ['regression', 'lifecycle', 'cluster-a', 'expected-fail'],
    fn:      reconnectNoGhost,
  },
  {
    name:    'max-party-churn',
    runtime: 'browser',
    tags:    ['regression', 'lifecycle', 'cluster-a', 'expected-pass-now'],
    fn:      maxPartyChurn,
  },
  {
    name:    'disband-on-leader-leave',
    runtime: 'browser',
    tags:    ['regression', 'lifecycle', 'cluster-a', 'expected-fail'],
    fn:      disbandOnLeaderLeave,
  },
  {
    name:    'idle-ttl',
    runtime: 'browser',
    tags:    ['regression', 'lifecycle', 'cluster-a', 'expected-pass-now'],
    fn:      idleTtl,
  },
  {
    name:    'multi-phase-undercount',
    runtime: 'browser',
    tags:    ['regression', 'scoreboard', 'cluster-a', 'expected-fail'],
    fn:      multiPhaseUndercount,
  },

  // ── REAL-APP GATE EXAMPLES (runtime: real-app) ─────────────────────────
  // These are registered so they appear in --list and the gate report;
  // the automated runner skips them (they need the built .exe).
  {
    name:    'confirm-dialog-not-dead',
    runtime: 'real-app',
    tags:    ['webview2', 'native-dialog'],
    fn:      async () => { throw new Error('real-app gate — run on built .exe only'); },
  },
  {
    name:    'localStorage-user-id-persists',
    runtime: 'real-app',
    tags:    ['webview2', 'persistence'],
    fn:      async () => { throw new Error('real-app gate — run on built .exe only'); },
  },
  {
    name:    'overlay-spawn-meipass',
    runtime: 'real-app',
    tags:    ['webview2', 'packaging'],
    fn:      async () => { throw new Error('real-app gate — run on built .exe only'); },
  },
  {
    name:    'idle-ttl-real-wait',
    runtime: 'real-app',
    tags:    ['regression', 'lifecycle', 'cluster-a', 'manual', 'slow'],
    fn:      async () => {
      throw new Error(
        'real-app gate — manual only: join a room, let all members leave, ' +
        'wait >5 min (GHOST_EVICT_MS), rejoin and assert empty roster. ' +
        'Check wrangler tail for ghost_evicted events.'
      );
    },
  },
];

module.exports = { scenarios };
