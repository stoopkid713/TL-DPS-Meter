'use strict';
/**
 * S1.3 Scenario 2: lifecycle-create-join-leave
 * runtime: browser | tags: smoke, lifecycle
 *
 * Tests the full create → join → leave lifecycle using:
 *   - sim_party.py bots (the SENDER/leader side)
 *   - receiving-client harness (the RECEIVER side, non-leader member)
 *
 * Both-sides coverage: the sim bot creates the room and posts; the receiving
 * client joins as a member and receives the roster + scoreboard broadcasts.
 *
 * Steps:
 *   1. sim_party --scenario crit-heavy-parity --dry-run (smoke: parity math is correct)
 *   2. Two sim bots join code via real WS, post a fight (--now mode), then leave
 *   3. Receiving-client (Playwright page) joins the same code, asserts:
 *      a. welcome frame received (roster has >= 1 member or the sim bots)
 *      b. scoreboard arrives (total_damage > 0)
 *      c. no crash after sims disconnect (leave sends ws.close)
 *
 * The worker's both-sides: bots = sender; Playwright page = receiver (the gap that burned us).
 */

const { openReceivingClient, waitForWorkerMessage } = require('../receiving-client');

module.exports = async function lifecycleBasic(ctx) {
  const { code, runSim, getBrowser, wranglerHost, indexHtml } = ctx;

  // Step 1: Parity smoke (pure Python, no WS — very fast).
  const parityResult = await runSim(
    ['--scenario', 'crit-heavy-parity', '--dry-run'],
    8_000
  );
  if (parityResult.code !== 0) {
    throw new Error(
      `crit-heavy-parity --dry-run failed (code=${parityResult.code}):\n${parityResult.stderr.slice(0, 400)}`
    );
  }
  const parityOut = parityResult.stdout;
  if (!/PASS/i.test(parityOut)) {
    throw new Error(`crit-heavy-parity: expected PASS in output, got:\n${parityOut.slice(0, 400)}`);
  }

  // Step 2: Open the receiving client FIRST (so it's listening when bots arrive).
  const { context } = await getBrowser();
  const { page, messages, errors } = await openReceivingClient({
    context,
    indexHtml,
    code,
    wranglerHost,
    userId: 'lifecycle_rx_1',
    username: 'RxUser',
  });

  // Step 3: Wait for the welcome frame (proves the real WS connected to wrangler dev).
  const welcome = await waitForWorkerMessage(messages, m => m.type === 'welcome', 12_000);
  if (!welcome) {
    throw new Error('Receiving client never got welcome frame from wrangler dev (WS not connecting?)');
  }

  // Step 4: Run sim bots against the same code (--now mode = post immediately, 2 bots).
  // We use --share-ts so both bots land on the same encounter (positive path for lifecycle test).
  const simResult = await runSim(
    [code, '--members', '2', '--now', '--share-ts'],
    18_000
  );
  // sim --now exits after first post; code 0 = connected + sent
  if (simResult.code !== 0 && !simResult.timedOut) {
    // timedOut is acceptable: --now mode hangs waiting for the room (reader loop);
    // the posts still went through. We check the scoreboard instead.
    throw new Error(
      `sim_party --now exited unexpectedly (code=${simResult.code}):\n${simResult.stderr.slice(0, 400)}`
    );
  }

  // Step 5: Receiving client should now have a scoreboard broadcast.
  const scoreboard = await waitForWorkerMessage(messages, m => m.type === 'scoreboard', 10_000);
  if (!scoreboard) {
    throw new Error('Receiving client never got scoreboard broadcast after sim bots posted');
  }
  if (!scoreboard.total_damage || scoreboard.total_damage <= 0) {
    throw new Error(`Scoreboard total_damage is ${scoreboard.total_damage}, expected > 0`);
  }
  if (!Array.isArray(scoreboard.entries) || scoreboard.entries.length === 0) {
    throw new Error('Scoreboard entries is empty');
  }

  // Step 6: Contribution% check — entries should sum ~100%.
  const contribSum = scoreboard.entries.reduce((s, e) => s + (e.contribution || 0), 0);
  if (Math.abs(contribSum - 100) > 2) {
    throw new Error(`Contribution% sum is ${contribSum.toFixed(1)}, expected ~100`);
  }

  // Step 7: No fatal JS errors on the receiving client.
  const fatal = errors.filter(e =>
    /SyntaxError|ReferenceError|is not defined|is not a function|TypeError/.test(e) &&
    !/fetch|net::ERR|CORS|Failed to load/.test(e)
  );
  if (fatal.length > 0) {
    throw new Error(`Receiving client fatal JS errors:\n  ${fatal.slice(0, 3).join('\n  ')}`);
  }

  await page.close();
};
