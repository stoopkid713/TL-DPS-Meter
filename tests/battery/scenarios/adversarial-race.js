'use strict';
/**
 * Adversarial — Race / Churn scenarios
 * runtime: browser | tags: regression, adversarial
 *
 * These scenarios fire rapid concurrent lifecycle operations to assert that:
 *   - no room-state corruption occurs under churn
 *   - roster + leader invariants are preserved throughout
 *   - the worker HANDLES the chaos gracefully (no crash, no ghost slots)
 *
 * Scenarios exported as a single fn (registered as one battery entry).
 *
 * Negative assertions:
 *   A. rapid create→leave→join churn on the SAME code must not leave ghost slots
 *      or corrupt the leader slot. Expected-PASS (the cap / session logic should
 *      absorb this, but the scenario confirms it under load).
 *   B. concurrent simultaneous joins (all racing to be the first member) must not
 *      produce duplicate roster entries for the same user_id. Expected-PASS (DO
 *      serialises via single-threaded event loop, but we confirm no dup appears).
 *   C. rapid-fire create→leave on DIFFERENT codes (leader spams room creation) must
 *      not leave leaked DOs with phantom members visible in newly created rooms.
 *      Expected-PASS.
 */

const { rawWsOpen, waitForWelcome, sendJson, dropSocket, leaveClose, collectFor } = require('../receiving-client');

const WebSocket = require('ws');

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = async function adversarialRace(ctx) {
  const { genCode, wranglerHost } = ctx;

  // ── Scenario A: rapid create→leave→join churn, SAME code ─────────────────
  //
  // Attack: repeatedly join and leave the same room quickly.  The DO's roster
  // must stay self-consistent — no ghost slots from incomplete cleanup, no
  // leader flip, count must match the number of currently connected sockets.
  {
    const code = genCode('RA');
    const ROUNDS = 6;

    // Join leader — this one persists.
    const leaderH = await rawWsOpen(wranglerHost, code, 'ra_leader', true);
    await waitForWelcome(leaderH);

    // Collect broadcast messages on the leader's socket to verify roster health.
    const leaderBroadcasts = [];
    leaderH.ws.on('message', (data) => {
      try { leaderBroadcasts.push(JSON.parse(data)); } catch (_) {}
    });

    // Churn: join + abrupt drop, rapidly, with the same user IDs recycled.
    for (let round = 0; round < ROUNDS; round++) {
      const uid = `ra_churn${round % 3}`; // recycle 3 IDs to stress reconnect path
      let h;
      try {
        h = await rawWsOpen(wranglerHost, code, uid, false, 5_000);
        await waitForWelcome(h, 5_000);
        // Alternate: graceful leave vs abrupt drop
        if (round % 2 === 0) {
          await leaveClose(h.ws, 100);
        } else {
          dropSocket(h.ws);
        }
      } catch (_) {
        // A rejection during a reconnect storm is acceptable — the guardrail held.
        if (h && h.ws) dropSocket(h.ws);
      }
      await delay(80);
    }

    // After the storm, wait for the DO to process stragglers.
    await delay(600);

    // Assert: the leader's socket is still open (no crash took it down).
    if (leaderH.ws.readyState !== WebSocket.OPEN) {
      await leaveClose(leaderH.ws).catch(() => {});
      throw new Error(
        '[Race-A] FAIL: leader socket closed during churn storm. ' +
        'Worker may have crashed or evicted the leader unexpectedly.'
      );
    }

    // Assert: the most recent roster broadcast must NOT show more unique user_ids
    // than currently open connections (which is just the leader at this point).
    const lastRoster = leaderBroadcasts.filter(m => m.type === 'roster').pop();
    if (lastRoster) {
      const rosterIds = (lastRoster.members || []).map(m => m.user_id);
      const uniqueIds = new Set(rosterIds);
      if (rosterIds.length !== uniqueIds.size) {
        await leaveClose(leaderH.ws).catch(() => {});
        throw new Error(
          `[Race-A] FAIL: roster contains duplicate user_ids after churn: ${JSON.stringify(rosterIds)}. ` +
          `Ghost slot created by reconnect storm.`
        );
      }
      // Only the leader (and possibly any churner that rejoined last and stayed connected)
      // should appear.  Every member that left / was dropped must NOT still appear online.
      const churnIds = ['ra_churn0', 'ra_churn1', 'ra_churn2'];
      const onlineGhosts = (lastRoster.members || []).filter(
        m => churnIds.includes(m.user_id) && m.online === true
      );
      if (onlineGhosts.length > 0) {
        await leaveClose(leaderH.ws).catch(() => {});
        throw new Error(
          `[Race-A] FAIL: dropped/left members still appear ONLINE in roster: ` +
          `${onlineGhosts.map(m => m.user_id).join(', ')}. Ghost online state not cleaned up.`
        );
      }
    }

    await leaveClose(leaderH.ws).catch(() => {});
  }

  // ── Scenario B: concurrent simultaneous joins, same user_id ───────────────
  //
  // Attack: open N sockets with the SAME user_id concurrently.  The DO must
  // keep the roster at exactly 1 entry for that user_id (last-write-wins /
  // reconnect path), never a duplicate ghost slot.
  {
    const code = genCode('RB');
    const CONCURRENT = 4;

    // Leader first.
    const leaderH = await rawWsOpen(wranglerHost, code, 'rb_leader', true);
    await waitForWelcome(leaderH);

    const leaderBroadcasts = [];
    leaderH.ws.on('message', (data) => {
      try { leaderBroadcasts.push(JSON.parse(data)); } catch (_) {}
    });

    // Fire CONCURRENT connects with same user_id simultaneously.
    const raceHandles = await Promise.allSettled(
      Array.from({ length: CONCURRENT }, () =>
        rawWsOpen(wranglerHost, code, 'rb_racer', false, 6_000)
      )
    );

    await delay(700); // let DO serialise + broadcast

    // All that connected → welcome them and then close all but pick a winner check.
    const open = raceHandles.filter(r => r.status === 'fulfilled').map(r => r.value);
    for (const h of open) await leaveClose(h.ws, 50).catch(() => {});

    await delay(400);

    // Assert: the roster never showed more than 1 slot for rb_racer.
    const rosters = leaderBroadcasts.filter(m => m.type === 'roster');
    for (const r of rosters) {
      const racerEntries = (r.members || []).filter(m => m.user_id === 'rb_racer');
      if (racerEntries.length > 1) {
        await leaveClose(leaderH.ws).catch(() => {});
        throw new Error(
          `[Race-B] FAIL: roster shows ${racerEntries.length} entries for 'rb_racer' at some point. ` +
          `Concurrent same-user_id joins produced duplicate ghost slots.`
        );
      }
    }

    await leaveClose(leaderH.ws).catch(() => {});
  }

  // ── Scenario C: leader spams rapid create→leave on different codes ─────────
  //
  // Attack: a client that rapidly creates distinct rooms (acts as leader) and
  // immediately leaves each one.  When it then joins a NEW code and posts data,
  // the room must be clean — no stale members or data bleeding in from a
  // prior room.
  {
    const SPRAY_COUNT = 5;

    // Spray: join as leader, abruptly drop.
    for (let i = 0; i < SPRAY_COUNT; i++) {
      const code = genCode('RC');
      let h;
      try {
        h = await rawWsOpen(wranglerHost, code, 'rc_leader', true, 4_000);
        await waitForWelcome(h, 4_000);
        // Abrupt drop to stress cleanup.
        dropSocket(h.ws);
      } catch (_) {
        if (h && h.ws) dropSocket(h.ws);
      }
      await delay(60);
    }

    // Now create a fresh room and post a fight — it must be clean (no ghosts,
    // no leaked data from spray rooms).
    const freshCode = genCode('RC');
    const freshH = await rawWsOpen(wranglerHost, freshCode, 'rc_clean', true);
    const w = await waitForWelcome(freshH);

    // Assert: fresh room welcome has zero members besides ourselves.
    const othersInWelcome = (w.members || []).filter(m => m.user_id !== 'rc_clean');
    if (othersInWelcome.length > 0) {
      await leaveClose(freshH.ws).catch(() => {});
      throw new Error(
        `[Race-C] FAIL: fresh room welcome shows stale members: ` +
        `${JSON.stringify(othersInWelcome.map(m => m.user_id))}. ` +
        `Data from a prior sprayed room bled into a new DO.`
      );
    }

    // Post a minimal fight and assert a scoreboard comes back (room is functional).
    const freshBroadcasts = [];
    freshH.ws.on('message', (data) => {
      try { freshBroadcasts.push(JSON.parse(data)); } catch (_) {}
    });

    sendJson(freshH.ws, {
      type: 'post_fight',
      v: 2,
      fight_ts: Date.now(),
      targets: [{ target: 'Tevent', total_damage: 100000, dps: 1000, duration: 100, hits: 100, crit_rate: 20, heavy_rate: 10 }],
      summary: { total_damage: 100000, duration: 100 },
      skills: null,
      rotation: null,
      encounter_id: String(Date.now()),
      final: false,
    });

    await delay(1_500);

    const sb = freshBroadcasts.find(m => m.type === 'scoreboard');
    if (!sb) {
      await leaveClose(freshH.ws).catch(() => {});
      throw new Error(
        '[Race-C] FAIL: fresh room did not produce a scoreboard after post_fight. ' +
        'Room may be stuck/corrupted after the spray-then-create sequence.'
      );
    }

    await leaveClose(freshH.ws).catch(() => {});
  }
};
