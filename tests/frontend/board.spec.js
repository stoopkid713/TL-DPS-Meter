// Scenario: feed the screens a worker 'welcome' (roster + scoreboard) and assert the REAL
// party board renders the ranked members — the front-to-back proof for the frontend.
// Also probes drill-down clickability (currently gated on has_detail — documents the state
// the screen-fix lane will change).
const { test, expect } = require('@playwright/test');
const { openApp } = require('./harness');

const EID = '1780270000000';
function entry(uid, name, rank, contrib, dmg, dps, crit, heavy, hasDetail) {
  return { user_id: uid, username: name, rank, contribution: contrib,
           total_damage: dmg, dps, crit_rate: crit, heavy_rate: heavy, has_detail: hasDetail };
}
function welcomeFrame() {
  return {
    type: 'welcome',
    you: { is_leader: true, user_id: 'user_test_1' },
    roster: [
      { user_id: 'user_test_1', username: 'TestUser', is_leader: true, online: true },
      { user_id: 'bot_2', username: 'Vareth', is_leader: false, online: true },
      { user_id: 'bot_3', username: 'Synapse', is_leader: false, online: true },
    ],
    active_encounter_id: EID,
    scoreboard: {
      encounter_id: EID, boss: 'Tevent', boss_category: 'archboss', total_damage: 1000000,
      entries: [
        entry('user_test_1', 'TestUser', 1, 45.0, 450000, 7500, 42, 38, true),
        entry('bot_2', 'Vareth', 2, 33.0, 330000, 5500, 35, 30, true),
        entry('bot_3', 'Synapse', 3, 22.0, 220000, 3666, 28, 22, true),
      ],
    },
    encounters: [{ encounter_id: EID, boss: 'Tevent', boss_category: 'archboss', total_damage: 1000000, entries_n: 3 }],
  };
}

test('party board renders ranked members from a fed worker scoreboard', async ({ page }) => {
  await openApp(page);

  // Land in a joined party: seed identity + state, open the worker socket (mock intercepts it).
  await page.evaluate(() => {
    partyState.user_id = 'user_test_1';
    partyState.username = 'TestUser';
    partyState.party_code = 'TEST';
    partyState.connected = true;
    connectPartyWS('TEST', true);
  });
  await page.waitForFunction(() => window.__mock.counts().worker > 0, null, { timeout: 10_000 });

  // Feed the welcome (roster + scoreboard) as the worker would.
  await page.evaluate((f) => window.__mock.pushWorker(f), welcomeFrame());

  // The real renderer should fill the board with 3 ranked rows.
  const rows = page.locator('#partyResultsContainer .party-result-row');
  await expect(rows).toHaveCount(3, { timeout: 7_000 });
  const board = page.locator('#partyResultsContainer');
  await expect(board).toContainText('TestUser');
  await expect(board).toContainText('Vareth');
  await expect(board).toContainText('Tevent');

  // Probe drill-down clickability (documents current behavior for the screen-fix lane).
  const clickable = await page.locator('#partyResultsContainer .party-result-clickable').count();
  console.log(`[harness] drillable rows (has_detail): ${clickable} / 3`);
});
