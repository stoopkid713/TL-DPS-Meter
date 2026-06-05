// VIDEO capture for marketing/promo clips — drives the REAL index.html (mocked sockets), NO
// game / backend / worker. Playwright records each test to test-results/<test>/video.webm at the
// test's VIEWPORT size. LANDSCAPE only (vertical dropped — the raw app compresses at phone width).
//
// FAITHFUL "post-combat" model (Kyle, 2026-06-02): the board is basically STATIC during combat and
// the ranked result FILLS IN on combat-exit (TL flushes the log late/bursty). So scene 3 shows the
// app's real in-combat "Recording…" state, then the post-combat REVEAL — NOT a fake live bar-race.
// The logging-OFF banner is suppressed (mock has no real log file) so footage is clean.
//
//   Run:    npx playwright test capture-video-tour.spec.js
//   Watch:  npx playwright test capture-video-tour.spec.js --headed
//   Videos -> test-results/**/video.webm (gitignored); stills -> shots/ .
const { test } = require('@playwright/test');
const { openApp } = require('./harness');
const path = require('path');
const SHOTS = path.join(__dirname, 'shots');

// Record video at full 1280x720 (Playwright's default caps at 800x450 — too soft for promo).
test.use({ video: { mode: 'on', size: { width: 1280, height: 720 } } });

const EID = '1780300000000';        // Velentra
const EID2 = '1780300450000';       // Nerzatum (2nd boss, for the switcher)
const CODE = 'XZFH';
const ELAPSED = 82;                 // simulated fight length (s) for dps display

// Post-combat RESULT for boss #1 (Velentra). You (OhStoopKid) top the board.
const RESULT = [
  { user_id: 'user_test_1', username: 'OhStoopKid', dmg: 7782000, crit: 44, heavy: 36 },
  { user_id: 'bot_2',       username: 'Sylvara',    dmg: 6410000, crit: 39, heavy: 33 },
  { user_id: 'bot_3',       username: 'Draelynn',   dmg: 5120000, crit: 41, heavy: 30 },
  { user_id: 'bot_4',       username: 'Kaesong',    dmg: 4160000, crit: 35, heavy: 28 },
];
const RESULT2 = [ // Nerzatum — slightly different mix
  { user_id: 'bot_2',       username: 'Sylvara',    dmg: 5980000, crit: 40, heavy: 34 },
  { user_id: 'user_test_1', username: 'OhStoopKid', dmg: 5410000, crit: 43, heavy: 35 },
  { user_id: 'bot_3',       username: 'Draelynn',   dmg: 4720000, crit: 38, heavy: 31 },
  { user_id: 'bot_4',       username: 'Kaesong',    dmg: 3010000, crit: 34, heavy: 27 },
];

function rosterFrom(rows) {
  return rows.map((m, i) => ({ user_id: m.user_id, username: m.username,
    is_leader: m.user_id === 'user_test_1', online: true, has_posted: true, joined_age_s: 220 + i }));
}
function scoreboard(rows, eid, boss, cat) {
  const total = rows.reduce((a, b) => a + b.dmg, 0) || 1;
  const entries = rows.map((m) => ({
    user_id: m.user_id, username: m.username, total_damage: m.dmg,
    dps: Math.round(m.dmg / ELAPSED), contribution: +(100 * m.dmg / total).toFixed(1),
    crit_rate: m.crit, heavy_rate: m.heavy, crit_heavy_rate: +(m.crit * m.heavy / 100).toFixed(1),
    crit_heavy_count: Math.round(m.dmg / 22000), has_detail: true,
  }));
  entries.sort((a, b) => b.total_damage - a.total_damage);
  entries.forEach((e, i) => (e.rank = i + 1));
  return { type: 'scoreboard', encounter_id: eid, boss, boss_category: cat || 'archboss',
           total_damage: total, entries };
}
function welcome(sb) {
  return { type: 'welcome', you: { is_leader: true, user_id: 'user_test_1' },
    active_encounter_id: EID, roster: rosterFrom(RESULT), scoreboard: sb,
    encounters: [{ encounter_id: EID, boss: 'Velentra', boss_category: 'archboss',
                   total_damage: (sb && sb.total_damage) || 0, entries_n: RESULT.length }] };
}
function memberDetail(uid, mult) {
  const skills = ['Brutal Incision', 'Slaughtering Slash', 'Camouflage Cleave', 'Shadow Strike'];
  const rot = [];
  for (let i = 0; i < 90; i++) rot.push({ relative_time: +(i * 0.85).toFixed(2),
    skill: skills[i % skills.length], damage: Math.round((3000 + (i % 11) * 1400) * mult),
    is_crit: i % 3 === 0, is_heavy: i % 4 === 0 });
  return { type: 'member_detail', encounter_id: EID, user_id: uid, skills: null, rotation: rot };
}

// Open the app clean (banner-safe), seeded identity.
async function openClean(page, w = 1280, h = 720) {
  await page.setViewportSize({ width: w, height: h });
  await openApp(page, { username: 'OhStoopKid', userId: 'user_test_1' });
}
// Connect the (mock) worker socket as leader.
async function connect(page) {
  await page.evaluate((code) => {
    partyState.user_id = 'user_test_1'; partyState.username = 'OhStoopKid';
    partyState.party_code = code; partyState.connected = true; partyState.is_leader = true;
    connectPartyWS(code, true);
  }, CODE);
  await page.waitForFunction(() => window.__mock.counts().worker > 0, null, { timeout: 10_000 });
}
// Make the app believe combat logging is healthy + force-hide the banner (clean footage).
async function suppressBanner(page) {
  await page.evaluate(() => {
    // New #14 state machine: 'ok' (banner hidden) needs lastLogFile set AND recent combat
    // (lastCombatAgeS <= COMBAT_STALE_S). lastLogActivity was removed in the rewrite.
    try { lastLogFile = 'C:/Games/TL/combat.log'; } catch (e) {}
    try { lastCombatAgeS = 0; } catch (e) {}
    if (typeof renderLogStatusBanner === 'function') renderLogStatusBanner();
    const b = document.getElementById('partyLogStatusBanner'); if (b) b.style.display = 'none';
  });
}
async function goPartyTab(page) {
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('.tab')].find((x) => /party/i.test(x.textContent));
    if (b) b.click();
  });
}
const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, `video-${name}.png`) });

// ── Scene 1 — BOOT: app launches, lands on the Dashboard ───────────────────────────────────
test('scene1 boot — app launches to dashboard', async ({ page }) => {
  test.setTimeout(60_000);
  await openClean(page);
  await page.waitForTimeout(4500);
  await shot(page, 'scene1-boot');
});

// ── Scene 2 — JOIN: setup cards → type code → roster fills ──────────────────────────────────
test('scene2 join — enter code, roster fills', async ({ page }) => {
  test.setTimeout(60_000);
  await openClean(page);
  await goPartyTab(page);
  await page.waitForTimeout(1600); // setup view (Create / Join cards)
  const input = page.locator('#partyJoinCodeInput');
  if (await input.count()) { await input.click(); await input.fill(CODE); }
  await page.waitForTimeout(1200);
  await connect(page);
  // joined mid-combat: armed + recording, board not yet filled (clean "Recording…" state)
  await page.evaluate((f) => window.__mock.pushWorker(f), welcome(scoreboard([], EID, 'Velentra')));
  await suppressBanner(page);
  await page.evaluate((eid) => { partyState.encounter_active = true;
    partyState.active_encounter_id = eid; partyState.viewing_encounter_id = eid;
    if (typeof updatePartyUI === 'function') updatePartyUI();
    if (typeof renderPartyMembers === 'function') renderPartyMembers();
    if (typeof renderPartyResults === 'function') renderPartyResults(); }, EID);
  await page.waitForTimeout(3200); // active view + roster
  await shot(page, 'scene2-join');
});

// ── Scene 3 — REVEAL (the money shot): in-combat "Recording…" → post-combat board fills ─────
test('scene3 reveal — in-combat then post-combat board fills', async ({ page }) => {
  test.setTimeout(90_000);
  await openClean(page);
  await connect(page);
  await page.evaluate((f) => window.__mock.pushWorker(f), welcome(scoreboard([], EID, 'Velentra')));
  await goPartyTab(page);
  await suppressBanner(page);
  await page.evaluate((eid) => { partyState.encounter_active = true;
    partyState.active_encounter_id = eid; partyState.viewing_encounter_id = eid;
    if (typeof updatePartyUI === 'function') updatePartyUI();
    if (typeof renderPartyResults === 'function') renderPartyResults(); }, EID);
  await page.waitForTimeout(4800); // honest in-combat "Recording…" hold
  await shot(page, 'scene3a-recording');
  // combat exits → the room broadcasts the ranked board; it fills in one go
  await page.evaluate((f) => window.__mock.pushWorker(f), scoreboard(RESULT, EID, 'Velentra'));
  await page.evaluate(() => { partyState.encounter_active = false;
    if (typeof updatePartyUI === 'function') updatePartyUI(); });
  await page.waitForTimeout(5200); // post-combat reveal hold
  await shot(page, 'scene3b-reveal');
});

// ── Scene 4 — DRILL-DOWN: click a member → skill table + rotation ───────────────────────────
test('scene4 drilldown — member skill breakdown', async ({ page }) => {
  test.setTimeout(60_000);
  await openClean(page);
  await connect(page);
  await page.evaluate((f) => window.__mock.pushWorker(f), welcome(scoreboard(RESULT, EID, 'Velentra')));
  await goPartyTab(page);
  await suppressBanner(page);
  await page.evaluate((eid) => { partyState.viewing_encounter_id = eid;
    if (typeof renderPartyResults === 'function') renderPartyResults(); }, EID);
  await page.waitForTimeout(2600);
  await page.evaluate((f) => window.__mock.pushWorker(f), memberDetail('user_test_1', 1.5));
  await page.evaluate((eid) => { if (typeof openPartyMemberDetail === 'function')
    openPartyMemberDetail(eid, 'user_test_1'); }, EID);
  await page.waitForTimeout(4200);
  await shot(page, 'scene4-drilldown');
});

// ── Scene 5 — COMPARE: two members head-to-head ─────────────────────────────────────────────
test('scene5 compare — A/B two members', async ({ page }) => {
  test.setTimeout(60_000);
  await openClean(page);
  await connect(page);
  await page.evaluate((f) => window.__mock.pushWorker(f), welcome(scoreboard(RESULT, EID, 'Velentra')));
  await goPartyTab(page);
  await suppressBanner(page);
  await page.evaluate((f) => window.__mock.pushWorker(f), memberDetail('user_test_1', 1.5));
  await page.evaluate((f) => window.__mock.pushWorker(f), memberDetail('bot_2', 1.2));
  await page.waitForTimeout(800);
  await page.evaluate(() => { if (typeof switchPartyTab === 'function') switchPartyTab('compare'); });
  await page.waitForTimeout(3800);
  await shot(page, 'scene5-compare');
});

// ── Scene 6 — TROPHIES: party superlatives ──────────────────────────────────────────────────
test('scene6 trophies — party superlatives', async ({ page }) => {
  test.setTimeout(60_000);
  await openClean(page);
  await connect(page);
  await page.evaluate((f) => window.__mock.pushWorker(f), welcome(scoreboard(RESULT, EID, 'Velentra')));
  await goPartyTab(page);
  await suppressBanner(page);
  await page.evaluate((f) => window.__mock.pushWorker(f), memberDetail('user_test_1', 1.6));
  await page.evaluate((f) => window.__mock.pushWorker(f), memberDetail('bot_2', 1.2));
  await page.evaluate((f) => window.__mock.pushWorker(f), memberDetail('bot_3', 0.9));
  await page.evaluate((f) => window.__mock.pushWorker(f), memberDetail('bot_4', 0.7));
  await page.waitForTimeout(800);
  await page.evaluate(() => { if (typeof switchPartyTab === 'function') switchPartyTab('trophies'); });
  await page.waitForTimeout(3800);
  await shot(page, 'scene6-trophies');
});

// ── Scene 7 — SWITCHER: step between two boss encounters ────────────────────────────────────
test('scene7 switcher — step between bosses', async ({ page }) => {
  test.setTimeout(60_000);
  await openClean(page);
  await connect(page);
  await page.evaluate((f) => window.__mock.pushWorker(f), welcome(scoreboard(RESULT, EID, 'Velentra')));
  await goPartyTab(page);
  await suppressBanner(page);
  // add a 2nd boss + enumerate both
  await page.evaluate((f) => window.__mock.pushWorker(f), scoreboard(RESULT2, EID2, 'Nerzatum'));
  await page.evaluate(([e1, e2]) => window.__mock.pushWorker({ type: 'encounters', active_id: e2,
    list: [ { encounter_id: e2, boss: 'Nerzatum', boss_category: 'archboss', total_damage: 19120000, entries_n: 4 },
             { encounter_id: e1, boss: 'Velentra', boss_category: 'archboss', total_damage: 23472000, entries_n: 4 } ] }), [EID, EID2]);
  await page.waitForTimeout(2400); // viewing Nerzatum (active)
  await shot(page, 'scene7a-boss2');
  // step back to Velentra
  await page.evaluate((eid) => { partyState.viewing_encounter_id = eid;
    if (typeof renderEncounterSwitcher === 'function') renderEncounterSwitcher();
    if (typeof renderPartyResults === 'function') renderPartyResults(); }, EID);
  await page.waitForTimeout(2800);
  await shot(page, 'scene7b-boss1');
});
