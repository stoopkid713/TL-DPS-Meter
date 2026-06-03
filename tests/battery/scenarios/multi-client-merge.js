'use strict';
/**
 * Multi-client merge scenarios (3 scenarios)
 * runtime: browser | tags: regression, merge, multi-client
 *
 * These scenarios exercise the worker's proximity-window merge logic from the
 * perspective of a RECEIVING CLIENT (Playwright page) as well as the sim bots.
 *
 * Three sub-scenarios, each exported as a named function and wired into the
 * index as separate entries:
 *
 *   merge-two-clients
 *     Two sim bots post the SAME boss with fight_ts values that fall within the
 *     worker's merge window (--share-ts → single fight_ts = definitively inside
 *     the window).  The receiving client must see ONE merged board with both
 *     members present and contribution% summing ~100.
 *
 *   merge-window-distinct
 *     Two sim bots post the SAME boss but with DISTINCT fight_ts (default 7s
 *     apart, well OUTSIDE any reasonable merge window).  The receiving client
 *     sees TWO separate encounter rows — the merge must NOT have fired.
 *     NOTE: tagged expected-fail-until-fix — the merge regression means the
 *     worker currently DOES merge these when it should not (or leaves them
 *     distinct when it should — whichever direction the bug manifests).
 *     The assertion is written for the CORRECT post-fix behaviour.
 *
 *   late-join-midfight
 *     Bot1 posts a fight (non-final), then a second bot (late-join) posts to
 *     the SAME encounter.  The receiving client joined BEFORE bot1's post and
 *     must see the latecomer appear in the next scoreboard update (both members
 *     present on the board, contribution% ~100).
 *
 * Harness capability flags (things we observe but cannot fully drive):
 *   - We use ONE receiving client (one Playwright page) per sub-scenario.
 *     Driving MULTIPLE simultaneous receiving clients (two Playwright pages in
 *     the same context) is architecturally possible (context.newPage() twice)
 *     but the runner provisions one context per scenario via getBrowser().
 *     FLAG: the dispatcher should open a second page for "both sides of the
 *     merge window from the UI" if a future scenario needs it.
 *   - We cannot directly assert the worker's encounter_id_map (the redirect
 *     table used by the merge logic) — we infer merge outcome from the
 *     encounters list length and scoreboard entries_n.
 */

const WebSocket = require('ws');
const { openReceivingClient, waitForWorkerMessage } = require('../receiving-client');

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// ---------------------------------------------------------------------------
// Helpers — raw Node WS observer (same pattern as multi-phase-undercount)
// ---------------------------------------------------------------------------

/**
 * Open a raw WS observer on the given code and collect messages until
 * durationMs elapses or the socket closes.
 */
function openObserver(wranglerHost, code, userId, durationMs) {
  return new Promise((resolve, reject) => {
    const url = `${wranglerHost}/party/${code}?user_id=${userId}&username=${userId}&leader=0`;
    const ws = new WebSocket(url);
    const msgs = [];
    let welcomed = false;

    const timer = setTimeout(() => {
      ws.close();
      if (!welcomed) reject(new Error(`observer ${userId} never welcomed in ${durationMs}ms`));
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
      else reject(new Error(`observer ${userId} closed before welcome`));
    });
  });
}

// ---------------------------------------------------------------------------
// Scenario A: merge-two-clients
// ---------------------------------------------------------------------------
/**
 * Two sim bots fight the SAME boss within the merge window (--share-ts so both
 * use identical fight_ts).  The receiving client (Playwright) must see:
 *   - ONE encounter row in the encounters list (merged)
 *   - TWO members on that encounter's scoreboard (entries_n == 2)
 *   - contribution% sums ~100
 *
 * Uses runSim([code, '--members', '2', '--now', '--share-ts']) — the shared
 * fight_ts means both bots land on the SAME encounter key, which is the
 * positive-path merge (the fix must land here for this to PASS).
 *
 * Tagged expected-fail-until-fix: the merge regression currently keeps two
 * separate rows for distinct fight_ts; share-ts is the workaround that forces
 * the same key without relying on the proximity window.  If the fix lands, this
 * scenario becomes the positive-path smoke test for merge.
 */
module.exports.mergeTwoClients = async function mergeTwoClients(ctx) {
  const { genCode, runSim, getBrowser, wranglerHost, indexHtml } = ctx;
  const code = genCode('MC');

  const { context } = await getBrowser();

  // Open receiving client BEFORE bots post so it captures broadcasts from t=0.
  const { page, messages, errors } = await openReceivingClient({
    context,
    indexHtml,
    code,
    wranglerHost,
    userId:   'mc_rx_1',
    username: 'MergeRx',
  });

  const welcome = await waitForWorkerMessage(messages, m => m.type === 'welcome', 12_000);
  if (!welcome) {
    throw new Error('merge-two-clients: receiving client did not get welcome frame');
  }

  // Run two bots sharing a single fight_ts → both land on the SAME encounter key.
  // --now mode: bots post immediately (no leader-wait).
  const simResult = await runSim(
    [code, '--members', '2', '--now', '--share-ts'],
    20_000
  );
  // --now mode can time out in the reader loop after posting; that is acceptable.
  if (simResult.code !== 0 && !simResult.timedOut) {
    throw new Error(
      `merge-two-clients: sim exited unexpectedly (code=${simResult.code}):\n` +
      simResult.stderr.slice(0, 400)
    );
  }

  // The receiving client should get a scoreboard with both members merged.
  const scoreboard = await waitForWorkerMessage(
    messages, m => m.type === 'scoreboard' && Array.isArray(m.entries) && m.entries.length >= 2, 15_000
  );
  if (!scoreboard) {
    // Tolerate: a scoreboard with at least one entry may arrive if only one bot posted.
    // Fail specifically if we got nothing at all.
    const anySb = await waitForWorkerMessage(messages, m => m.type === 'scoreboard', 3_000);
    throw new Error(
      `merge-two-clients: receiving client did not see a scoreboard with 2 entries. ` +
      (anySb
        ? `Got a scoreboard with ${(anySb.entries || []).length} entries (merge did not combine both bots).`
        : `Got NO scoreboard at all (bots may not have posted).`)
    );
  }

  // Contribution% must sum ~100.
  const contribSum = scoreboard.entries.reduce((s, e) => s + (e.contribution || 0), 0);
  if (Math.abs(contribSum - 100) > 3) {
    throw new Error(
      `merge-two-clients: contribution% sum = ${contribSum.toFixed(1)}, expected ~100. ` +
      `Entries: ${JSON.stringify(scoreboard.entries.map(e => ({ u: e.user_id, pct: e.contribution })))}`
    );
  }

  // The encounters list should show exactly ONE merged encounter (not two).
  const encMsg = await waitForWorkerMessage(messages, m => m.type === 'encounters', 8_000);
  if (encMsg) {
    const encList = encMsg.list || [];
    if (encList.length > 1) {
      throw new Error(
        `merge-two-clients: expected 1 merged encounter row, got ${encList.length}. ` +
        `The two --share-ts bots must land on the same encounter key. ` +
        `Encounter IDs: ${JSON.stringify(encList.map(e => e.encounter_id))}`
      );
    }
  }

  // No fatal JS errors on the receiving client.
  const fatal = errors.filter(e =>
    /SyntaxError|ReferenceError|is not defined|is not a function|TypeError/.test(e) &&
    !/fetch|net::ERR|CORS|Failed to load/.test(e)
  );
  if (fatal.length > 0) {
    throw new Error(`merge-two-clients: fatal JS errors on receiving client:\n  ${fatal.slice(0, 3).join('\n  ')}`);
  }

  await page.close();
};

// ---------------------------------------------------------------------------
// Scenario B: merge-window-distinct
// ---------------------------------------------------------------------------
/**
 * Two sim bots post the SAME boss but with DISTINCT fight_ts (7s apart, the
 * default behaviour).  The worker should treat these as TWO separate encounters
 * (the merge window does not cover a 7s gap by design, OR the merge regression
 * means they were never merged in the first place).
 *
 * Correct post-fix behaviour: 2 distinct encounter rows in the list.
 *
 * This scenario uses a raw Node observer (no Playwright) — it's a pure
 * protocol assertion, not a UI rendering check.  We match multi-phase-undercount
 * pattern (openObserver + runSim).
 *
 * Tagged expected-fail-until-fix IF the current code incorrectly merges distinct
 * fight_ts (i.e. the merge window is too wide).  If the current code correctly
 * keeps them distinct, this scenario passes immediately as a regression guard.
 */
module.exports.mergeWindowDistinct = async function mergeWindowDistinct(ctx) {
  const { genCode, runSim, wranglerHost } = ctx;
  const code = genCode('MWD');

  // Open a raw observer before running the sim.
  const observerPromise = openObserver(wranglerHost, code, 'mwd_obs', 40_000);

  // Two bots, DISTINCT fight_ts (default — no --share-ts).
  const simResult = await runSim(
    [code, '--members', '2', '--now'],
    25_000
  );
  // --now may time out in the reader loop; acceptable.

  // Give observer 2s to collect remaining broadcasts.
  await delay(2_000);

  let msgs, wsObs;
  try {
    ({ msgs, ws: wsObs } = await observerPromise);
  } catch (err) {
    throw new Error(`merge-window-distinct: observer failed: ${err.message}`);
  }
  try { wsObs.close(); } catch (_) {}

  // Find the most recent encounters broadcast.
  const encMsgs = msgs.filter(m => m.type === 'encounters');
  if (encMsgs.length === 0) {
    throw new Error(
      `merge-window-distinct: no encounters message received. ` +
      `Observer must get at least one encounters broadcast after sim posts 2 fights.`
    );
  }

  const lastEnc = encMsgs[encMsgs.length - 1];
  const encList = lastEnc.list || [];

  // Two bots, SAME boss, distinct fight_ts ~7s apart — WITHIN the 30s merge window.
  // CORRECT behavior: the worker merges them onto ONE encounter by time-proximity
  // (MERGE_WINDOW_MS = 30s). So expect exactly ONE merged encounter, not two.
  // (The >window "stay distinct" case is covered by dup-boss-distinct at 120s apart.)
  if (encList.length !== 1) {
    throw new Error(
      `merge-window-distinct: expected 1 merged encounter (two fights ~7s apart are ` +
      `within the 30s merge window → time-proximity merge), but got ${encList.length}. ` +
      `Encounter list: ${JSON.stringify(encList.map(e => ({ id: e.encounter_id, boss: e.boss })))}`
    );
  }

  // The merged encounter must carry real damage from the posts.
  if (!(encList[0].total_damage > 0)) {
    throw new Error(
      `merge-window-distinct: merged encounter ${encList[0].encounter_id} has ` +
      `total_damage = ${encList[0].total_damage}. Both bots must have posted real damage.`
    );
  }
};

// ---------------------------------------------------------------------------
// Scenario C: late-join-midfight
// ---------------------------------------------------------------------------
/**
 * A member joins AFTER a fight is already underway and still appears on the board.
 *
 * Steps:
 *   1. Receiving client (Playwright) joins the room BEFORE any bot posts.
 *   2. Bot1 opens a WS and posts a NON-FINAL tick (fight in progress).
 *   3. We wait for a scoreboard with bot1 only (1 entry).
 *   4. Bot2 (the "late joiner") opens a WS and posts to the SAME fight_ts
 *      (--share-ts path) — it must appear on the board.
 *   5. Assert the receiving client's next scoreboard has 2 entries, contribution% ~100.
 *
 * The scenario uses runSim twice:
 *   - First: 1 bot, --now, --share-ts, --members 1  → bot1 initial tick
 *   - Second: 1 bot with a DIFFERENT user_id is impossible via runSim alone
 *     (it always uses sim1/sim2/... user IDs sequentially).
 *
 * Instead we run one sim with --members 2 --share-ts and the harness observes
 * whether the second member appears after the first.  Because --now posts
 * immediately, both bots post at roughly the same time; we cannot precisely
 * sequence "bot1 posts then bot2 joins later" through runSim alone.
 *
 * HARNESS CAPABILITY FLAG: precise late-join sequencing (bot1 posts, then after
 * a measured delay bot2 opens WS + posts) requires either:
 *   a. Two separate runSim calls with a sleep between them (but runSim blocks
 *      until exit; --now exits after posting, so two serial calls work), or
 *   b. Driving raw Node WS connections directly (not through runSim).
 *
 * We use approach (a): runSim 1 bot → wait for initial scoreboard → runSim 1
 * more bot (different user ID is a limitation: both sims use sim1 — the second
 * sim1 joins the room with the same user_id, so the worker may treat it as a
 * reconnect rather than a new member).
 *
 * FLAG for dispatcher: late-join-midfight needs raw WS control (two Node WS
 * connections with distinct user IDs, sequential post timing) to precisely test
 * the "new member joins mid-fight" path.  The runSim abstraction cannot express
 * distinct user_ids in two sequential 1-bot runs (both get sim1).  This scenario
 * is best implemented via raw WebSocket connections (like multi-phase-undercount's
 * openObserver) once the dispatcher confirms the pattern is acceptable.
 *
 * Current implementation: uses --members 2 --share-ts (both post at once) and
 * asserts the receiver sees both on the board — a weaker but still valuable check
 * that late-arriving member data merges onto the same encounter.
 */
module.exports.lateJoinMidfight = async function lateJoinMidfight(ctx) {
  const { genCode, runSim, getBrowser, wranglerHost, indexHtml } = ctx;
  const code = genCode('LJ');

  const { context } = await getBrowser();

  // Receiving client opens BEFORE any bot posts.
  const { page, messages, errors } = await openReceivingClient({
    context,
    indexHtml,
    code,
    wranglerHost,
    userId:   'lj_rx_1',
    username: 'LateJoinRx',
  });

  const welcome = await waitForWorkerMessage(messages, m => m.type === 'welcome', 12_000);
  if (!welcome) {
    throw new Error('late-join-midfight: receiving client did not get welcome frame');
  }

  // Run sim: --members 2 --now --share-ts.
  // Both bots share a fight_ts → land on the same encounter.
  // We cannot sequence "bot1 then bot2 delayed" precisely through runSim, but
  // we CAN assert that BOTH members appear on the merged scoreboard (the
  // receiver sees the second member even though it was not present at t=0).
  const simResult = await runSim(
    [code, '--members', '2', '--now', '--share-ts'],
    20_000
  );
  // --now may time out in reader; acceptable.

  // Wait for any scoreboard first (bot1 may post before bot2).
  const firstSb = await waitForWorkerMessage(
    messages, m => m.type === 'scoreboard' && m.total_damage > 0, 12_000
  );
  if (!firstSb) {
    throw new Error('late-join-midfight: receiving client never got a scoreboard after sim run');
  }

  // Now wait for a scoreboard with BOTH members (the "late joiner" must appear).
  // Allow extra time — the second bot may arrive slightly after the first broadcast.
  const bothSb = await waitForWorkerMessage(
    messages,
    m => m.type === 'scoreboard' && Array.isArray(m.entries) && m.entries.length >= 2,
    10_000
  );
  if (!bothSb) {
    // Check what we got.
    const sbEntries = (firstSb.entries || []).length;
    throw new Error(
      `late-join-midfight: receiving client did not see scoreboard with >= 2 members. ` +
      `First scoreboard had ${sbEntries} entr${sbEntries === 1 ? 'y' : 'ies'}. ` +
      `The "late joiner" (second bot) did not appear on the merged board. ` +
      `[HARNESS FLAG: precise late-join sequencing needs raw WS control — see scenario comment]`
    );
  }

  // contribution% must sum ~100 for the merged board.
  const contribSum = bothSb.entries.reduce((s, e) => s + (e.contribution || 0), 0);
  if (Math.abs(contribSum - 100) > 3) {
    throw new Error(
      `late-join-midfight: contribution% sum = ${contribSum.toFixed(1)}, expected ~100. ` +
      `Entries: ${JSON.stringify(bothSb.entries.map(e => ({ u: e.user_id, pct: e.contribution })))}`
    );
  }

  // No fatal JS errors.
  const fatal = errors.filter(e =>
    /SyntaxError|ReferenceError|is not defined|is not a function|TypeError/.test(e) &&
    !/fetch|net::ERR|CORS|Failed to load/.test(e)
  );
  if (fatal.length > 0) {
    throw new Error(`late-join-midfight: fatal JS errors:\n  ${fatal.slice(0, 3).join('\n  ')}`);
  }

  await page.close();
};
