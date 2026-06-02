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
 */

const smokeBoot       = require('./smoke-boot');
const lifecycleBasic  = require('./lifecycle-basic');
const singleBossBoard = require('./single-boss-board');
const drillDownBoth   = require('./drill-down-both-sides');

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
];

module.exports = { scenarios };
