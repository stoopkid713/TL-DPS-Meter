'use strict';
/**
 * Phase-2 Regression — idle-ttl
 * runtime: browser | tags: regression, lifecycle, cluster-a
 *
 * EXPECTED-PASS-NOW (structural verification only — real wait is too slow for automation)
 *
 * The idle-TTL mechanism: an empty/idle room should be torn down after a
 * configurable TTL (tracked via a Cloudflare Durable Object alarm or the
 * GHOST_EVICT_MS lazy-eviction window).
 *
 * A full idle-wait test would require sleeping 5+ minutes (GHOST_EVICT_MS = 5 min),
 * which is impractical for a fast battery run.  Instead this scenario:
 *
 *   A. STRUCTURAL CHECK (automated):
 *      Join a room, leave, then immediately re-probe — the room should respond to
 *      a new join (DO is still warm).  This verifies the DO is functional, not that
 *      idle teardown works.  Tagged 'real-app' for the real idle-wait gate.
 *
 *   B. MECHANISM CHECK (automated, cheap):
 *      Inspect the worker source for the presence of the GHOST_EVICT_MS constant and
 *      the _evictGhosts call pattern.  If the constant is present, the mechanism is
 *      wired; we assert a positive presence rather than timing the actual eviction.
 *
 * The real idle-TTL verification must be done manually or with a dedicated slow-runner:
 *   1. Start a room, let all members leave, wait > GHOST_EVICT_MS (5 min), then join
 *      a new member and confirm the roster is empty (ghost eviction fired).
 *   2. For the Durable Object alarm path: inspect worker logs for 'ghost_evicted' events.
 *
 * This file documents the expected behavior and gates the structural part only.
 */

const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

function wsJoin(wranglerHost, code, userId, isLeader, timeoutMs = 8_000) {
  return new Promise((resolve, reject) => {
    const url = `${wranglerHost}/party/${code}?user_id=${userId}&username=${userId}&leader=${isLeader ? 1 : 0}`;
    const ws = new WebSocket(url);
    const timer = setTimeout(() => { ws.close(); reject(new Error(`join timeout`)); }, timeoutMs);
    ws.on('message', (data) => {
      let m; try { m = JSON.parse(data); } catch (_) { return; }
      if (m.type === 'welcome') { clearTimeout(timer); resolve({ ws, welcome: m }); }
    });
    ws.on('error', (err) => { clearTimeout(timer); reject(err); });
    ws.on('close', (c) => { clearTimeout(timer); reject(new Error(`closed ${c} before welcome`)); });
  });
}

module.exports = async function idleTtl(ctx) {
  const { genCode, wranglerHost } = ctx;

  // --- Part B: mechanism check (worker source) ---
  // Read the worker source and confirm the eviction mechanism is present.
  // REPO_ROOT is two levels up from tests/battery/scenarios/.
  const workerSrc = path.resolve(__dirname, '..', '..', '..', 'workers', 'party', 'src', 'index.js');
  let srcText = '';
  try {
    srcText = fs.readFileSync(workerSrc, 'utf8');
  } catch (_) {
    // If the source can't be read (different worktree layout), skip mechanism check.
    console.log('       [warn] idle-ttl: worker source not readable — mechanism check skipped');
  }

  if (srcText) {
    // Verify GHOST_EVICT_MS is defined (the eviction window constant).
    if (!/GHOST_EVICT_MS\s*=/.test(srcText)) {
      throw new Error(
        'Mechanism check FAIL: GHOST_EVICT_MS constant not found in worker source. ' +
        'Ghost eviction mechanism is not wired.'
      );
    }
    // Verify _evictGhosts() is called (lazy eviction on join/post).
    if (!/_evictGhosts\(\)/.test(srcText)) {
      throw new Error(
        'Mechanism check FAIL: _evictGhosts() call not found in worker source. ' +
        'The eviction function exists but may not be invoked.'
      );
    }
  }

  // --- Part A: structural check (live WS) ---
  const code = genCode('IT');

  const { ws: ws1 } = await wsJoin(wranglerHost, code, 'ttl_test', true);
  // Leave immediately (no content posted — the room is "idle" from content perspective).
  try { ws1.send(JSON.stringify({ type: 'leave' })); await delay(200); } catch (_) {}
  try { ws1.close(); } catch (_) {}
  await delay(500);

  // Re-join the same code — should succeed (DO still warm, not evicted yet).
  // This confirms the structural path, not the timeout path.
  let ws2, w2;
  try {
    ({ ws: ws2, welcome: w2 } = await wsJoin(wranglerHost, code, 'ttl_test2', true, 6_000));
  } catch (err) {
    throw new Error(
      `Structural check FAIL: re-join after leave failed: ${err.message}. ` +
      `The room must be reachable while the DO is still warm (< GHOST_EVICT_MS).`
    );
  }

  // The room should be empty (our leave + no prior members).
  const staleMembers = (w2.members || []).filter(m => m.user_id === 'ttl_test');
  if (staleMembers.length > 0) {
    try { ws2.close(); } catch (_) {}
    throw new Error(
      `Structural check FAIL: room has stale member 'ttl_test' after leave+rejoin with new user. ` +
      `Leave did not remove the member from the roster.`
    );
  }

  try { ws2.close(); } catch (_) {}
  await delay(200);

  // Log the manual-test gate so the battery report captures it.
  console.log(
    '\n       [idle-ttl] REAL idle-TTL verification is MANUAL (run-time: real-app):' +
    '\n         1. join a room, let all members leave, wait >5 min' +
    '\n         2. have a new member join — roster must be empty (ghost eviction fired)' +
    '\n         3. check wrangler tail for "ghost_evicted" events'
  );
};
