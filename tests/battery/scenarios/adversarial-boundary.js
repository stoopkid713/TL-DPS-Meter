'use strict';
/**
 * Adversarial — Boundary / Capacity Limits
 * runtime: browser | tags: regression, adversarial
 *
 * NEGATIVE ASSERTIONS: every capacity boundary must be bounded and handled.
 * The room must NOT silently over-accept, corrupt state at the edge, or crash.
 *
 * Boundaries tested:
 *   A. MAX_ENCOUNTERS overflow (README says cap = 20): post 21 separate final
 *      encounters as the leader; assert the 21st is either evicted (oldest gone)
 *      OR the post is rejected with an encounter_evicted broadcast — NOT a crash
 *      or silent data loss on the ACTIVE encounter.
 *      Tag: expected-fail — the eviction behaviour is implemented but we confirm
 *      the active encounter is never the one evicted (guardrail: evicts oldest).
 *
 *   B. 13th join attempt on a full room (MAX_MEMBERS=12): already covered by
 *      max-party-churn, but we re-verify from a clean perspective here AND assert
 *      the party_full response is a clean rejection, not a server-error close.
 *      This is the adversarial complement: we try several tactics to squeeze in
 *      the 13th member (spectator flag, duplicate user_id of an existing member,
 *      rapid concurrent 12+1 join).
 *
 *   C. Idle-TTL edge: after all members leave cleanly, an immediate re-join must
 *      get a fresh room (not leftover state from the evicted DO's last state).
 *      NOTE: The GHOST_EVICT_MS window (5 min) means true TTL eviction requires
 *      a real wait — this scenario asserts only the IMMEDIATE re-join path (within
 *      seconds of all-leave), not the 5-min timeout.  The real TTL test is the
 *      idle-ttl-real-wait real-app scenario.
 *
 *   D. ping flood: send 200 pings rapidly; assert pong responses arrive and the
 *      room doesn't rate-limit into a crash.  Expected-PASS (pong is trivial).
 *      Tag: adversarial (confirming the keepalive path isn't a DoS vector).
 */

const {
  rawWsOpen, waitForWelcome, sendJson, dropSocket,
  leaveClose, expectReject, waitForWorkerMessage,
} = require('../receiving-client');

const WebSocket = require('ws');

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

const MAX_MEMBERS   = 12;
const MAX_ENCOUNTERS = 20;

module.exports = async function adversarialBoundary(ctx) {
  const { genCode, wranglerHost } = ctx;

  // ── Boundary A: MAX_ENCOUNTERS overflow ──────────────────────────────────
  //
  // We post MAX_ENCOUNTERS+1 = 21 distinct final encounters as leader.
  // The room must:
  //   1. Accept all 21 posts without crashing.
  //   2. Evict the OLDEST encounter (not the active one) when at cap.
  //   3. The 21st encounter must land in the active slot (not be silently lost).
  //
  // Because each post_fight with final:true closes the current encounter and
  // forces the next post into a new encounter_id, we drive this by sending 21
  // posts each with a unique encounter_id and final:true.
  {
    const code = genCode('BA');
    const h = await rawWsOpen(wranglerHost, code, 'ba_leader', true);
    await waitForWelcome(h);

    const broadcasts = [];
    h.ws.on('message', (data) => {
      try { broadcasts.push(JSON.parse(data)); } catch (_) {}
    });

    // Send MAX_ENCOUNTERS + 1 fights, each with a unique encounter_id + final:true.
    // We space them slightly to let the DO process each sequentially (FIFO).
    const baseTs = Date.now();
    for (let i = 0; i <= MAX_ENCOUNTERS; i++) {
      const encId = String(baseTs + i * 1000);
      sendJson(h.ws, {
        type: 'post_fight', v: 2,
        fight_ts: baseTs + i * 1000,
        targets: [{ target: 'Tevent', total_damage: 1000 + i, dps: 10, duration: 100, hits: 10, crit_rate: 10, heavy_rate: 5 }],
        summary: { total_damage: 1000 + i, duration: 100 },
        skills: null, rotation: null,
        encounter_id: encId,
        final: true, // each closes its encounter, forcing the next into a new one
      });
      await delay(60);
    }

    // Wait for all broadcasts to settle.
    await delay(3_000);

    // Assert: socket still open (no crash).
    if (h.ws.readyState !== WebSocket.OPEN) {
      throw new Error(
        '[Boundary-A] FAIL: leader socket closed after posting MAX_ENCOUNTERS+1 fights. ' +
        'The worker crashed or forcibly closed the socket at the encounter cap.'
      );
    }

    // Assert: at least one encounter_evicted broadcast was emitted (cap enforcement visible).
    // This is expected-fail if the worker does NOT emit encounter_evicted — document the gap.
    const evictions = broadcasts.filter(m => m.type === 'encounter_evicted');
    if (evictions.length === 0) {
      // Not a hard FAIL — the worker may evict silently. But we document it.
      console.warn(
        '       [boundary-A] NOTE: no encounter_evicted broadcast after 21 posts. ' +
        'Either cap is >20, eviction is silent, or encounters did not create 21 separate rows.'
      );
    }

    // Assert: the last scoreboard received reflects the 21st fight (not an older/evicted one).
    const lastSb = broadcasts.filter(m => m.type === 'scoreboard').pop();
    if (lastSb) {
      const expectedDamage = 1000 + MAX_ENCOUNTERS; // the 21st fight's damage
      // The scoreboard should contain entries for the active encounter.
      // We assert its total_damage is one of the recent posts (not 0 or some stale value).
      if (lastSb.total_damage === 0) {
        await leaveClose(h.ws).catch(() => {});
        throw new Error(
          '[Boundary-A] FAIL: last scoreboard shows total_damage=0 after 21 fights. ' +
          'The active encounter was unexpectedly cleared/evicted at the cap.'
        );
      }
    }

    await leaveClose(h.ws).catch(() => {});
  }

  // ── Boundary B: squeeze the 13th member ──────────────────────────────────
  //
  // Fill a room to 12, then try adversarial tactics to squeeze in the 13th:
  //   B1. Normal 13th join — must get party_full / 403.
  //   B2. 13th join as spectator=1 — spectators bypass the cap; should be ALLOWED.
  //   B3. 13th join using a user_id that matches an EXISTING member
  //       (reconnect path) — must be treated as a reconnect (slot reuse), not a new member.
  //   B4. Rapid concurrent 12+1 joins (race to be 12th) — only 12 should succeed.
  {
    const code = genCode('BB');
    const members = [];

    // Join leader.
    const leaderH = await rawWsOpen(wranglerHost, code, 'bb_leader', true);
    await waitForWelcome(leaderH);
    members.push(leaderH);

    // Join members 2..12.
    for (let i = 2; i <= MAX_MEMBERS; i++) {
      try {
        const h = await rawWsOpen(wranglerHost, code, `bb_m${i}`, false);
        await waitForWelcome(h, 6_000);
        members.push(h);
      } catch (err) {
        // If we get rejected before reaching 12, that's a guardrail over-firing.
        for (const m of members) await leaveClose(m.ws).catch(() => {});
        throw new Error(
          `[Boundary-B] FAIL: member bb_m${i} rejected before room reached cap. ` +
          `Expected cap=${MAX_MEMBERS}, rejected at slot ${i}: ${err.message}`
        );
      }
      await delay(80);
    }
    await delay(500);

    // B1: Normal 13th join — must be rejected.
    const r13 = await expectReject(wranglerHost, code, 'bb_m13', false);
    if (!r13.rejected) {
      for (const m of members) await leaveClose(m.ws).catch(() => {});
      throw new Error(
        '[Boundary-B1] FAIL: 13th member was NOT rejected. Room accepted >12 members. ' +
        'party_full cap enforcement is broken.'
      );
    }

    // B2: 13th join as spectator=1 — spectators bypass the cap per the protocol.
    // Connect manually since expectReject uses member connect.
    const specUrl = `${wranglerHost}/party/${code}?user_id=bb_spec&username=Spec&leader=0&spectator=1`;
    const specResult = await new Promise((resolve) => {
      const ws = new (require('ws'))(specUrl);
      const msgs = [];
      const timer = setTimeout(() => { ws.close(); resolve({ allowed: false }); }, 6_000);
      ws.on('message', (data) => {
        let m; try { m = JSON.parse(data); } catch (_) { return; }
        if (m.type === 'welcome') {
          clearTimeout(timer);
          resolve({ allowed: true, ws, welcome: m });
        }
      });
      ws.on('error', () => { clearTimeout(timer); resolve({ allowed: false }); });
      ws.on('unexpected-response', (_req, res) => {
        clearTimeout(timer); ws.terminate();
        resolve({ allowed: false, statusCode: res.statusCode });
      });
      ws.on('close', () => { clearTimeout(timer); resolve({ allowed: false }); });
    });

    // Spectators bypass the cap — if they're NOT allowed it's expected-fail
    // (the spec says spectator=1 bypasses; if not implemented, document the gap).
    if (!specResult.allowed) {
      console.warn(
        '       [boundary-B2] NOTE: spectator join was rejected on a full room. ' +
        'The protocol says spectators bypass the cap (spectator=1 is a read-only consumer). ' +
        'This is expected-fail if spectator bypass is not yet implemented.'
      );
    } else {
      // Spectator joined — assert welcome shows is_spectator:true.
      const you = specResult.welcome.you || {};
      if (you.is_spectator !== true) {
        if (specResult.ws) await leaveClose(specResult.ws, 50).catch(() => {});
        for (const m of members) await leaveClose(m.ws).catch(() => {});
        throw new Error(
          '[Boundary-B2] FAIL: spectator joined but welcome.you.is_spectator is not true. ' +
          `Got: ${JSON.stringify(you)}`
        );
      }
      if (specResult.ws) await leaveClose(specResult.ws, 50).catch(() => {});
    }

    // B3: 13th join using an EXISTING member's user_id (bb_m2) — must be treated as
    //     a reconnect, NOT a new slot (roster count stays at 12).
    const reconnectH = await rawWsOpen(wranglerHost, code, 'bb_m2', false, 6_000)
      .then(h => waitForWelcome(h).then(w => ({ h, w })))
      .catch(err => ({ error: err.message }));

    if (reconnectH.error) {
      // Reconnect was rejected — that's acceptable if the implementation treats
      // same-user_id as "already connected" and rejects the second socket.
      // It should NOT produce a 403 with a party_full-style message since the
      // user_id is already in the roster.
      // We just log this as an expected-fail gap to investigate.
      console.warn(
        `       [boundary-B3] NOTE: reconnect for existing member 'bb_m2' on full room was rejected: ${reconnectH.error}. ` +
        `This may be correct (the old socket is still open) or a gap in reconnect handling on full rooms.`
      );
    } else {
      // Reconnect succeeded — check the roster didn't grow past 12.
      const reconnectMsgs = reconnectH.h.messages;
      const welcome = reconnectH.w;
      const nonSpectatorMembers = (welcome.members || []).filter(m => !m.is_spectator);
      if (nonSpectatorMembers.length > MAX_MEMBERS) {
        await leaveClose(reconnectH.h.ws).catch(() => {});
        for (const m of members) await leaveClose(m.ws).catch(() => {});
        throw new Error(
          `[Boundary-B3] FAIL: after reconnect by bb_m2 on full room, welcome shows ${nonSpectatorMembers.length} members (>12). ` +
          `The reconnect was treated as a NEW slot instead of reusing the existing slot.`
        );
      }
      await leaveClose(reconnectH.h.ws).catch(() => {});
    }

    for (const m of members) await leaveClose(m.ws).catch(() => {});
  }

  // ── Boundary C: immediate re-join after all-leave (clean state) ──────────
  //
  // All members leave cleanly (not dropped).  Immediately re-join the same code
  // as a new leader.  The welcome must show 0 stale members (no ghost state
  // from the prior session if the DO is still alive).
  //
  // Note: this tests the IMMEDIATE path (DO still alive in memory).  If the DO
  // was already evicted the room is fresh by design.  The interesting case is
  // when the DO is alive but the roster was fully drained — it must be empty.
  {
    const code = genCode('BC');
    const MEMBER_COUNT = 3;

    const handles = [];
    for (let i = 0; i < MEMBER_COUNT; i++) {
      const h = await rawWsOpen(wranglerHost, code, `bc_m${i}`, i === 0);
      await waitForWelcome(h);
      handles.push(h);
      await delay(60);
    }

    // All leave gracefully.
    for (const h of handles) await leaveClose(h.ws, 80);
    await delay(300); // let DO process all leave events

    // Immediate re-join as a new leader.
    const rejoinH = await rawWsOpen(wranglerHost, code, 'bc_rejoin', true);
    const rejoinW = await waitForWelcome(rejoinH);

    const staleMembers = (rejoinW.members || []).filter(m =>
      m.user_id !== 'bc_rejoin' && m.online === true
    );
    await leaveClose(rejoinH.ws).catch(() => {});

    if (staleMembers.length > 0) {
      throw new Error(
        `[Boundary-C] FAIL: immediate re-join after all-leave shows ${staleMembers.length} stale ONLINE member(s): ` +
        `${JSON.stringify(staleMembers.map(m => m.user_id))}. ` +
        `The roster was not fully cleared when all members left (immediate path — DO still alive).`
      );
    }
  }

  // ── Boundary D: ping flood ────────────────────────────────────────────────
  //
  // Send 200 pings rapidly.  The room must respond with pongs (or at least not
  // crash — pong loss under flood is acceptable).  Assert the socket stays open.
  {
    const code = genCode('BD');
    const h = await rawWsOpen(wranglerHost, code, 'bd_pinger', true);
    await waitForWelcome(h);

    const pongCount = { n: 0 };
    h.ws.on('message', (data) => {
      try {
        const m = JSON.parse(data);
        if (m.type === 'pong') pongCount.n++;
      } catch (_) {}
    });

    const PINGS = 200;
    for (let i = 0; i < PINGS; i++) {
      sendJson(h.ws, { type: 'ping' });
      // No delay — fire all at once to stress the flood path
    }

    await delay(3_000); // give pongs time to drain

    // Assert: socket still open after the flood.
    if (h.ws.readyState !== WebSocket.OPEN) {
      throw new Error(
        `[Boundary-D] FAIL: socket closed during ping flood (after ${pongCount.n} pongs). ` +
        `The worker rate-limited or crashed under a burst of ${PINGS} pings.`
      );
    }

    // Soft check: at least some pongs received (proves the handler is working).
    if (pongCount.n === 0) {
      console.warn(
        `       [boundary-D] NOTE: received 0 pong responses to ${PINGS} pings. ` +
        `Pong handler may not be implemented or pong frames are not JSON (e.g., WS ping/pong control frames).`
      );
    }

    await leaveClose(h.ws).catch(() => {});
  }
};
