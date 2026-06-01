// Capture pass for the batch-1+2 party UI in the REAL screens (mocked sockets):
//   - Trophies tab (#12)
//   - #14 logging: own-client "logging OFF" banner + per-member "not logging" roster badge
//   - in-app confirm modal (the encounter-edit / party dead-button fix)
// Saves PNGs to shots/ for visual review.  Run: npx playwright test capture-party-ui.spec.js
const { test } = require('@playwright/test');
const { openApp } = require('./harness');
const path = require('path');
const SHOTS = path.join(__dirname, 'shots');
const EID = '1780270000000';

function welcomeFrame() {
  const e = (uid, name, rank, contrib, dmg, dps, crit, heavy, ch) =>
    ({ user_id: uid, username: name, rank, contribution: contrib, total_damage: dmg, dps,
       crit_rate: crit, heavy_rate: heavy, crit_heavy_rate: ch, crit_heavy_count: Math.round(dmg/20000),
       has_detail: true });
  return {
    type: 'welcome', you: { is_leader: true, user_id: 'user_test_1' },
    active_encounter_id: EID,
    roster: [
      { user_id: 'user_test_1', username: 'TestUser', is_leader: true, online: true, has_posted: true, joined_age_s: 200 },
      { user_id: 'bot_2', username: 'Vareth', is_leader: false, online: true, has_posted: false, joined_age_s: 140 }, // -> "not logging"
      { user_id: 'bot_3', username: 'Synapse', is_leader: false, online: true, has_posted: false, joined_age_s: 20 }, // -> "joining…"
    ],
    scoreboard: {
      encounter_id: EID, boss: 'Tevent', boss_category: 'archboss', total_damage: 1000000,
      entries: [
        e('user_test_1', 'TestUser', 1, 45.0, 450000, 7500, 42, 38, 19.5),
        e('bot_2', 'Vareth', 2, 33.0, 330000, 5500, 35, 30, 14.0),
        e('bot_3', 'Synapse', 3, 22.0, 220000, 3666, 28, 22, 9.0),
      ],
    },
    encounters: [{ encounter_id: EID, boss: 'Tevent', boss_category: 'archboss', total_damage: 1000000, entries_n: 3 }],
  };
}
function memberDetail(uid, mult) {
  const rot = []; const skills = ['Brutal Incision', 'Slaughtering Slash', 'Camouflage Cleave'];
  for (let i = 0; i < 80; i++) rot.push({ relative_time: +(i * 0.7).toFixed(2), skill: skills[i % 3],
    damage: Math.round((2500 + (i % 9) * 1200) * mult), is_crit: i % 3 === 0, is_heavy: i % 4 === 0 });
  return { type: 'member_detail', encounter_id: EID, user_id: uid, skills: null, rotation: rot };
}

async function landInParty(page) {
  await openApp(page);
  await page.evaluate(() => {
    partyState.user_id = 'user_test_1'; partyState.username = 'TestUser';
    partyState.party_code = 'TEST'; partyState.connected = true;
    connectPartyWS('TEST', true);
  });
  await page.waitForFunction(() => window.__mock.counts().worker > 0, null, { timeout: 10_000 });
  await page.evaluate((f) => window.__mock.pushWorker(f), welcomeFrame());
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('.tab')].find(x => /party/i.test(x.textContent));
    if (b) b.click();
  });
  await page.waitForTimeout(400);
}

test('capture party UI: roster badge + banner, trophies, modal', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await landInParty(page);

  // explicit roster frame (worker shape) so renderPartyMembers shows the transmit badges
  await page.evaluate(() => window.__mock.pushWorker({ type: 'roster', members: [
    { user_id: 'user_test_1', username: 'TestUser', is_leader: true, online: true, has_posted: true, joined_age_s: 200 },
    { user_id: 'bot_2', username: 'Vareth', is_leader: false, online: true, has_posted: false, joined_age_s: 140 },
    { user_id: 'bot_3', username: 'Synapse', is_leader: false, online: true, has_posted: false, joined_age_s: 20 },
  ]}));
  await page.waitForTimeout(300);

  // (1) roster badge ("not logging" / "joining…") + own-client logging banner (no log file -> OFF)
  await page.screenshot({ path: path.join(SHOTS, 'b2-roster-banner.png'), fullPage: true });
  const roster = page.locator('#partyMembersList');
  if (await roster.count()) await roster.screenshot({ path: path.join(SHOTS, 'b2-roster-crop.png') });
  const rosterText = await page.evaluate(() => {
    const el = document.getElementById('partyMembersList'); return el ? el.innerText : '(none)';
  });
  console.log('[roster text]\n' + rosterText);
  console.log('[roster] has "not logging":', /not logging/i.test(rosterText), '| has "joining":', /joining/i.test(rosterText));

  // (2) Trophies tab — feed member detail for all three so trophies have data
  await page.evaluate((f) => window.__mock.pushWorker(f), memberDetail('user_test_1', 1.6));
  await page.evaluate((f) => window.__mock.pushWorker(f), memberDetail('bot_2', 1.1));
  await page.evaluate((f) => window.__mock.pushWorker(f), memberDetail('bot_3', 0.8));
  await page.waitForTimeout(200);
  await page.evaluate(() => { if (window.switchPartyTab) switchPartyTab('trophies'); });
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(SHOTS, 'b2-trophies.png'), fullPage: true });
  const trophiesText = await page.evaluate(() => {
    const el = document.querySelector('#partyResultsContainer'); return el ? el.innerText.slice(0, 600) : '(no container)';
  });
  console.log('[trophies tab text]\n' + trophiesText);

  // (3) in-app confirm modal (dead-button fix) — fire partyConfirm and capture the overlay
  await page.evaluate(() => { if (window.switchPartyTab) switchPartyTab('scoreboard'); });
  await page.waitForTimeout(200);
  await page.evaluate(() => { if (window.partyConfirm) window.partyConfirm('Kick Vareth from the party?'); });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(SHOTS, 'b2-modal.png'), fullPage: true });
  const modalSeen = await page.evaluate(() => {
    const t = document.body.innerText || ''; return /Kick Vareth/.test(t);
  });
  console.log('[modal] partyConfirm overlay text present:', modalSeen);
});
