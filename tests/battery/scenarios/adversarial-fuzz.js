'use strict';
/**
 * Adversarial — Payload Fuzz
 * runtime: browser | tags: regression, adversarial
 *
 * NEGATIVE ASSERTIONS: every malformed / oversized / garbage frame must be
 * REJECTED or IGNORED gracefully by the worker.  The room must NOT crash,
 * hang, or enter a corrupted state.  A valid client that joins after the fuzz
 * must still receive a working welcome + scoreboard.
 *
 * Attack surface (per the wire protocol in README.md):
 *   1. Non-JSON text frames (garbage, empty string, binary-looking ASCII)
 *   2. JSON with unknown `type` field (garbage type)
 *   3. JSON with known `type` but wrong field types (type-mismatch)
 *   4. Oversized payload (>64 KB single frame)
 *   5. Empty frame (zero-length string)
 *   6. Unicode bombs and control characters in name/code fields
 *   7. post_fight with no `targets` array (or empty targets)
 *   8. post_fight with negative / absurd damage values
 *   9. Duplicate `user_id` in a post_fight (field-level bad value, not WS-level)
 *  10. `get_member_detail` for a nonexistent encounter_id
 *  11. Leader-only commands sent by a non-leader (should be silently dropped)
 *
 * After each fuzz batch the harness checks:
 *   - The FUZZER's socket has not been forcibly closed with a non-clean close
 *     code that indicates a server crash (500-class errors map to WS 1011).
 *   - A new CLEAN client can join and receive a well-formed welcome.
 *   - A new CLEAN client can receive a scoreboard after a valid post_fight.
 */

const {
  rawWsOpen, waitForWelcome, sendRaw, sendJson,
  dropSocket, leaveClose, waitForWorkerMessage,
} = require('../receiving-client');

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Send a batch of raw frames with a small gap between each.
 * Silently skips if the socket is closed.
 */
async function sprayFrames(ws, frames, gapMs = 30) {
  for (const f of frames) {
    sendRaw(ws, f);
    if (gapMs > 0) await delay(gapMs);
  }
}

/**
 * Assert the room is still serving valid clients by joining a clean socket
 * and posting a fight, then waiting for a scoreboard.
 * Throws on failure.
 */
async function assertRoomFunctional(wranglerHost, code, assertTag) {
  const cleanH = await rawWsOpen(wranglerHost, code, `fz_clean_${Date.now()}`, false, 8_000);
  const w = await waitForWelcome(cleanH, 8_000);
  if (!w || w.type !== 'welcome') {
    dropSocket(cleanH.ws);
    throw new Error(`${assertTag}: clean client did not receive a well-formed welcome after fuzz.`);
  }
  // Post a minimal fight and wait for scoreboard.
  const msgs = cleanH.messages;
  sendJson(cleanH.ws, {
    type: 'post_fight', v: 2,
    fight_ts: Date.now(),
    targets: [{ target: 'Tevent', total_damage: 10_000, dps: 100, duration: 100, hits: 10, crit_rate: 10, heavy_rate: 5 }],
    summary: { total_damage: 10_000, duration: 100 },
    skills: null, rotation: null,
    encounter_id: String(Date.now()), final: false,
  });
  const sb = await waitForWorkerMessage(msgs, m => m.type === 'scoreboard', 8_000);
  await leaveClose(cleanH.ws, 100).catch(() => {});
  if (!sb) {
    throw new Error(
      `${assertTag}: clean client did not receive a scoreboard after fuzz. ` +
      `Room may be stuck/corrupted.`
    );
  }
}

module.exports = async function adversarialFuzz(ctx) {
  const { genCode, wranglerHost } = ctx;

  // One persistent code for the fuzz room.  Leader stays connected as the
  // room anchor; the fuzzer joins as a member.
  const code = genCode('FZ');

  const leaderH = await rawWsOpen(wranglerHost, code, 'fz_leader', true);
  await waitForWelcome(leaderH);

  // ── Batch 1: structural garbage frames ──────────────────────────────────
  {
    const fuzzerH = await rawWsOpen(wranglerHost, code, 'fz_fuzz1', false);
    await waitForWelcome(fuzzerH);

    await sprayFrames(fuzzerH.ws, [
      '',                                         // empty frame
      'not json at all',                          // plain text
      '{{{{{{bad json}}}}}',                      // malformed JSON
      '\x00\x01\x02\x03',                         // control chars
      '[]',                                       // JSON array (not an object)
      'null',                                     // JSON null
      '42',                                       // JSON number
      '"just a string"',                          // JSON string
      '{',                                        // truncated JSON
    ]);

    await delay(400);

    // Fuzzer socket should still be open OR gracefully closed (not server-crash closed).
    // A clean WS close by the server (1008 Policy, 1003 unsupported data) is acceptable.
    // A 1011 Internal Error close indicates a server crash — that's a FAIL.
    const state = fuzzerH.ws.readyState;
    if (state === 3 /* CLOSED */) {
      // It closed — check the close code stored by the ws library.
      const closeCode = fuzzerH.ws._closeCode || fuzzerH.ws.closeCode;
      if (closeCode === 1011) {
        await leaveClose(leaderH.ws).catch(() => {});
        throw new Error(
          '[Fuzz-1] FAIL: worker closed the fuzzer socket with code 1011 (Internal Error) — ' +
          'a garbage frame triggered a server crash.'
        );
      }
      // Any other close code = server gracefully rejected. OK.
    } else {
      await leaveClose(fuzzerH.ws, 50).catch(() => {});
    }

    // Assert the room is still functional after structural garbage.
    await assertRoomFunctional(wranglerHost, code, '[Fuzz-1]');
  }

  // ── Batch 2: known type with wrong payload shapes ────────────────────────
  {
    const fuzzerH = await rawWsOpen(wranglerHost, code, 'fz_fuzz2', false);
    await waitForWelcome(fuzzerH);

    await sprayFrames(fuzzerH.ws, [
      // post_fight with missing required fields
      JSON.stringify({ type: 'post_fight' }),
      JSON.stringify({ type: 'post_fight', v: 2, fight_ts: 'not-a-number', targets: null }),
      JSON.stringify({ type: 'post_fight', v: 2, fight_ts: Date.now(), targets: [] }),          // empty targets
      JSON.stringify({ type: 'post_fight', v: 2, fight_ts: Date.now(), targets: 'string' }),    // targets as string
      // ping with extra garbage fields
      JSON.stringify({ type: 'ping', inject: '<script>alert(1)</script>' }),
      // leave with extra garbage
      JSON.stringify({ type: 'leave', extra: new Array(1000).fill('X').join('') }),
      // unknown types
      JSON.stringify({ type: 'UNKNOWN_TYPE_XYZ', payload: 123 }),
      JSON.stringify({ type: '' }),
      JSON.stringify({ type: null }),
      JSON.stringify({ type: 1234 }),
      // get_member_detail for nonexistent encounter
      JSON.stringify({ type: 'get_member_detail', encounter_id: 'nonexistent_999999', user_id: 'nobody' }),
      // leader-only commands from a non-leader
      JSON.stringify({ type: 'encounter_start' }),
      JSON.stringify({ type: 'encounter_end' }),
      JSON.stringify({ type: 'clear' }),
    ]);

    await delay(400);

    const state = fuzzerH.ws.readyState;
    if (state === 3) {
      const closeCode = fuzzerH.ws._closeCode || fuzzerH.ws.closeCode;
      if (closeCode === 1011) {
        await leaveClose(leaderH.ws).catch(() => {});
        throw new Error(
          '[Fuzz-2] FAIL: worker crashed (1011) on a type-mismatch or unknown-type frame.'
        );
      }
    } else {
      await leaveClose(fuzzerH.ws, 50).catch(() => {});
    }

    await assertRoomFunctional(wranglerHost, code, '[Fuzz-2]');
  }

  // ── Batch 3: oversized frames ────────────────────────────────────────────
  // The Cloudflare WS runtime enforces a message size limit (~1 MiB).  We send
  // frames that are large but under that limit first, then right at/over.
  {
    const fuzzerH = await rawWsOpen(wranglerHost, code, 'fz_fuzz3', false);
    await waitForWelcome(fuzzerH);

    // 64 KB name field — within CF WS limit but should be rejected by worker validation.
    const bigName = 'A'.repeat(65_536);
    const bigPayload = JSON.stringify({
      type: 'post_fight', v: 2,
      fight_ts: Date.now(),
      targets: [{ target: bigName, total_damage: 100, dps: 1, duration: 1, hits: 1, crit_rate: 0, heavy_rate: 0 }],
      summary: { total_damage: 100, duration: 1 },
      skills: null, rotation: null,
      encounter_id: String(Date.now()), final: false,
    });
    sendRaw(fuzzerH.ws, bigPayload);
    await delay(200);

    // 512 KB skills blob (opaque storage — worker may try to store this).
    const hugeSkills = JSON.stringify({ type: 'post_fight', v: 2,
      fight_ts: Date.now(),
      targets: [{ target: 'Tevent', total_damage: 100, dps: 1, duration: 1, hits: 1, crit_rate: 0, heavy_rate: 0 }],
      summary: { total_damage: 100, duration: 1 },
      skills: new Array(10_000).fill({ skill: 'X', damage: 1, hits: 1 }),
      rotation: null,
      encounter_id: String(Date.now()), final: false,
    });
    sendRaw(fuzzerH.ws, hugeSkills);
    await delay(400);

    const state = fuzzerH.ws.readyState;
    if (state === 3) {
      const closeCode = fuzzerH.ws._closeCode || fuzzerH.ws.closeCode;
      if (closeCode === 1011) {
        await leaveClose(leaderH.ws).catch(() => {});
        throw new Error(
          '[Fuzz-3] FAIL: worker crashed (1011) on an oversized payload. ' +
          'The worker must reject/truncate oversized frames without crashing.'
        );
      }
    } else {
      await leaveClose(fuzzerH.ws, 50).catch(() => {});
    }

    await assertRoomFunctional(wranglerHost, code, '[Fuzz-3]');
  }

  // ── Batch 4: adversarial field values ────────────────────────────────────
  // Boundary / negative / absurd numeric values and Unicode payloads.
  {
    const fuzzerH = await rawWsOpen(wranglerHost, code, 'fz_fuzz4', false);
    await waitForWelcome(fuzzerH);

    const absurdFights = [
      // Negative damage
      { target: 'Tevent', total_damage: -999_999, dps: -1, duration: -1, hits: -1, crit_rate: -100, heavy_rate: -100 },
      // Zero damage
      { target: 'Tevent', total_damage: 0, dps: 0, duration: 0, hits: 0, crit_rate: 0, heavy_rate: 0 },
      // Overflow-class large numbers
      { target: 'Tevent', total_damage: Number.MAX_SAFE_INTEGER, dps: 9e15, duration: 9e9, hits: 9e9, crit_rate: 999, heavy_rate: 999 },
      // Infinity / NaN
      { target: 'Tevent', total_damage: Infinity, dps: NaN, duration: 0, hits: 0, crit_rate: 0, heavy_rate: 0 },
    ];

    for (const target of absurdFights) {
      sendJson(fuzzerH.ws, {
        type: 'post_fight', v: 2,
        fight_ts: Date.now(),
        targets: [target],
        summary: { total_damage: target.total_damage, duration: target.duration },
        skills: null, rotation: null,
        encounter_id: String(Date.now()), final: false,
      });
      await delay(50);
    }

    // Unicode in user_id / username — these come in via URL params, but also via fight targets.
    const unicodeFight = {
      type: 'post_fight', v: 2,
      fight_ts: Date.now(),
      targets: [{ target: '🔥💀Boss ​', total_damage: 1, dps: 1, duration: 1, hits: 1, crit_rate: 0, heavy_rate: 0 }],
      summary: { total_damage: 1, duration: 1 },
      skills: null, rotation: null,
      encounter_id: String(Date.now()), final: false,
    };
    sendJson(fuzzerH.ws, unicodeFight);
    await delay(50);

    // Duplicate user_id in members field of a post (not the WS param — internal field forgery).
    sendJson(fuzzerH.ws, {
      type: 'post_fight', v: 2,
      fight_ts: Date.now(),
      user_id: 'fz_leader', // Trying to masquerade as the leader
      targets: [{ target: 'Tevent', total_damage: 999, dps: 10, duration: 100, hits: 10, crit_rate: 0, heavy_rate: 0 }],
      summary: { total_damage: 999, duration: 100 },
      skills: null, rotation: null,
      encounter_id: String(Date.now()), final: false,
    });
    await delay(400);

    const state = fuzzerH.ws.readyState;
    if (state === 3) {
      const closeCode = fuzzerH.ws._closeCode || fuzzerH.ws.closeCode;
      if (closeCode === 1011) {
        await leaveClose(leaderH.ws).catch(() => {});
        throw new Error(
          '[Fuzz-4] FAIL: worker crashed (1011) on adversarial numeric/unicode field values. ' +
          'Negative/NaN/Infinity damage values must be rejected or clamped, not crash the DO.'
        );
      }
    } else {
      await leaveClose(fuzzerH.ws, 50).catch(() => {});
    }

    await assertRoomFunctional(wranglerHost, code, '[Fuzz-4]');
  }

  // Cleanup leader.
  await leaveClose(leaderH.ws, 100).catch(() => {});
};
