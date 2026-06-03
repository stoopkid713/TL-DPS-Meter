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

// ── Finish-battery: full spec coverage (stats / merge / overlay / adversarial) ──
const { statsPariyCritHeavy, statsTotalReconciles } = require('./stats-parity');
const { dupBossDistinct, trashOnlyHidden, gapSplits } = require('./encounter-accuracy');
const { mergeTwoClients, mergeWindowDistinct, lateJoinMidfight } = require('./multi-client-merge');
const { loggingNotPosting, loggingLateStart } = require('./logging-detect');
const { overlayFollowsActive, overlayEqualsApp } = require('./overlay-sync');
const { feedbackFlow, feedbackLogsAttached } = require('./bug-report-telemetry');
const adversarialRace     = require('./adversarial-race');
const adversarialFaults   = require('./adversarial-faults');
const adversarialFuzz     = require('./adversarial-fuzz');
const adversarialBoundary = require('./adversarial-boundary');

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

  // ── FINISH-BATTERY: stats parity + encounter accuracy ──────────────────
  { name: 'stats-parity-crit-heavy', runtime: 'browser', tags: ['stats','scoreboard','parity','expected-pass-now'], fn: statsPariyCritHeavy },
  { name: 'stats-total-reconciles',  runtime: 'browser', tags: ['stats','scoreboard','parity','expected-pass-now'], fn: statsTotalReconciles },
  { name: 'dup-boss-distinct',       runtime: 'browser', tags: ['encounter','scoreboard','regression','expected-pass-now'], fn: dupBossDistinct },
  { name: 'trash-only-hidden',       runtime: 'browser', tags: ['encounter','scoreboard','expected-pass-now'], fn: trashOnlyHidden },
  { name: 'gap-splits',              runtime: 'browser', tags: ['encounter','accuracy','expected-pass-now'], fn: gapSplits },

  // ── FINISH-BATTERY: multi-client merge + #14 logging ───────────────────
  { name: 'merge-two-clients',      runtime: 'browser', tags: ['regression','merge','multi-client','expected-fail'], fn: mergeTwoClients },
  { name: 'merge-window-distinct',  runtime: 'browser', tags: ['regression','merge','multi-client','expected-fail'], fn: mergeWindowDistinct },
  { name: 'late-join-midfight',     runtime: 'browser', tags: ['regression','merge','multi-client','expected-fail'], fn: lateJoinMidfight },
  { name: 'logging-not-posting',    runtime: 'browser', tags: ['regression','logging-detect','roster','expected-fail'], fn: loggingNotPosting },
  { name: 'logging-late-start',     runtime: 'browser', tags: ['regression','logging-detect','roster','expected-fail'], fn: loggingLateStart },

  // ── FINISH-BATTERY: overlay + bug-report telemetry ─────────────────────
  { name: 'overlay-follows-active', runtime: 'browser', tags: ['overlay','overlay-sync'], fn: overlayFollowsActive },
  { name: 'overlay-equals-app',     runtime: 'browser', tags: ['overlay','overlay-sync'], fn: overlayEqualsApp },
  { name: 'feedback-flow',          runtime: 'browser', tags: ['feedback','telemetry'], fn: feedbackFlow },
  { name: 'feedback-logs-attached', runtime: 'browser', tags: ['feedback','telemetry','expected-fail'], fn: feedbackLogsAttached },

  // ── FINISH-BATTERY: adversarial / break-it layer ───────────────────────
  // adversarial-race + adversarial-faults FAIL today = REAL worker gaps the break-it layer
  // surfaced (ghost-online-on-churn; fight-post lost on abrupt socket drop). Tagged
  // expected-fail as documented regression guards — they go green when the worker is hardened.
  { name: 'adversarial-race',     runtime: 'browser', tags: ['regression','adversarial','lifecycle','expected-fail'], fn: adversarialRace },
  { name: 'adversarial-faults',   runtime: 'browser', tags: ['regression','adversarial','lifecycle','expected-fail'], fn: adversarialFaults },
  { name: 'adversarial-fuzz',     runtime: 'browser', tags: ['regression','adversarial','protocol'], fn: adversarialFuzz },
  { name: 'adversarial-boundary', runtime: 'browser', tags: ['regression','adversarial','lifecycle','protocol'], fn: adversarialBoundary },

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
