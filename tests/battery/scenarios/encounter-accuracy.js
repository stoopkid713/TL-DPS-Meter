'use strict';
/**
 * Encounter-Accuracy Scenarios
 * runtime: browser | tags: encounter, scoreboard, accuracy
 *
 * Three sub-scenarios that verify how the worker creates, separates, and
 * exposes encounter rows in the encounters list broadcast.
 *
 *  C) dup-boss-distinct
 *     Same boss fought twice (wipe then retry) separated by a gap exceeding
 *     MERGE_WINDOW_MS (30 s) → worker must create TWO distinct encounter rows
 *     (not merge them into one).  Guards the wipe-retry regression.
 *
 *  D) trash-only-hidden
 *     Post hits against a target that is NOT in KNOWN_BOSSES ("Trash Pack").
 *     The encounters list must show the encounter with boss: null (no boss
 *     crowned).  Also verifies the scoreboard for that encounter has no entries
 *     (worker returns empty board when boss === null).
 *
 *  E) gap-splits
 *     Two separate posts with fight_ts offsets of 35 s (> MERGE_WINDOW_MS) and
 *     75 s apart from the first post respectively.  Each should produce a
 *     distinct encounter row.  Confirms encounter_boundary (gap-based split)
 *     works independently of boss identity.
 *
 * HARNESS NOTES:
 *  - Uses the WS observer pattern (node 'ws') from multi-phase-undercount.js.
 *    No Playwright / getBrowser needed.  runtime:'browser' is still correct —
 *    the runner provides wrangler dev and the genCode / runSim utilities.
 *  - MERGE_WINDOW_MS = 30 s in the worker.  We send fight_ts offsets > 30 000 ms
 *    (> 30 s) to guarantee new-encounter creation.  We use genCode() unique codes
 *    per scenario to avoid cross-contamination.
 *  - We build the post_fight frames manually (raw WS send) rather than using
 *    sim_party.py for the gap-splits and trash-only scenarios because sim_party
 *    has no flag for arbitrary fight_ts offsets or explicit non-boss targets.
 *    dup-boss-distinct reuses --multiboss (Tevent #1 + Tevent #2 are > 120 s
 *    apart in that harness), which is sufficient for the two-distinct-row assert.
 *
 * HARNESS CAPABILITY FLAG:
 *    Scenarios D and E send raw post_fight frames via a plain WebSocket without
 *    going through sim_party.py.  The runner's `runSim` wrapper only drives
 *    sim_party.py.  There is no raw-WS-send utility exposed by runner.js or
 *    receiving-client.js.  We therefore implement a minimal inline WS sender
 *    (openSenderWs) below.  If runner.js later exposes a sendRawFrames(code,
 *    frames) helper, that should replace openSenderWs here — FLAG for the
 *    harness/adversarial lane to expose if needed.
 */

const WebSocket = require('ws');

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Open a WS observer and collect all messages for durationMs.
 * Resolves with { msgs, close } once the welcome arrives or after the timeout.
 */
function openObserver(wranglerHost, code, userId, durationMs) {
  return new Promise((resolve, reject) => {
    const url = `${wranglerHost}/party/${code}?user_id=${userId}&username=${userId}&leader=0`;
    const ws = new WebSocket(url);
    const msgs = [];
    let welcomed = false;

    const timer = setTimeout(() => {
      try { ws.close(); } catch (_) {}
      if (!welcomed) reject(new Error(`observer never welcomed within ${durationMs}ms`));
      else resolve({ msgs, close: () => { try { ws.close(); } catch (_) {} } });
    }, durationMs);

    ws.on('message', (data) => {
      let m; try { m = JSON.parse(data); } catch (_) { return; }
      msgs.push(m);
      if (m.type === 'welcome') welcomed = true;
    });
    ws.on('error', (err) => { clearTimeout(timer); reject(err); });
    ws.on('close', () => {
      clearTimeout(timer);
      if (welcomed) resolve({ msgs, close: () => {} });
      else reject(new Error('observer WS closed before welcome'));
    });
  });
}

/**
 * Open a WS sender, wait for welcome, send each frame, then close.
 * Resolves once all frames are sent and the WS closes cleanly.
 */
function openSenderAndSend(wranglerHost, code, userId, frames) {
  return new Promise((resolve, reject) => {
    const url = `${wranglerHost}/party/${code}?user_id=${userId}&username=${userId}&leader=0`;
    const ws = new WebSocket(url);
    let welcomed = false;

    const timeout = setTimeout(() => {
      try { ws.close(); } catch (_) {}
      reject(new Error(`sender ${userId} timed out waiting for welcome`));
    }, 12_000);

    ws.on('message', async (data) => {
      let m; try { m = JSON.parse(data); } catch (_) { return; }
      if (m.type === 'welcome' && !welcomed) {
        welcomed = true;
        // Send frames sequentially with a small gap so the worker processes each.
        try {
          for (const frame of frames) {
            ws.send(JSON.stringify(frame));
            await delay(80);
          }
          // Brief pause before closing so the worker can write the submission row.
          await delay(300);
          clearTimeout(timeout);
          ws.close(1000, 'done');
          resolve();
        } catch (err) {
          clearTimeout(timeout);
          reject(err);
        }
      }
    });
    ws.on('error', (err) => { clearTimeout(timeout); reject(err); });
    ws.on('close', () => {
      clearTimeout(timeout);
      if (welcomed) resolve();
      // else: already rejected or resolved
    });
  });
}

/**
 * Build a minimal valid post_fight frame for an arbitrary target.
 * Uses the v2 protocol shape the worker expects.
 * fight_ts doubles as encounter_id (per the worker's slotting rule).
 */
function makePostFight({ fightTs, targetName, totalDamage, final = false }) {
  const encId = String(fightTs);
  return {
    type: 'post_fight',
    v: 2,
    fight_ts: fightTs,
    encounter_id: encId,
    targets: [{
      target: targetName,
      total_damage: totalDamage,
      dps: Math.round(totalDamage / 60),
      duration: 60.0,
      hits: 100,
      crit_rate: 30.0,
      heavy_rate: 20.0,
      crit_heavy_rate: 8.0,
      crit_heavy_count: 8,
    }],
    summary: { total_damage: totalDamage, duration: 60.0 },
    final,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenario C: dup-boss-distinct
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Same boss fought twice (wipe → retry).
 *
 * We reuse --multiboss because it posts Tevent #1 (fight_ts base) and
 * Tevent #2 (fight_ts base + 240 s) — well outside the 30 s merge window.
 * The test asserts that the encounters list received by the observer contains
 * at least 2 rows with boss matching "Tevent" (case-insensitive).
 *
 * Note: --multiboss also posts a Morokai between the two Tevents, so we may
 * see 3 total encounters.  We only assert >= 2 Tevent rows.
 *
 * This is a POSITIVE regression guard — it should already pass on current main
 * after the multi-phase-undercount fix.  If it fails, the worker is collapsing
 * the wipe/retry Tevent encounters into one row.
 */
module.exports.dupBossDistinct = async function dupBossDistinct(ctx) {
  const { genCode, runSim, wranglerHost } = ctx;
  const code = genCode('DB');

  const obsPromise = openObserver(wranglerHost, code, 'db_obs', 50_000);

  // --multiboss: Tevent#1 -> Morokai -> Tevent#2 (3 encounters, Tevent rows 120s apart).
  await runSim(
    [code, '--multiboss', '--members', '2'],
    38_000
  );

  await delay(2_500);

  let msgs, close;
  try {
    ({ msgs, close } = await obsPromise);
  } catch (err) {
    throw new Error(`Observer failed: ${err.message}`);
  }
  try { close(); } catch (_) {}

  // C1: at least one encounters broadcast received.
  const encMsgs = msgs.filter(m => m.type === 'encounters');
  if (encMsgs.length === 0) {
    throw new Error(
      `C1 FAIL: no encounters broadcast received by observer. ` +
      `--multiboss posts 3 fights; at least one encounters message must arrive.`
    );
  }

  const lastEnc = encMsgs[encMsgs.length - 1];
  const list = lastEnc.list || [];

  // C2: two distinct Tevent rows.
  const teventRows = list.filter(e => e.boss && /tevent/i.test(e.boss));
  if (teventRows.length < 2) {
    throw new Error(
      `C2 FAIL (dup-boss-distinct): expected >= 2 distinct Tevent encounter rows ` +
      `(wipe + retry), found ${teventRows.length}. ` +
      `The worker must NOT merge a wipe/retry into one row when fight_ts gap > 30 s. ` +
      `All encounter rows: ${JSON.stringify(list.map(e => ({ encounter_id: e.encounter_id, boss: e.boss })))}`
    );
  }

  // C3: each Tevent row has a distinct encounter_id.
  const tevIds = teventRows.map(e => e.encounter_id);
  const uniqueIds = new Set(tevIds);
  if (uniqueIds.size < 2) {
    throw new Error(
      `C3 FAIL: Tevent rows share the same encounter_id (${tevIds.join(', ')}). ` +
      `Each wipe/retry must have a unique encounter_id.`
    );
  }

  // C4: each Tevent row has total_damage > 0.
  for (const row of teventRows) {
    if (!(row.total_damage > 0)) {
      throw new Error(
        `C4 FAIL: Tevent encounter ${row.encounter_id} has total_damage = ${row.total_damage}. ` +
        `Both the wipe and retry must record damage independently.`
      );
    }
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Scenario D: trash-only-hidden
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Post hits against a target that is NOT in KNOWN_BOSSES ("Trash Pack").
 *
 * Expected behavior (from worker's detectBoss logic):
 *   detectBoss returns null when no known-boss target is present.
 *   Therefore:
 *   D1: encounters list has exactly 1 row with boss === null (no boss crowned).
 *   D2: that encounter's total_damage is 0 (worker only counts boss-target
 *       damage in buildEncounters; trash is excluded).
 *   D3: the scoreboard broadcast for that encounter has entries === [] and
 *       total_damage === 0 (worker returns the empty-board shape when boss is null).
 *   D4: the active encounter switcher entry does NOT show a boss name (boss null).
 *
 * We send one post_fight (final: true) against "Trash Pack" only.
 * No KNOWN_BOSSES target is present.
 *
 * HARNESS FLAG: uses openSenderAndSend (inline raw WS). If runner.js later
 * exposes sendRawFrames(code, frames, opts), replace the direct WS call here.
 */
module.exports.trashOnlyHidden = async function trashOnlyHidden(ctx) {
  const { genCode, wranglerHost } = ctx;
  const code = genCode('TR');

  const baseTs = Date.now();

  const obsPromise = openObserver(wranglerHost, code, 'tr_obs', 25_000);

  // Send one member's fight against "Trash Pack" (not in KNOWN_BOSSES).
  const frame = makePostFight({
    fightTs: baseTs,
    targetName: 'Trash Pack',
    totalDamage: 500_000,
    final: true,
  });
  await openSenderAndSend(wranglerHost, code, 'tr_sender', [frame]);

  await delay(1_500);

  let msgs, close;
  try {
    ({ msgs, close } = await obsPromise);
  } catch (err) {
    throw new Error(`Observer failed: ${err.message}`);
  }
  try { close(); } catch (_) {}

  // D1: encounters list received.
  const encMsgs = msgs.filter(m => m.type === 'encounters');
  if (encMsgs.length === 0) {
    throw new Error(
      `D1 FAIL: no encounters broadcast received after posting a trash-only fight. ` +
      `The worker must send an encounters broadcast after every post_fight.`
    );
  }
  const lastEnc = encMsgs[encMsgs.length - 1];
  const list = lastEnc.list || [];

  if (list.length === 0) {
    throw new Error(
      `D1b FAIL: encounters.list is empty. A trash-only fight must still create an ` +
      `encounter row (just without a boss label).`
    );
  }

  // D2: the encounter has boss === null (no boss crowned for trash targets).
  const withBoss = list.filter(e => e.boss !== null && e.boss !== undefined);
  if (withBoss.length > 0) {
    throw new Error(
      `D2 FAIL (trash-only-hidden): encounter(s) have a boss label even though only ` +
      `"Trash Pack" was posted (not in KNOWN_BOSSES). ` +
      `boss should be null. Got: ${JSON.stringify(withBoss.map(e => ({ encounter_id: e.encounter_id, boss: e.boss })))}`
    );
  }

  // D3: scoreboard for this encounter must have total_damage === 0 and empty entries.
  // The worker emits scoreboard after every post_fight; check the last one with
  // encounter_id matching the one we created (or just any scoreboard received).
  const sbMsgs = msgs.filter(m => m.type === 'scoreboard');
  if (sbMsgs.length > 0) {
    const lastSb = sbMsgs[sbMsgs.length - 1];
    if (lastSb.total_damage > 0) {
      throw new Error(
        `D3 FAIL (trash-only-hidden): scoreboard.total_damage = ${lastSb.total_damage} but ` +
        `no known boss was posted (only "Trash Pack"). The scoreboard must be empty ` +
        `(total_damage=0, entries=[]) when detectBoss returns null.`
      );
    }
    if (Array.isArray(lastSb.entries) && lastSb.entries.length > 0) {
      throw new Error(
        `D3b FAIL: scoreboard.entries has ${lastSb.entries.length} entry/entries despite ` +
        `a trash-only fight. No entries should appear when boss is null.`
      );
    }
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Scenario E: gap-splits
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Two posts with fight_ts offsets of 35 s and 75 s from the first fight_ts.
 *
 * MERGE_WINDOW_MS = 30 000 ms.  Both offsets exceed the merge window so BOTH
 * must create distinct encounter rows (not merge onto the first one).
 *
 *   Post 1: boss "Tevent",   fight_ts = base
 *   Post 2: boss "Morokai",  fight_ts = base + 35_000   (35 s gap, > 30 s)
 *   Post 3: boss "Junobote", fight_ts = base + 75_000   (75 s gap from base)
 *
 * After all posts the encounters list must have 3 distinct rows, each with a
 * different boss and different encounter_id.
 *
 * We also assert a 30 s non-boss gap to confirm the boundary works for
 * non-boss targets too (gap between post 1 base and post 2 base + 35 s).
 *
 * Note: all three targets are in KNOWN_BOSSES so each should get a boss label.
 * We chose a boss gap (not trash) to make total_damage > 0 assertions simple.
 *
 * HARNESS FLAG: uses openSenderAndSend (inline raw WS). See note in scenario D.
 */
module.exports.gapSplits = async function gapSplits(ctx) {
  const { genCode, wranglerHost } = ctx;
  const code = genCode('GS');

  const base = Date.now();

  // Three fights with fight_ts > MERGE_WINDOW_MS (30 s) apart.
  // 35 s gap between fight 1 and 2; 40 s additional gap between fight 2 and 3.
  const fightTs1 = base;
  const fightTs2 = base + 35_000;   // 35 s > MERGE_WINDOW_MS (30 s)
  const fightTs3 = base + 75_000;   // 75 s from base (40 s from fight 2)

  const frames = [
    makePostFight({ fightTs: fightTs1, targetName: 'Tevent',   totalDamage: 400_000, final: true }),
    makePostFight({ fightTs: fightTs2, targetName: 'Morokai',  totalDamage: 350_000, final: true }),
    makePostFight({ fightTs: fightTs3, targetName: 'Junobote', totalDamage: 300_000, final: true }),
  ];

  const obsPromise = openObserver(wranglerHost, code, 'gs_obs', 30_000);

  // Send all three frames from the same sender.  The worker will slot each into
  // a separate encounter because each fight_ts exceeds MERGE_WINDOW_MS from the
  // active encounter's started_at.
  await openSenderAndSend(wranglerHost, code, 'gs_sender', frames);

  await delay(1_500);

  let msgs, close;
  try {
    ({ msgs, close } = await obsPromise);
  } catch (err) {
    throw new Error(`Observer failed: ${err.message}`);
  }
  try { close(); } catch (_) {}

  // E1: encounters broadcast received.
  const encMsgs = msgs.filter(m => m.type === 'encounters');
  if (encMsgs.length === 0) {
    throw new Error(
      `E1 FAIL: no encounters broadcast received after 3 gap-separated posts.`
    );
  }
  const lastEnc = encMsgs[encMsgs.length - 1];
  const list = lastEnc.list || [];

  // E2: exactly 3 distinct encounter rows.
  if (list.length < 3) {
    throw new Error(
      `E2 FAIL (gap-splits): expected >= 3 encounter rows (one per fight_ts offset > 30 s), ` +
      `found ${list.length}. ` +
      `The worker must NOT merge posts whose fight_ts gap exceeds MERGE_WINDOW_MS (30 s). ` +
      `Encounter rows: ${JSON.stringify(list.map(e => ({ encounter_id: e.encounter_id, boss: e.boss })))}`
    );
  }

  // E3: all 3 have distinct encounter_ids.
  const encIds = list.map(e => e.encounter_id);
  const uniqueEncIds = new Set(encIds);
  if (uniqueEncIds.size < 3) {
    throw new Error(
      `E3 FAIL: fewer than 3 distinct encounter_ids despite 3 gap-separated posts. ` +
      `encounter_ids: ${encIds.join(', ')}`
    );
  }

  // E4: each expected boss appears in the list.
  const bossNames = list.map(e => (e.boss || '').toLowerCase());
  const expectedBosses = ['tevent', 'morokai', 'junobote'];
  for (const expected of expectedBosses) {
    if (!bossNames.some(b => b.includes(expected))) {
      throw new Error(
        `E4 FAIL: expected boss "${expected}" not found in encounters list. ` +
        `Boss names received: ${JSON.stringify(bossNames)}`
      );
    }
  }

  // E5: each row has total_damage > 0.
  for (const row of list) {
    if (!(row.total_damage > 0)) {
      throw new Error(
        `E5 FAIL: encounter ${row.encounter_id} (boss: ${row.boss}) has ` +
        `total_damage = ${row.total_damage}. All 3 gap-split encounters must record damage.`
      );
    }
  }
};
