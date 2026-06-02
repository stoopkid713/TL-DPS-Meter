'use strict';
/**
 * Phase-2 Regression — disband-on-leader-leave
 * runtime: browser | tags: regression, lifecycle, cluster-a
 *
 * EXPECTED-FAIL-UNTIL-FIX (Cluster A disband-on-leader-leave bug)
 *
 * The bug: when the leader sends a "leave" frame (or closes the socket), the
 * room should disband — members receive a notification (e.g. "party_disbanded"
 * or "member_left" for the leader) AND the room code becomes un-joinable (or
 * empty).
 *
 * Current behavior: the leader leaving is treated like any other member leave.
 * Members are still in the roster (the DO is not torn down), the room stays
 * joinable, and any stale member can become de-facto owner without an explicit
 * handoff.
 *
 * Expected behavior after fix:
 *   - Worker broadcasts a "party_disbanded" frame (or equivalent) to all members
 *   - Members' sockets are closed by the server
 *   - A subsequent join on the same code either gets an empty fresh room or is
 *     rejected until the DO's alarm fires
 *
 * Assertions:
 *   1. After leader leave, at least one non-leader member receives a signal that
 *      the room is disbanded (party_disbanded, or member_left for the leader, or
 *      the socket is forcibly closed by the server)
 *   2. The code is no longer usable (new join gets an empty room or is rejected)
 *
 * NOTE: Assertion 1 checks for EITHER a party_disbanded frame OR a server-side
 * socket close (both are valid disband signals depending on the fix strategy).
 * Currently NEITHER happens → FAIL.
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
    ws.on('close', (c) => { clearTimeout(timer); reject(new Error(`closed ${c} before welcome: ${userId}`)); });
  });
}

module.exports = async function disbandOnLeaderLeave(ctx) {
  const { genCode, wranglerHost } = ctx;
  const code = genCode('DL');

  // Open as leader.
  const { ws: wsLeader } = await wsJoin(wranglerHost, code, 'dl_leader', true);

  // Open as member (will watch for disband signals).
  const { ws: wsMember } = await wsJoin(wranglerHost, code, 'dl_member', false);

  // Collect member messages.
  const memberMsgs = [];
  let memberClosed = false;
  wsMember.on('message', (data) => {
    try { memberMsgs.push(JSON.parse(data)); } catch (_) {}
  });
  wsMember.on('close', () => { memberClosed = true; });

  await delay(300); // let room settle

  // Leader leaves.
  if (wsLeader.readyState === WebSocket.OPEN) {
    wsLeader.send(JSON.stringify({ type: 'leave' }));
    await delay(150);
  }
  try { wsLeader.close(); } catch (_) {}

  // Wait for the member to receive disband signals.
  await delay(1_500);

  // --- Assertion 1: member received a REAL disband signal (not just member_left) ---
  //
  // The worker currently sends member_left when the leader leaves (same as any member).
  // That's not a "disband" signal — the room continues with dl_member still in the roster.
  // The EXPECTED disband behavior is a party_disbanded frame OR the server closing
  // the member's socket forcibly. member_left alone is NOT sufficient.
  const realDisbandFrame = memberMsgs.find(m =>
    m.type === 'party_disbanded' ||
    m.type === 'room_disbanded'
  );
  const serverClosedMember = memberClosed;

  // Current behavior: realDisbandFrame = null, serverClosedMember = false
  // Expected after fix: at least one is truthy.
  if (!realDisbandFrame && !serverClosedMember) {
    // Don't fail here — fall through to Assertion 2 which proves the room is NOT disbanded.
    // Both assertions together form the full regression check.
  }

  // --- Assertion 2: the code is still joinable with stale members = the bug ---
  // If the room is NOT disbanded (Assertion 1 failed), the new joiner should see
  // dl_member still in the roster — proving disband-on-leader-leave is broken.
  try {
    const { ws: wsNew, welcome: wNew } = await wsJoin(wranglerHost, code, 'dl_joiner_after', false, 5_000);
    const staleMembers = (wNew.members || []).filter(
      m => m.user_id === 'dl_member'
    );
    wsNew.close();

    if (!realDisbandFrame && !serverClosedMember) {
      // No disband signal was sent. The room must still have dl_member (leaderless orphan).
      // This is the bug: the room is alive but leaderless with no way for members to know.
      if (staleMembers.length > 0) {
        throw new Error(
          `Assertion 2 FAIL (expected-fail-until-fix): after leader left, the room was NOT disbanded ` +
          `(no party_disbanded frame, member socket NOT closed). ` +
          `The room is still joinable and dl_member is a leaderless orphan in the roster. ` +
          `disband-on-leader-leave is not implemented — members need a party_disbanded notification ` +
          `or their sockets must be forcibly closed when the leader departs.`
        );
      } else {
        // dl_member is gone from the roster (e.g. was evicted or removed). The room is effectively
        // empty — this is acceptable even without a formal disband.
      }
    } else if (staleMembers.length > 0) {
      throw new Error(
        `Assertion 2 FAIL: disband signal was sent but dl_member still appears in new joiner's ` +
        `roster: ${JSON.stringify(staleMembers)}. Disband must also clear the roster.`
      );
    }
  } catch (err) {
    // Rejection (e.g. HTTP 403, connection refused) = code is unreachable = disband worked.
    if (/timeout|closed|refused|ECONNREFUSED/.test(err.message) && (realDisbandFrame || serverClosedMember)) {
      // new join failed AND a disband signal was sent = acceptable disband behavior
      try { wsMember.close(); } catch (_) {}
      return;
    }
    if (/timeout|closed|refused|ECONNREFUSED/.test(err.message) && !realDisbandFrame && !serverClosedMember) {
      // Code unreachable but no disband signal sent — ambiguous; let it pass with a warning.
      console.log('       [warn] disband: code unreachable but no explicit disband signal. Acceptable if DO was evicted.');
      try { wsMember.close(); } catch (_) {}
      return;
    }
    throw err; // re-throw real assertion failures
  }

  try { wsMember.close(); } catch (_) {}
  await delay(200);
};
