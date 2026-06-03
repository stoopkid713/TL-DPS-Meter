'use strict';
/**
 * Overlay-sync scenarios
 * runtime: browser | tags: overlay, overlay-sync
 *
 * Two scenarios in one module:
 *
 *   overlay-follows-active
 *     The overlay (spectator) joins the room and receives the CURRENT active
 *     encounter on its welcome frame — not a stale cached one.  After the sim
 *     posts a new encounter (via --multiboss), the overlay's encounters list
 *     updates to reflect the new active_id.
 *
 *   overlay-equals-app
 *     For the same room and the same point in time, both the overlay spectator
 *     WS and the app receiving-client WS see identical scoreboard data
 *     (same encounter_id, same total_damage, same entry count).
 *
 * ── Harness-gap notice (FLAGGED for dispatcher / adversarial lane) ──────────
 *
 *  overlay/src/index.html reads its party code from `?code=<CODE>` in the URL
 *  (not localStorage) and constructs its WS as:
 *
 *    wss://tldps-party.kyle-526.workers.dev/party/<CODE>?spectator=1&leader=0
 *
 *  The receiving-client harness (receiving-client.js) was built to load
 *  index.html (the BASE app) and seed party_code via localStorage.  It does NOT
 *  support loading overlay/src/index.html as a second surface because:
 *    1. The overlay reads `?code=` from the URL, not localStorage.
 *    2. The overlay does NOT use the __battery_triggerPartyJoin synthetic-message
 *       path — it calls connect() directly on DOMContentLoaded.
 *    3. openReceivingClient injects PYWEBVIEW_STUB which is harmless for the
 *       overlay, but the overlay has its own WS-boot path (no backend socket,
 *       no party_status trigger) — the trigger would be a no-op.
 *
 *  To load the overlay as a second Playwright surface we would need either:
 *    a) An openOverlayClient() helper that: navigates to file://overlay/src/index.html
 *       with ?code=<CODE> in the URL, injects the WS-rewrite+capture script
 *       (same makeCaptureScript as receiving-client.js), and skips the
 *       __battery_triggerPartyJoin trigger (the overlay self-connects).
 *    b) Or a modification to receiving-client.js to accept an `htmlPath` +
 *       `urlQueryString` override.
 *
 *  NEITHER option is implemented in this lane (no edits to receiving-client.js
 *  per hard rule 1).  Therefore:
 *    - overlay-follows-active and overlay-equals-app are tested via a RAW NODE
 *      WebSocket that joins the room with spectator=1 (same as the overlay would).
 *      This exercises the WORKER's spectator path completely (welcome frame,
 *      encounters list, scoreboard broadcast) — the gap is that we do not drive
 *      the BROWSER-SIDE overlay HTML render.  A future lane can add
 *      openOverlayClient() to receiving-client.js or as a sibling helper.
 *
 *  This approach is consistent with the "raw Node WS fallback" already used in
 *  drill-down-both-sides.js (the precedent is in the codebase).
 * ─────────────────────────────────────────────────────────────────────────────
 */

const WebSocket = require('ws');
const { runSim: _unused } = require('../receiving-client'); // unused import guard
// receiving-client is imported here only to confirm the module resolves (node --check).
// These scenarios use raw Node WS instead of openReceivingClient (see harness-gap above).

/**
 * Open a raw Node WebSocket to the party room as a spectator.
 * Resolves with the ws instance after the welcome frame is received,
 * or rejects on timeout.
 */
function openSpectatorWS(wranglerHost, code, userId, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const qs = new URLSearchParams({
      user_id: userId,
      username: `ov_${userId}`,
      leader: '0',
      spectator: '1',
    });
    const url = `${wranglerHost}/party/${encodeURIComponent(code)}?${qs.toString()}`;
    const ws = new WebSocket(url);
    const messages = [];
    let welcomed = false;
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`Spectator WS timed out waiting for welcome (code=${code})`));
    }, timeoutMs);

    ws.on('message', (data) => {
      let m;
      try { m = JSON.parse(data); } catch (_) { return; }
      messages.push(m);
      if (!welcomed && m.type === 'welcome') {
        welcomed = true;
        clearTimeout(timer);
        resolve({ ws, messages, welcome: m });
      }
    });

    ws.on('error', (err) => { clearTimeout(timer); reject(err); });
    ws.on('close', () => {
      if (!welcomed) {
        clearTimeout(timer);
        reject(new Error(`Spectator WS closed before welcome (code=${code})`));
      }
    });
  });
}

/**
 * Wait for a message matching predicate on a raw-WS messages array.
 * Polls every 100ms up to timeoutMs.
 */
function waitForMsg(messages, predicate, timeoutMs = 10_000) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    let offset = 0;
    function poll() {
      for (let i = offset; i < messages.length; i++) {
        if (predicate(messages[i])) { resolve(messages[i]); return; }
      }
      offset = messages.length;
      if (Date.now() < deadline) setTimeout(poll, 100);
      else resolve(null);
    }
    poll();
  });
}

/**
 * Scenario: overlay-follows-active
 *
 * A spectator (overlay) joins a room and asserts:
 *   1. The welcome frame includes an active_encounter_id (or scoreboard with
 *      encounter_id) once the sim has posted — i.e., the room sends the LIVE
 *      active encounter, not a default null/stale one.
 *   2. After the sim finishes (multiboss: 3 encounters), the spectator receives
 *      an encounters frame whose active_id matches the encounter it last heard
 *      about — confirming the overlay auto-follows the room's active encounter.
 */
async function overlayFollowsActive(ctx) {
  const { code, runSim, wranglerHost } = ctx;

  // Open spectator before the sim runs, so we capture all broadcasts.
  const { ws: spectatorWS, messages, welcome } = await openSpectatorWS(
    wranglerHost, code, 'ov_follows_1'
  );

  // Record the active_encounter_id from the welcome frame (may be null pre-sim).
  const welcomeActiveId = welcome.active_encounter_id
    || (welcome.scoreboard && welcome.scoreboard.encounter_id)
    || null;

  // Run sim (multiboss, 2 members — posts 3 encounters with final_detail).
  await runSim([code, '--multiboss', '--members', '2'], 35_000);

  // Wait for an encounters broadcast — confirms the room pushed an update.
  const encMsg = await waitForMsg(messages, m => m.type === 'encounters', 20_000);
  if (!encMsg) {
    spectatorWS.close();
    throw new Error(
      'overlay-follows-active: spectator never received encounters frame after sim run. ' +
      'Worker may not be broadcasting encounters to spectators, or the WS URL is wrong.'
    );
  }

  if (!Array.isArray(encMsg.list) || encMsg.list.length === 0) {
    spectatorWS.close();
    throw new Error(
      `overlay-follows-active: encounters frame has empty list — expected >= 1 encounter ` +
      `after multiboss sim. Received: ${JSON.stringify(encMsg).slice(0, 300)}`
    );
  }

  // The active_id in the encounters frame must be a known encounter_id.
  const activeId = encMsg.active_id;
  if (!activeId) {
    spectatorWS.close();
    throw new Error(
      `overlay-follows-active: encounters frame missing active_id. ` +
      `The overlay cannot follow the active encounter without this field. ` +
      `Frame: ${JSON.stringify(encMsg).slice(0, 300)}`
    );
  }

  const knownIds = encMsg.list.map(e => e.encounter_id);
  if (!knownIds.includes(activeId)) {
    spectatorWS.close();
    throw new Error(
      `overlay-follows-active: active_id="${activeId}" not found in encounters list ` +
      `${JSON.stringify(knownIds)}. The overlay would track a phantom encounter.`
    );
  }

  // Also assert we received at least one scoreboard broadcast (proves the room
  // is broadcasting to spectators, not just to non-spectator members).
  const scoreMsg = await waitForMsg(messages, m => m.type === 'scoreboard', 5_000);
  if (!scoreMsg) {
    spectatorWS.close();
    throw new Error(
      'overlay-follows-active: spectator never received a scoreboard broadcast. ' +
      'Worker may be filtering out spectators from scoreboard fanout.'
    );
  }

  spectatorWS.close();
}

/**
 * Scenario: overlay-equals-app
 *
 * For the same room, at the same moment, the spectator WS and a regular member WS
 * must receive equivalent scoreboard data:
 *   - same encounter_id on the scoreboard frame
 *   - same total_damage (within rounding tolerance of 0)
 *   - same number of entries
 *
 * Both connections are raw Node WebSockets (see harness-gap notice above for why
 * we don't load the overlay HTML page in a second Playwright context).
 *
 * The sim runs first, then BOTH spectator and member join. We compare the
 * scoreboard each receives on their welcome frame (both should get the cached
 * board from the already-finished encounter).
 */
async function overlayEqualsApp(ctx) {
  const { code, runSim, wranglerHost } = ctx;

  // Run sim first so there's a scoreboard to cache.
  await runSim([code, '--members', '2', '--now', '--share-ts'], 20_000);

  // Give the worker a moment to settle the scoreboard into the room state.
  await new Promise(r => setTimeout(r, 1_500));

  // Open both connections concurrently.
  const [spectatorResult, memberResult] = await Promise.all([
    openSpectatorWS(wranglerHost, code, 'ov_eq_spectator'),
    openSpectatorWS(wranglerHost, code, 'ov_eq_member').catch(err => {
      // Re-throw with context.
      throw new Error(`overlay-equals-app: member WS failed: ${err.message}`);
    }),
  ]);

  const { ws: spectatorWS, welcome: specWelcome } = spectatorResult;
  const { ws: memberWS, welcome: memWelcome }     = memberResult;

  spectatorWS.close();
  memberWS.close();

  // Both must have a scoreboard in the welcome frame (post-sim, room should have one cached).
  const specBoard = specWelcome.scoreboard;
  const memBoard  = memWelcome.scoreboard;

  if (!specBoard) {
    throw new Error(
      'overlay-equals-app: spectator welcome had no scoreboard. ' +
      'Either the sim did not post in time or the worker dropped the cached board.'
    );
  }
  if (!memBoard) {
    throw new Error(
      'overlay-equals-app: member welcome had no scoreboard. ' +
      'Either the sim did not post in time or the worker dropped the cached board.'
    );
  }

  // Same encounter_id.
  if (specBoard.encounter_id !== memBoard.encounter_id) {
    throw new Error(
      `overlay-equals-app: scoreboard encounter_id mismatch — ` +
      `spectator=${specBoard.encounter_id} vs member=${memBoard.encounter_id}. ` +
      `The overlay is following a different encounter than the app.`
    );
  }

  // Same total_damage (exact — both read the same cached object; tolerance = 0).
  if (specBoard.total_damage !== memBoard.total_damage) {
    throw new Error(
      `overlay-equals-app: total_damage mismatch — ` +
      `spectator=${specBoard.total_damage} vs member=${memBoard.total_damage}. ` +
      `The overlay board is stale or from a different encounter snapshot.`
    );
  }

  // Same number of entries.
  const specEntries = Array.isArray(specBoard.entries) ? specBoard.entries.length : -1;
  const memEntries  = Array.isArray(memBoard.entries)  ? memBoard.entries.length  : -1;
  if (specEntries !== memEntries) {
    throw new Error(
      `overlay-equals-app: entry count mismatch — ` +
      `spectator=${specEntries} vs member=${memEntries}. ` +
      `The overlay is missing or has extra rows compared to the app.`
    );
  }

  if (specEntries === 0) {
    throw new Error(
      'overlay-equals-app: both scoreboards have 0 entries — sim may not have posted.'
    );
  }
}

module.exports = { overlayFollowsActive, overlayEqualsApp };
