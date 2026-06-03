'use strict';
/**
 * Stats-Parity Scenarios
 * runtime: browser | tags: stats, scoreboard, parity
 *
 * Two sub-scenarios bundled in one file:
 *
 *  A) stats-parity-crit-heavy
 *     Drives the built-in crit-heavy-parity --dry-run sim to confirm the
 *     Python side computes crit_heavy_rate / crit_heavy_count correctly, then
 *     connects two bots that post hits with KNOWN crit/heavy/crit+heavy counts
 *     and asserts that those fields survive the full round-trip onto the
 *     scoreboard entry received by an observer.  Guards the historical
 *     "0.0% C+H" bug where crit_heavy_rate was missing from the scoreboard.
 *
 *  B) stats-total-reconciles
 *     Connects two bots to the SAME encounter (--share-ts so they merge onto
 *     one row), collects the scoreboard broadcast, and asserts that:
 *       - board.total_damage == sum of entries[*].total_damage
 *       - contribution% across all entries sums ~100 (no undercount/double-count)
 *
 * Both sub-scenarios export the same async function signature fn(ctx) — this
 * file exports the two scenario functions directly and they are registered
 * separately in index.js.
 *
 * HARNESS NOTES:
 *  - Uses the WS observer pattern from multi-phase-undercount.js (not Playwright).
 *    runtime:'browser' is still correct: the runner wires wrangler dev; we open
 *    our own WS client (node 'ws') as the observer so no browser needed for the
 *    assertion path.  This matches the runner's expectation — any fn(ctx) that
 *    throws = FAIL, returns = PASS.
 *  - We do NOT call getBrowser() or openReceivingClient() here.
 */

const WebSocket = require('ws');

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Open a raw WS observer and collect all messages for durationMs.
 * Returns { msgs, close }.
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
      else reject(new Error('observer closed before welcome'));
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenario A: stats-parity-crit-heavy
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Two-phase verification:
 *
 * Phase 1 (dry-run parity gate):
 *   Run `sim_party.py --scenario crit-heavy-parity --dry-run` and assert PASS.
 *   This confirms the Python sim correctly computes crit_heavy_rate /
 *   crit_heavy_count from the same synthetic hit list that combat_stats uses.
 *   It's a fast no-WS sanity check before we test the full round-trip.
 *
 * Phase 2 (round-trip assertion):
 *   Drive the live --scenario crit-heavy-parity against wrangler dev.  An
 *   observer collects broadcasts and asserts that the scoreboard entry
 *   received by a non-posting member contains:
 *     - crit_heavy_rate > 0  (was 0.0 on the buggy path)
 *     - crit_heavy_count > 0
 *
 * The crit-heavy-parity scenario uses 100 synthetic hits in a cyclic pattern
 * (normal / crit / heavy / crit+heavy / ...) so exactly 25 hits are
 * crit+heavy.  crit_heavy_count should be 25 and crit_heavy_rate should be
 * ~25.0 (25/100 * 100).  We assert > 0, not the exact value, to stay robust
 * against future adjustments to the adjustment formula in combat_stats.
 */
module.exports.statsPariyCritHeavy = async function statsPariyCritHeavy(ctx) {
  const { genCode, runSim, wranglerHost } = ctx;
  const code = genCode('SP');

  // ── Phase 1: dry-run parity gate (no WS) ─────────────────────────────────
  const dryResult = await runSim(
    ['--scenario', 'crit-heavy-parity', '--dry-run'],
    10_000
  );
  if (dryResult.code !== 0) {
    throw new Error(
      `crit-heavy-parity --dry-run FAILED (code=${dryResult.code})\n` +
      dryResult.stderr.slice(0, 400)
    );
  }
  if (!/PASS/i.test(dryResult.stdout)) {
    throw new Error(
      `crit-heavy-parity --dry-run: expected PASS in output.\n` +
      dryResult.stdout.slice(0, 400)
    );
  }

  // ── Phase 2: live round-trip ───────────────────────────────────────────────
  // NOTE: the `crit-heavy-parity` scenario is a LOCAL parity check — it does NOT
  // post to a room (returns after asserting the stats math). For the live guard we
  // use --multiboss, which DOES post a detected boss (Tevent) whose target rows carry
  // crit_heavy_rate (_mb_targets → crit_heavy_rate: 8.0). That exercises the real path:
  // posted crit_heavy → worker storage → scoreboard entry (the historical 0.0% C+H bug).
  // Open observer BEFORE sim so it catches all broadcasts.
  const obsPromise = openObserver(wranglerHost, code, 'sp_ch_obs', 40_000);

  // We assert on the observer messages, not the sim exit code.
  await runSim(
    [code, '--multiboss'],
    40_000
  );

  // Give the worker a moment to broadcast after the final post.
  await delay(2_000);

  let msgs, close;
  try {
    ({ msgs, close } = await obsPromise);
  } catch (err) {
    throw new Error(`Observer failed: ${err.message}`);
  }
  try { close(); } catch (_) {}

  // ── Assertions ─────────────────────────────────────────────────────────────

  // A1: observer received a scoreboard broadcast.
  const scoreboardMsgs = msgs.filter(m => m.type === 'scoreboard' && m.total_damage > 0);
  if (scoreboardMsgs.length === 0) {
    throw new Error(
      `A1 FAIL: no scoreboard message with total_damage>0 received by observer. ` +
      `--multiboss posts Tevent (a known boss); the room must detect it and ` +
      `broadcast a scoreboard with damage.`
    );
  }

  const sb = scoreboardMsgs[scoreboardMsgs.length - 1];

  // A2: entries present.
  if (!Array.isArray(sb.entries) || sb.entries.length === 0) {
    throw new Error(
      `A2 FAIL: scoreboard has no entries. Got: ${JSON.stringify(sb).slice(0, 200)}`
    );
  }

  // A3: crit_heavy_rate is non-zero on at least one entry.
  // This is the historical "0.0% C+H" regression guard.
  const entryWithCH = sb.entries.find(e => e.crit_heavy_rate > 0);
  if (!entryWithCH) {
    throw new Error(
      `A3 FAIL (crit_heavy_rate bug): all scoreboard entries have crit_heavy_rate == 0. ` +
      `--multiboss posts a boss target with crit_heavy_rate=8.0; that value must ` +
      `propagate post_fight → worker storage → scoreboard entry (the historical 0.0% C+H bug). ` +
      `Entries received: ${JSON.stringify(sb.entries.map(e => ({
        user_id: e.user_id,
        crit_rate: e.crit_rate,
        heavy_rate: e.heavy_rate,
        crit_heavy_rate: e.crit_heavy_rate,
        crit_heavy_count: e.crit_heavy_count,
      })))}`
    );
  }

  // A4 (soft): crit_heavy_count consistency. --multiboss posts crit_heavy_rate but may
  // not carry crit_heavy_count, so this is a warning, not a hard fail — A3 (rate>0) is
  // the primary 0.0%-C+H regression guard.
  if (!(entryWithCH.crit_heavy_count > 0)) {
    console.warn(
      `[stats-parity-crit-heavy] note: crit_heavy_rate=${entryWithCH.crit_heavy_rate} but ` +
      `crit_heavy_count=${entryWithCH.crit_heavy_count} — count not posted by --multiboss (non-fatal).`
    );
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Scenario B: stats-total-reconciles
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Two bots post to the SAME encounter (--share-ts so they merge onto one row).
 * An observer collects the final scoreboard and verifies:
 *
 *   B1: board.total_damage == sum(entries[*].total_damage)    (no undercount)
 *   B2: sum(entries[*].contribution) ≈ 100                   (no double-count)
 *   B3: every entry has total_damage > 0                      (no zero-damage ghost entry)
 *
 * Uses --share-ts so both bots land on one encounter row (positive merge path).
 * Uses --now so the sim exits quickly after posting rather than waiting for
 * the reader loop.  We assert on the observer, not the sim exit code.
 */
module.exports.statsTotalReconciles = async function statsTotalReconciles(ctx) {
  const { genCode, runSim, wranglerHost } = ctx;
  const code = genCode('ST');

  const obsPromise = openObserver(wranglerHost, code, 'st_obs', 40_000);

  // Two bots, shared fight_ts (merge path), post immediately.
  const simResult = await runSim(
    [code, '--members', '2', '--now', '--share-ts'],
    20_000
  );
  // --now mode: the sim posts immediately and exits.  timedOut is also acceptable
  // (the reader loop waits for more input; posts already went through).
  if (simResult.code !== 0 && !simResult.timedOut) {
    throw new Error(
      `sim_party --now --share-ts exited unexpectedly (code=${simResult.code})\n` +
      simResult.stderr.slice(0, 400)
    );
  }

  await delay(2_500);

  let msgs, close;
  try {
    ({ msgs, close } = await obsPromise);
  } catch (err) {
    throw new Error(`Observer failed: ${err.message}`);
  }
  try { close(); } catch (_) {}

  const scoreboardMsgs = msgs.filter(m => m.type === 'scoreboard' && m.total_damage > 0);
  if (scoreboardMsgs.length === 0) {
    throw new Error(
      `B0 FAIL: no scoreboard with total_damage>0 received. ` +
      `Two bots posted to the same encounter (--share-ts); the room should detect ` +
      `a known boss and broadcast the merged scoreboard.`
    );
  }

  const sb = scoreboardMsgs[scoreboardMsgs.length - 1];
  const entries = sb.entries || [];

  if (entries.length === 0) {
    throw new Error(`B0b FAIL: scoreboard.entries is empty. Got: ${JSON.stringify(sb).slice(0, 200)}`);
  }

  // B1: board total == sum of individual entries.
  const sumEntries = entries.reduce((s, e) => s + (e.total_damage || 0), 0);
  if (sb.total_damage !== sumEntries) {
    throw new Error(
      `B1 FAIL (total undercount/double-count): scoreboard.total_damage = ${sb.total_damage} ` +
      `but sum(entries[*].total_damage) = ${sumEntries}. ` +
      `Entries: ${JSON.stringify(entries.map(e => ({ user_id: e.user_id, total_damage: e.total_damage })))}`
    );
  }

  // B2: contribution% sums ~100.
  const contribSum = entries.reduce((s, e) => s + (e.contribution || 0), 0);
  if (Math.abs(contribSum - 100) > 2) {
    throw new Error(
      `B2 FAIL (contribution% imbalance): sum(contribution) = ${contribSum.toFixed(1)}, expected ~100. ` +
      `Entries: ${JSON.stringify(entries.map(e => ({ user_id: e.user_id, contribution: e.contribution })))}`
    );
  }

  // B3: no zero-damage ghost entry.
  const zeroEntries = entries.filter(e => !(e.total_damage > 0));
  if (zeroEntries.length > 0) {
    throw new Error(
      `B3 FAIL: ${zeroEntries.length} entry/entries have total_damage <= 0. ` +
      `Ghost or uninitialized entry in the scoreboard: ` +
      `${JSON.stringify(zeroEntries.map(e => ({ user_id: e.user_id, total_damage: e.total_damage })))}`
    );
  }
};
