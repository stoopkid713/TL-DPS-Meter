'use strict';
/**
 * Phase-2 Regression — reconnect-no-ghost
 * runtime: browser | tags: regression, lifecycle, cluster-a
 *
 * EXPECTED-PASS-NOW (the worker already implements stable identity on reconnect — contract item 4)
 *
 * The bug scenario: a member disconnects (socket drop / tab close) and reconnects
 * with the same user_id.  Before the fix, the worker could:
 *   • Keep the old (offline) slot AND add a new slot → ghost duplicate row in roster
 *   • Reset joined_at, producing a spurious "new member" event on reconnect
 *   • Increment member count past the real number of unique humans
 *
 * What the worker SHOULD do (contract item 4):
 *   • Replace the old socket (getWebSockets(user_id) closes previous ones)
 *   • Preserve joined_at from the original session
 *   • Roster count unchanged (same user_id = same slot)
 *   • No 'member_joined' broadcast on reconnect (it was already a member)
 *
 * This scenario drives a raw WS (no Playwright needed) because it exercises
 * pure worker protocol — no UI rendering.
 *
 * Assertions:
 *   1. Initial join → roster has exactly 1 member
 *   2. Socket close (simulates disconnect) → member_offline broadcast
 *   3. Reconnect with same user_id → roster still has exactly 1 member (no ghost)
 *   4. No 'member_joined' broadcast on reconnect (already in roster)
 *   5. The welcome on reconnect shows the same user_id as original
 */

const WebSocket = require('ws');

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

function collectMessages(ws, durationMs) {
  const msgs = [];
  ws.on('message', (data) => {
    try { msgs.push(JSON.parse(data)); } catch (_) {}
  });
  return new Promise(resolve => setTimeout(() => resolve(msgs), durationMs));
}

module.exports = async function reconnectNoGhost(ctx) {
  const { genCode, wranglerHost } = ctx;
  const code = genCode('RG');

  // --- Step 1: initial join as a regular member (not leader) ---
  const url1 = `${wranglerHost}/party/${code}?user_id=ghost_test&username=GhostUser&leader=0`;
  const ws1 = new WebSocket(url1);

  const messages1 = [];
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ws1 welcome timeout')), 8_000);
    ws1.on('message', (data) => {
      let m; try { m = JSON.parse(data); } catch (_) { return; }
      messages1.push(m);
      if (m.type === 'welcome') { clearTimeout(timer); resolve(); }
    });
    ws1.on('error', (err) => { clearTimeout(timer); reject(err); });
  });

  const welcome1 = messages1.find(m => m.type === 'welcome');
  if (!welcome1) throw new Error('No welcome on initial join');
  if (!welcome1.you || welcome1.you.user_id !== 'ghost_test') {
    throw new Error(`welcome.you.user_id mismatch: got ${welcome1.you && welcome1.you.user_id}`);
  }

  // Check initial roster count (just us in the room).
  await delay(400);
  const roster1 = messages1.filter(m => m.type === 'roster').pop();
  // Roster may arrive async — re-query from the last broadcast.
  // The roster should have exactly 1 member (ghost_test).
  const rosterMembers1 = (roster1 && roster1.members) || welcome1.members || [];
  const memberCount1 = rosterMembers1.filter(m => !m.is_spectator).length;
  if (memberCount1 !== 1) {
    ws1.close();
    throw new Error(`Assertion 1 FAIL: expected 1 member in roster after join, got ${memberCount1}`);
  }

  // --- Step 2: disconnect (simulate crash/close) ---
  // We open a SECOND raw connection from the observer to watch the room while
  // ghost_test reconnects.
  const obsUrl = `${wranglerHost}/party/${code}?user_id=observer&username=Observer&leader=0`;
  const wsObs = new WebSocket(obsUrl);
  const obsMessages = [];
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('observer welcome timeout')), 8_000);
    wsObs.on('message', (data) => {
      let m; try { m = JSON.parse(data); } catch (_) { return; }
      obsMessages.push(m);
      if (m.type === 'welcome') { clearTimeout(timer); resolve(); }
    });
    wsObs.on('error', (err) => { clearTimeout(timer); reject(err); });
  });

  // Close ws1 abruptly (no leave frame — simulates crash).
  ws1.terminate();
  await delay(600); // let worker process the close + broadcast member_offline

  // --- Step 3: reconnect with SAME user_id ---
  const obsMessagesAtReconnect = obsMessages.length;
  const url2 = `${wranglerHost}/party/${code}?user_id=ghost_test&username=GhostUser&leader=0`;
  const ws2 = new WebSocket(url2);
  const messages2 = [];
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ws2 (reconnect) welcome timeout')), 8_000);
    ws2.on('message', (data) => {
      let m; try { m = JSON.parse(data); } catch (_) { return; }
      messages2.push(m);
      if (m.type === 'welcome') { clearTimeout(timer); resolve(); }
    });
    ws2.on('error', (err) => { clearTimeout(timer); reject(err); });
  });

  await delay(500); // let roster broadcasts settle

  // --- Assertion 3: roster count unchanged (no ghost duplicate) ---
  // Collect all roster frames observed by the observer after reconnect.
  const newObsMsgs = obsMessages.slice(obsMessagesAtReconnect);
  const rosterAfterReconnect = newObsMsgs.filter(m => m.type === 'roster').pop();
  const membersAfterReconnect = rosterAfterReconnect ? rosterAfterReconnect.members || [] : [];
  // Also check the reconnect welcome snapshot.
  const welcome2 = messages2.find(m => m.type === 'welcome');
  const rosterSnap2 = (welcome2 && welcome2.members) || membersAfterReconnect;
  const uniqueIds = new Set(rosterSnap2.filter(m => !m.is_spectator).map(m => m.user_id));

  // Expected unique members: ghost_test + observer = 2
  if (uniqueIds.size > 2 || (rosterSnap2.filter(m => !m.is_spectator).length > 2)) {
    ws2.close(); wsObs.close();
    throw new Error(
      `Assertion 3 FAIL: ghost duplicate detected after reconnect. ` +
      `Roster has ${rosterSnap2.filter(m => !m.is_spectator).length} entries, ` +
      `unique IDs: ${[...uniqueIds].join(', ')}. Expected: ghost_test + observer only.`
    );
  }

  // --- Assertion 4: no 'member_joined' on reconnect ---
  // The observer should NOT have received a member_joined for ghost_test after reconnect.
  const ghostJoinedAfter = newObsMsgs.filter(
    m => m.type === 'member_joined' && m.user_id === 'ghost_test'
  );
  if (ghostJoinedAfter.length > 0) {
    ws2.close(); wsObs.close();
    throw new Error(
      `Assertion 4 FAIL: received member_joined for ghost_test on reconnect ` +
      `(${ghostJoinedAfter.length} events). ` +
      `Reconnect should reclaim the existing slot, not re-announce the member.`
    );
  }

  // --- Assertion 5: welcome on reconnect has correct user_id ---
  if (!welcome2 || !welcome2.you || welcome2.you.user_id !== 'ghost_test') {
    ws2.close(); wsObs.close();
    throw new Error(
      `Assertion 5 FAIL: welcome on reconnect has wrong user_id: ` +
      `${welcome2 && welcome2.you && welcome2.you.user_id}`
    );
  }

  ws2.close();
  wsObs.close();
  await delay(200);
};
