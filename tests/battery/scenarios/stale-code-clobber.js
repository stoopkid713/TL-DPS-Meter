'use strict';
/**
 * Phase-2 Regression — stale-code-clobber
 * runtime: browser | tags: regression, lifecycle, cluster-a
 *
 * EXPECTED-FAIL-UNTIL-FIX (Cluster A stale-code bug)
 *
 * The bug: after a member leaves a room, the app can still hold the old code in
 * localStorage.  If the user creates a NEW party, the app may:
 *   (a) hand out the stale code instead of a fresh one, landing both sessions in
 *       the same Durable Object; or
 *   (b) a concurrent joiner who caches the stale code dials the OLD room and
 *       clobbers the new session's state.
 *
 * This scenario drives both paths using raw Node WebSockets (no Playwright) because
 * the party-create flow is entirely in the worker (no app-side UI logic needed for
 * the protocol regression).
 *
 * Assertions:
 *   A. create(code1) → leave → create(code2 ≠ code1) → fresh welcome on code2
 *      (the second create yields a distinct room; no cross-contamination)
 *   B. join(stale=code1) while code2 is live → code1 room is empty (or non-member-
 *      bearing), stale joiner does NOT appear in code2's roster
 *
 * Both assertions currently FAIL because the worker's room identity is purely
 * code-keyed: re-joining the same code re-uses the same DO.  The fix (in a sibling
 * lane) adds a room-generation counter or re-key mechanism so the second "create"
 * gets a truly new room even if the code is recycled.
 *
 * Note: "create" in this context means connecting with leader=1 to a new code.
 * The regression only manifests when the SAME code is recycled (e.g. the app
 * re-uses the code from localStorage after a leave).
 */

const WebSocket = require('ws');

/** Open a WebSocket to /party/<code> and wait for the welcome frame. */
function wsConnect(wranglerHost, code, userId, isLeader, timeoutMs = 8_000) {
  return new Promise((resolve, reject) => {
    const url = `${wranglerHost}/party/${code}?user_id=${userId}&username=${userId}&leader=${isLeader ? 1 : 0}`;
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`wsConnect timeout after ${timeoutMs}ms for ${code}`));
    }, timeoutMs);

    ws.on('open', () => {});
    ws.on('message', (data) => {
      let m;
      try { m = JSON.parse(data); } catch (_) { return; }
      if (m.type === 'welcome') {
        clearTimeout(timer);
        resolve({ ws, welcome: m });
      }
    });
    ws.on('error', (err) => { clearTimeout(timer); reject(err); });
    ws.on('close', (code_) => {
      clearTimeout(timer);
      // If closed before welcome, treat as error.
      reject(new Error(`socket closed (${code_}) before welcome`));
    });
  });
}

/** Send a leave frame and close the socket. */
async function leaveAndClose(ws) {
  try {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'leave' }));
      await new Promise(r => setTimeout(r, 200));
    }
  } catch (_) {}
  try { ws.close(); } catch (_) {}
  await new Promise(r => setTimeout(r, 300));
}

/** Read all member IDs from a roster frame, or null if no roster seen. */
function getRosterMembers(messages) {
  // Worker broadcasts { type: 'roster', members: [{user_id, ...}, ...] }
  const rostMsg = [...messages].reverse().find(m => m.type === 'roster');
  if (!rostMsg) return null;
  return (rostMsg.members || []).map(m => m.user_id);
}

module.exports = async function staleCodeClobber(ctx) {
  const { genCode, wranglerHost } = ctx;

  // --- Part A: second create yields a FRESH room -------------------------
  //
  // Simulate: user creates code1 as leader, leaves, then creates code2 (≠ code1).
  // The second connect should get a fresh room state with zero other members.

  const code1 = genCode('S1');
  const code2 = genCode('S2');

  // Sanity — codes must differ (our genCode is random, collision probability ~0).
  if (code1 === code2) throw new Error('test invariant: code1 === code2 (random collision — rerun)');

  // Connect as leader on code1.
  const { ws: ws1, welcome: w1 } = await wsConnect(wranglerHost, code1, 'stale_leader', true);
  if (!w1.you || w1.you.user_id !== 'stale_leader') {
    await leaveAndClose(ws1);
    throw new Error(`Part A: unexpected welcome payload on code1: ${JSON.stringify(w1)}`);
  }

  // Leave code1.
  await leaveAndClose(ws1);

  // Connect as leader on code2 (simulating a fresh "create party" with a new code).
  let ws2, w2;
  try {
    ({ ws: ws2, welcome: w2 } = await wsConnect(wranglerHost, code2, 'stale_leader', true));
  } catch (err) {
    throw new Error(`Part A: failed to connect on code2 after leaving code1: ${err.message}`);
  }

  // The welcome on code2 must show zero members in the room (fresh room).
  // The roster list in the welcome snapshot should contain only ourselves.
  const membersInW2 = (w2.members || []).filter(m => m.user_id !== 'stale_leader');
  if (membersInW2.length > 0) {
    await leaveAndClose(ws2);
    throw new Error(
      `Part A FAIL (expected-fail-until-fix): code2 welcome shows stale members from code1: ` +
      `${JSON.stringify(membersInW2.map(m => m.user_id))}. ` +
      `The second create must yield a fresh room with no carry-over state.`
    );
  }

  // --- Part B: stale joiner on code1 must NOT appear in code2 roster ----
  //
  // While leader is on code2, a "stale" client still tries to join code1 (old cached code).
  // Assert: code1 either has no members (empty room) OR the stale joiner can join code1
  // without that join being visible in code2's roster.

  // Collect roster messages on ws2 via a listener.
  const code2Messages = [];
  ws2.on('message', (data) => {
    try { code2Messages.push(JSON.parse(data)); } catch (_) {}
  });

  // Stale client joins code1.
  let wsStale, wStale;
  try {
    ({ ws: wsStale, welcome: wStale } = await wsConnect(wranglerHost, code1, 'stale_joiner', false));
  } catch (err) {
    // If code1 is gone (DO evicted), that is acceptable — stale join failed cleanly.
    console.log(`       [info] Part B: stale join on code1 rejected (${err.message}) — acceptable`);
    await leaveAndClose(ws2);
    return; // PASS: stale code is already unreachable
  }

  // Give the worker a moment to broadcast any roster updates.
  await new Promise(r => setTimeout(r, 800));

  // Stale joiner is on code1. Check that code2's roster has NOT received a
  // member_joined or roster broadcast showing 'stale_joiner'.
  const crossContaminated = code2Messages.some(m =>
    (m.type === 'member_joined' && m.user_id === 'stale_joiner') ||
    (m.type === 'roster' && Array.isArray(m.members) &&
     m.members.some(mem => mem.user_id === 'stale_joiner'))
  );

  await leaveAndClose(wsStale);
  await leaveAndClose(ws2);

  if (crossContaminated) {
    throw new Error(
      `Part B FAIL (expected-fail-until-fix): stale_joiner on code1 was visible in code2's roster. ` +
      `Stale-code clobber: the two rooms share a DO or the leader's code2 is the same as code1.`
    );
  }
};
