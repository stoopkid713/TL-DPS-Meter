// PROMO capture pass — landing-page / marketing screenshots of the REAL screens.
// Retina (2x) + realistic Throne & Liberty data (real boss + character names, believable
// numbers) + clean framing. Mocks the two WebSockets (see mock-app.js); no game/backend/worker.
//   Run: npx playwright test capture-promo.spec.js
//   Out: shots/promo/*.png  (full-window heroes + clean panel crops)
const { test } = require('@playwright/test');
const { openApp } = require('./harness');
const path = require('path');
const fs = require('fs');

const SHOTS = path.join(__dirname, 'shots', 'promo');
fs.mkdirSync(SHOTS, { recursive: true });

// Crisp + roomy. 2x device scale => 2880x1800 PNGs (downscale cleanly for the site).
test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });

const EID = '1780270000000';

// A believable 6-person archboss kill. Trophies are crafted so FIVE different members
// each win one (shows the feature rewards different play styles):
//   Most damage      -> Valdris (highest total)
//   Sustained DPS    -> Kaelyn  (dense burst window, see `burst`)
//   Hardest hit      -> Mistral (one huge non-crit/heavy hit)
//   Biggest crit+heavy-> Thorne  (one huge crit+heavy hit)
//   Most crit+heavy  -> Drelgar (highest crit_heavy_count on the board)
const PARTY = [
  // user_id, name, leader, total_damage, contribution%, dps, crit%, heavy%, c+h%, hits, c+h_count, opts
  ['u_valdris', 'Valdris', true,  11_640_000, 24.1, 258_600, 42.4, 38.9, 18.6, 1040, 193, {}],
  ['u_kaelyn',  'Kaelyn',  false, 9_810_000,  20.3, 218_000, 39.1, 35.2, 15.4, 920,  142, { burst: true }],
  ['u_thorne',  'Thorne',  false, 8_390_000,  17.4, 186_400, 36.7, 33.0, 13.1, 860,  113, { critHeavyHit: true }],
  ['u_mistral', 'Mistral', false, 7_120_000,  14.7, 158_200, 34.0, 41.5, 14.9, 710,  106, { hardHit: true }],
  ['u_drelgar', 'Drelgar', false, 6_200_000,  12.9, 137_800, 31.2, 29.8, 24.6, 1180, 290, {}],
  ['u_ashveil', 'Ashveil', false, 5_080_000,  10.6, 112_900, 28.4, 26.1,  8.0, 560,   45, {}],
];
const TOTAL = PARTY.reduce((s, p) => s + p[3], 0);

function entry(p, i) {
  const [uid, name, , dmg, contrib, dps, crit, heavy, ch, hits, chCount] = p;
  return {
    user_id: uid, username: name, rank: i + 1, contribution: contrib,
    total_damage: dmg, dps, hits, crit_rate: crit, heavy_rate: heavy,
    crit_heavy_rate: ch, crit_heavy_count: chCount, has_detail: true,
  };
}

function welcomeFrame() {
  return {
    type: 'welcome',
    you: { is_leader: true, user_id: 'u_valdris' },
    active_encounter_id: EID,
    roster: PARTY.map(([uid, name, leader]) => ({
      user_id: uid, username: name, is_leader: leader, online: true, has_posted: true, joined_age_s: 300,
    })),
    scoreboard: {
      encounter_id: EID, boss: 'Tevent', boss_category: 'archboss', total_damage: TOTAL,
      entries: PARTY.map(entry),
    },
    encounters: [
      { encounter_id: EID, boss: 'Tevent', boss_category: 'archboss', total_damage: TOTAL, entries_n: 6 },
      { encounter_id: '1780269000000', boss: 'Adentus', boss_category: 'boss', total_damage: 31_400_000, entries_n: 6 },
      { encounter_id: '1780268000000', boss: 'Junobote', boss_category: 'boss', total_damage: 27_900_000, entries_n: 6 },
    ],
  };
}

// Realistic dagger/greatsword rotation for the drill-down, with optional signature hits.
function rotationFor(mult, opts = {}) {
  const SKILLS = [
    'Brutal Incision', 'Slaughtering Slash', 'Camouflage Cleave',
    'Shadow Strike', 'Deathblow Harpoon', 'Knockdown Strike',
  ];
  const rot = [];
  for (let i = 0; i < 120; i++) {
    rot.push({
      relative_time: +(i * 0.38).toFixed(2),
      skill: SKILLS[i % SKILLS.length],
      damage: Math.round((42_000 + (i % 11) * 9_500) * mult),
      is_crit: i % 5 < 2,
      is_heavy: i % 3 === 0,
    });
  }
  // dense 10s burst -> wins "highest sustained DPS"
  if (opts.burst) {
    for (let i = 0; i < 36; i++) {
      rot.push({ relative_time: +(5 + i * 0.27).toFixed(2), skill: 'Shadow Strike',
        damage: 135_000, is_crit: true, is_heavy: false });
    }
  }
  // one huge non-crit/heavy hit -> wins "hardest single hit"
  if (opts.hardHit) {
    rot.push({ relative_time: 21.4, skill: 'Deathblow Harpoon', damage: 318_000, is_crit: true, is_heavy: false });
  }
  // one huge crit+heavy hit -> wins "biggest crit+heavy hit"
  if (opts.critHeavyHit) {
    rot.push({ relative_time: 18.7, skill: 'Slaughtering Slash', damage: 295_000, is_crit: true, is_heavy: true });
  }
  rot.sort((a, b) => a.relative_time - b.relative_time);
  return { type: 'member_detail', encounter_id: EID, user_id: opts.uid, skills: null, rotation: rot };
}

async function landInParty(page) {
  await openApp(page, { username: 'Valdris', userId: 'u_valdris' });
  // never show the "logging OFF" warning in promo shots (mock has no real log file)
  await page.addStyleTag({ content: '#partyLogStatusBanner{display:none!important}' });
  await page.evaluate(() => {
    partyState.user_id = 'u_valdris'; partyState.username = 'Valdris';
    partyState.party_code = 'GLYPH'; partyState.connected = true;
    connectPartyWS('GLYPH', true);
  });
  await page.waitForFunction(() => window.__mock.counts().worker > 0, null, { timeout: 10_000 });
  await page.evaluate((f) => window.__mock.pushWorker(f), welcomeFrame());
  // feed every member's detail so drill-down / compare / trophies all have data
  for (const p of PARTY) {
    const [uid, , , dmg, , , , , , , , opts] = p;
    const frame = rotationFor(dmg / 9_000_000, { ...opts, uid });
    await page.evaluate((f) => window.__mock.pushWorker(f), frame);
  }
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('.tab')].find(x => /party/i.test(x.textContent) && x.dataset.tab);
    if (b) b.click();
  });
  await page.waitForTimeout(500);
}

async function panel(page, name) {
  const el = page.locator('#partyResultsContainer');
  if (await el.count()) await el.screenshot({ path: path.join(SHOTS, name) });
}

test('promo captures', async ({ page }) => {
  await landInParty(page);

  // 1) HERO — full window, scoreboard
  await page.evaluate(() => { if (window.switchPartyTab) switchPartyTab('scoreboard'); });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(SHOTS, 'hero-board.png') });
  await panel(page, 'panel-board.png');

  // 2) SKILLS drill-down for the top member
  await page.evaluate(() => {
    const row = document.querySelector('#partyResultsContainer [data-user-id], #partyResultsContainer .pr-row, #partyResultsContainer tr[data-uid]');
    if (row) row.click();
  });
  await page.waitForTimeout(300);
  await page.evaluate(() => { if (window.switchPartyTab) switchPartyTab('skills'); });
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(SHOTS, 'hero-skills.png') });
  await panel(page, 'panel-skills.png');

  // 3) ROTATION timeline
  await page.evaluate(() => { if (window.switchPartyTab) switchPartyTab('rotation'); });
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(SHOTS, 'hero-rotation.png') });
  await panel(page, 'panel-rotation.png');

  // 4) COMPARE two members
  await page.evaluate(() => { if (window.switchPartyTab) switchPartyTab('compare'); });
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(SHOTS, 'hero-compare.png') });
  await panel(page, 'panel-compare.png');

  // 5) TROPHIES
  await page.evaluate(() => { if (window.switchPartyTab) switchPartyTab('trophies'); });
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(SHOTS, 'hero-trophies.png') });
  await panel(page, 'panel-trophies.png');

  const txt = await page.evaluate(() => {
    const el = document.querySelector('#partyResultsContainer'); return el ? el.innerText.slice(0, 500) : '(none)';
  });
  console.log('[promo] final panel text:\n' + txt);
});
