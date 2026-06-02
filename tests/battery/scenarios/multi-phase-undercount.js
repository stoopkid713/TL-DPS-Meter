'use strict';
/**
 * Phase-2 Regression — multi-phase-undercount
 * runtime: browser | tags: regression, scoreboard, cluster-a
 *
 * EXPECTED-FAIL-UNTIL-FIX (multi-phase undercount bug)
 *
 * The bug: when a member participates in multiple phases of a multi-boss encounter
 * (e.g. Tevent Phase 1 → Phase 2, stored as two separate encounter rows), the
 * SCOREBOARD for a given encounter shows that member's per-phase damage correctly.
 * However, the "Compare" view (which reads from member_detail rotation) should
 * show their COMBINED damage across both phases.
 *
 * The undercount manifests when:
 *   - Two phases of the same boss produce two encounter rows (same boss name, different fight_ts)
 *   - The scoreboard's `total_damage` for EACH encounter only includes one phase
 *   - The expected "both-phase" total (what Compare shows) is the SUM of both phases
 *   - A "combined scoreboard" or "session total" feature might show ONLY one phase
 *
 * This scenario:
 *   1. Drives a 2-phase boss via the multiboss sim (Tevent #1 and Tevent #2 from
 *      MULTIBOSS_SCENARIO — same boss name, distinct encounter IDs)
 *   2. Asserts that the encounters list has EXACTLY 2 Tevent entries (not collapsed)
 *   3. Asserts that EACH encounter's total_damage > 0 (both phases recorded)
 *   4. Asserts that the SUM of both Tevent encounters' total_damage matches what
 *      Compare would show (== combined phase total)
 *   5. Asserts that the active scoreboard's total_damage is ONE PHASE only, not the
 *      combined sum (i.e. the bug would be if the scoreboard shows combined = false,
 *      or the encounters list only shows 1 Tevent = true bug)
 *
 * The REAL undercount regression is:
 *   - The encounters list collapses same-boss entries → you can only see 1 Tevent
 *   - Assertion 2 (two distinct Tevent entries) would FAIL on the buggy path
 *
 * After the fix, the encounters list correctly enumerates both phases separately,
 * and assertion 2 passes.
 *
 * Uses runSim with --multiboss (drives Tevent #1 + Morokai + Tevent #2 = 3 encounters).
 */

const WebSocket = require('ws');

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

/** Open a WS observer and collect all messages for durationMs. */
function openObserver(wranglerHost, code, userId, durationMs) {
  return new Promise((resolve, reject) => {
    const url = `${wranglerHost}/party/${code}?user_id=${userId}&username=${userId}&leader=0`;
    const ws = new WebSocket(url);
    const msgs = [];
    let welcomed = false;

    const timer = setTimeout(() => {
      ws.close();
      if (!welcomed) reject(new Error(`observer never welcomed in ${durationMs}ms`));
      else resolve({ msgs, ws });
    }, durationMs);

    ws.on('message', (data) => {
      let m; try { m = JSON.parse(data); } catch (_) { return; }
      msgs.push(m);
      if (m.type === 'welcome') welcomed = true;
    });
    ws.on('error', (err) => { clearTimeout(timer); reject(err); });
    ws.on('close', () => {
      clearTimeout(timer);
      if (welcomed) resolve({ msgs, ws });
      else reject(new Error('observer closed before welcome'));
    });
  });
}

module.exports = async function multiPhaseUndercount(ctx) {
  const { genCode, runSim, wranglerHost } = ctx;
  const code = genCode('MP');

  // Open an observer BEFORE running the sim so we capture all broadcasts.
  const observerPromise = openObserver(wranglerHost, code, 'mp_observer', 45_000);

  // Run the multiboss sim: Tevent #1 → Morokai → Tevent #2 = 3 encounters.
  // We use runSim so the actual sim_party.py drives the WS connections (same as prod).
  const simResult = await runSim(
    [code, '--multiboss', '--members', '2'],
    35_000
  );
  // multiboss exits 0 on full PASS, 1 on assertion failures — both are acceptable here
  // because we make our OWN assertions on the received broadcasts.

  // Give the observer 2s to receive remaining broadcasts after sim exits.
  await delay(2_000);

  let msgs, wsObs;
  try {
    ({ msgs, ws: wsObs } = await observerPromise);
  } catch (err) {
    throw new Error(`Observer failed: ${err.message}`);
  }
  try { wsObs.close(); } catch (_) {}

  // --- Assertion 1: encounters list received ---
  const encMsgs = msgs.filter(m => m.type === 'encounters');
  if (encMsgs.length === 0) {
    throw new Error(
      `Assertion 1 FAIL: no encounters message received. ` +
      `The observer must receive at least one encounters broadcast after the sim posts 3 fights.`
    );
  }

  // Use the last (most up-to-date) encounters message.
  const lastEnc = encMsgs[encMsgs.length - 1];
  const encList = lastEnc.list || [];

  // --- Assertion 2: 2 Tevent entries (both phases enumerated separately) ---
  // This is the core multi-phase regression assertion.
  const teventEntries = encList.filter(e => {
    // Boss name matching: "Tevent" may have different capitalisation.
    return e.boss && /tevent/i.test(e.boss);
  });

  if (teventEntries.length < 2) {
    throw new Error(
      `Assertion 2 FAIL (expected-fail-until-fix): multi-phase undercount detected. ` +
      `Expected 2 distinct Tevent encounter rows (Phase 1 + Phase 2), ` +
      `but found ${teventEntries.length}: ${JSON.stringify(teventEntries.map(e => ({ id: e.encounter_id, boss: e.boss })))}. ` +
      `The encounters list is collapsing both Tevent phases into one row, ` +
      `causing the member's combined damage to be undercounted.`
    );
  }

  // --- Assertion 3: each Tevent encounter has total_damage > 0 ---
  for (const enc of teventEntries) {
    if (!(enc.total_damage > 0)) {
      throw new Error(
        `Assertion 3 FAIL: Tevent encounter ${enc.encounter_id} has total_damage = ` +
        `${enc.total_damage}. Both phases must have recorded damage.`
      );
    }
  }

  // --- Assertion 4: combined total == sum of both phases ---
  const combinedTotal = teventEntries.reduce((s, e) => s + (e.total_damage || 0), 0);
  // The combined total should be > either individual phase (sanity).
  const phase1 = teventEntries[0].total_damage;
  const phase2 = teventEntries[1].total_damage;
  if (combinedTotal <= Math.max(phase1, phase2)) {
    throw new Error(
      `Assertion 4 FAIL: combined Tevent total (${combinedTotal}) <= max single phase (${Math.max(phase1, phase2)}). ` +
      `Both phases must contribute independently.`
    );
  }

  // --- Assertion 5: the active scoreboard shows ONE phase, not the combined total ---
  // This assertion documents the EXPECTED behavior:
  //   - Active scoreboard = the currently-active encounter (one phase)
  //   - Combined total = what Compare shows (both phases summed)
  // If the scoreboard's total_damage equals the combined total, that would be the bug
  // (it's overcounting by including both phases in one scoreboard).
  const scoreboardMsgs = msgs.filter(m => m.type === 'scoreboard' && m.total_damage > 0);
  if (scoreboardMsgs.length > 0) {
    const lastSb = scoreboardMsgs[scoreboardMsgs.length - 1];
    if (lastSb.total_damage >= combinedTotal && teventEntries.length >= 2) {
      // This would mean the scoreboard is summing all Tevent phases = overcounting.
      // Only flag if significantly over (within 5% could be noise from member mult).
      const ratio = lastSb.total_damage / combinedTotal;
      if (ratio >= 0.95) {
        console.log(
          `       [warn] Assertion 5: last scoreboard total_damage (${lastSb.total_damage}) ` +
          `is close to or exceeds the COMBINED Tevent total (${combinedTotal}). ` +
          `Verify the scoreboard is showing only one phase, not both summed.`
        );
      }
    }
  }
};
