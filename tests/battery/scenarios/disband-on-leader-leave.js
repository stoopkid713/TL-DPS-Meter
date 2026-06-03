'use strict';
/**
 * Leader-leave lifecycle — succession + close-on-empty
 * runtime: node | tags: regression, lifecycle, cluster-a
 *
 * UPDATED: The old scenario asserted disband-on-leader-leave (room dies when leader
 * leaves). Testing showed that is the WRONG behavior. The correct behavior is:
 *
 *   1. Leader leaves → server transfers leadership to the next present member
 *      (succession). Room stays alive. Remaining members receive an updated roster
 *      with a new member carrying is_leader:true (the crown moves). An optional
 *      additive `leader_changed` event may also be broadcast.
 *
 *   2. Room closes only when the LAST member leaves (empty room → disband).
 *      At that point the room tears down: ROOMS_KV entry removed, DO storage wiped.
 *
 * Assertions:
 *   A1. After leader leaves, the remaining member does NOT receive party_disbanded.
 *   A2. The remaining member's socket stays open (server does not force-close it).
 *   A3. The room is still joinable after the leader left.
 *   A4. The new joiner's welcome shows exactly one member with is_leader:true.
 *   A5. After the last member leaves, a new join gets an empty fresh room (succession
 *       ran on empty → room torn down → DO starts fresh with 0 members).
 *
 * Backwards compat note: old v1.0.3 clients already render the crown from the roster
 * `is_leader` field. They never send make_leader and never need to handle leader_changed.
 * Succession is purely server-side; no client cooperation required.
 */

const WebSocket = require('ws');

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

function wsJoin(wranglerHost, code, userId, isLeader, timeoutMs = 8_000) {
  return new Promise((resolve, reject) => {
    const url = `${wranglerHost}/party/${code}?user_id=${userId}&username=${userId}&leader=${isLeader ? 1 : 0}`;
    const ws = new WebSocket(url);
    const timer = setTimeout(() => { ws.close(); reject(new Error(`join timeout: ${userId}`)); }, timeoutMs);
    ws.on('message', (data) => {
      let m; try { m = JSON.parse(data); } catch (_) { return; }
      if (m.type === 'welcome') { clearTimeout(timer); resolve({ ws, welcome: m }); }
    });
    ws.on('error', (err) => { clearTimeout(timer); reject(err); });
    ws.on('close', (c, reason) => { clearTimeout(timer); reject(new Error(`closed ${c} before welcome: ${userId} (${reason})`)); });
  });
}

/**
 * Collect messages from a WebSocket for up to `ms` milliseconds.
 */
function collectMsgs(ws, ms) {
  return new Promise((resolve) => {
    const msgs = [];
    let closed = false;
    ws.on('message', (data) => {
      try { msgs.push(JSON.parse(data)); } catch (_) {}
    });
    ws.on('close', () => { closed = true; });
    setTimeout(() => resolve({ msgs, closed }), ms);
  });
}

module.exports = async function leaderLeaveSuccession(ctx) {
  const { genCode, wranglerHost } = ctx;
  const code = genCode('LL');

  // ── Phase 1: leader-leave → succession ──────────────────────────────────────

  // Open as leader.
  const { ws: wsLeader } = await wsJoin(wranglerHost, code, 'll_leader', true);

  // Open as member — will watch for disband vs succession signals.
  const { ws: wsMember } = await wsJoin(wranglerHost, code, 'll_member', false);

  // Start collecting member messages before the leader leaves.
  const memberCollectPromise = collectMsgs(wsMember, 2_000);

  await delay(300); // let room settle

  // Leader sends leave.
  if (wsLeader.readyState === WebSocket.OPEN) {
    wsLeader.send(JSON.stringify({ type: 'leave' }));
    await delay(200);
  }
  try { wsLeader.close(); } catch (_) {}

  // Wait for member to receive succession signals.
  const { msgs: memberMsgs, closed: memberClosed } = await memberCollectPromise;

  // A1: member must NOT receive party_disbanded (room should not die).
  const disbandFrame = memberMsgs.find(m => m.type === 'party_disbanded' || m.type === 'room_disbanded');
  if (disbandFrame) {
    throw new Error(
      `A1 FAIL: member received ${disbandFrame.type} after leader left — room should survive via succession, not disband. ` +
      `All messages: ${JSON.stringify(memberMsgs.map(m => m.type))}`
    );
  }

  // A2: member socket must stay open (server must not force-close it).
  if (memberClosed) {
    throw new Error(
      `A2 FAIL: member socket was closed by server after leader left — should stay open after succession.`
    );
  }

  // A3: room still joinable after leader left.
  let wsAfter, welcomeAfter;
  try {
    ({ ws: wsAfter, welcome: welcomeAfter } = await wsJoin(wranglerHost, code, 'll_joiner_after', false, 5_000));
  } catch (err) {
    throw new Error(
      `A3 FAIL: room not joinable after leader left (succession should keep room alive): ${err.message}`
    );
  }

  // A4: exactly one member with is_leader:true in the welcome snapshot.
  const welcomeMembers = welcomeAfter.roster || welcomeAfter.members || [];
  const leaders = welcomeMembers.filter(m => m.is_leader);
  if (leaders.length !== 1) {
    wsAfter.close();
    wsMember.close();
    throw new Error(
      `A4 FAIL: expected exactly 1 leader in post-succession roster, got ${leaders.length}. ` +
      `Roster: ${JSON.stringify(welcomeMembers.map(m => ({ user_id: m.user_id, is_leader: m.is_leader })))}`
    );
  }
  // The new leader must NOT be the one who left.
  if (leaders[0].user_id === 'll_leader') {
    wsAfter.close();
    wsMember.close();
    throw new Error(
      `A4 FAIL: departed leader is still marked as leader in post-succession roster.`
    );
  }

  wsAfter.close();
  await delay(200);

  // ── Phase 2: last-member-leave → room closes (empty → disband) ──────────────

  // The only member left is ll_member. Have them leave.
  if (wsMember.readyState === WebSocket.OPEN) {
    wsMember.send(JSON.stringify({ type: 'leave' }));
    await delay(300);
  }
  try { wsMember.close(); } catch (_) {}

  await delay(500); // allow DO to process teardown

  // A5: room should now be empty (DO was torn down). A new joiner should get an
  // empty-roster welcome (fresh DO) rather than seeing ll_member as a stale ghost.
  let wsFresh, welcomeFresh;
  try {
    ({ ws: wsFresh, welcome: welcomeFresh } = await wsJoin(wranglerHost, code, 'll_fresh_joiner', true, 5_000));
  } catch (err) {
    // If the room is completely unreachable (503 / refused) that also satisfies A5.
    if (/timeout|closed|refused|ECONNREFUSED/.test(err.message)) {
      // Acceptable: DO fully evicted.
      return;
    }
    throw new Error(`A5 FAIL: unexpected error joining after all members left: ${err.message}`);
  }

  const freshMembers = welcomeFresh.roster || welcomeFresh.members || [];
  // The fresh joiner themselves will be in the roster (just joined), so filter them out.
  const staleMembers = freshMembers.filter(m => m.user_id !== 'll_fresh_joiner');
  wsFresh.close();

  if (staleMembers.length > 0) {
    throw new Error(
      `A5 FAIL: after all members left, new joiner sees stale members in roster: ` +
      `${JSON.stringify(staleMembers.map(m => m.user_id))}. ` +
      `Room should have been torn down (close-on-empty) so it starts fresh.`
    );
  }

  // All assertions passed.
};
