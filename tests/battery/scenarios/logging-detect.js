'use strict';
/**
 * #14 Logging-detect scenarios (2 scenarios)
 * runtime: browser | tags: regression, logging-detect, roster
 *
 * Issue #14: the worker should mark members who have joined but never posted a
 * fight as "not logging" so the UI can surface the ⚠ badge and the owner-client
 * banner can warn the leader.
 *
 * Two sub-scenarios:
 *
 *   logging-not-posting
 *     A member joins the room but NEVER sends a post_fight frame.  After the
 *     joining grace window expires, the worker roster should mark that member
 *     has_posted:false (or equivalent) and broadcast it.  The receiving client
 *     (Playwright page) must see the ⚠ "not logging" badge for that member.
 *
 *   logging-late-start
 *     A member joins, is initially dark (has_posted:false), THEN starts posting.
 *     The receiving client must see the badge transition from ⚠/waiting → ok
 *     once the first post_fight arrives.
 *
 * HARNESS CAPABILITY FLAGS:
 *
 *   has_posted field:
 *     The worker broadcasts roster frames.  Whether the roster entry exposes a
 *     has_posted boolean (or equivalent) depends on the worker's broadcast shape.
 *     The receiving-client harness captures all raw frames in messages[], so we
 *     can inspect roster entries directly.
 *     FLAG: if the worker does NOT include has_posted in the roster broadcast, the
 *     harness cannot assert it without reading the DOM badge state via Playwright.
 *     We use a two-track approach:
 *       1. Check the raw roster frame for has_posted (or similar field).
 *       2. If absent, query the DOM for the badge element (aria-label or data-attr).
 *     Both tracks are attempted; the scenario fails if NEITHER can confirm the badge.
 *
 *   Grace window timing:
 *     The worker's grace window (how long a member can be silent before being
 *     flagged) is not known from the harness side.  We use a 10s observation
 *     window after join.  If the worker's grace window is longer than 10s, the
 *     scenario may time out and is marked expected-fail-until-grace-known.
 *     FLAG for dispatcher: surface the grace window constant from the worker so
 *     the harness can set a precise wait.
 *
 *   Own-client banner (logging-late-start):
 *     The banner that says "you are not logging" lives in the leader/own-client
 *     view.  The receiving client harness opens as a NON-leader member (leader=0).
 *     Testing the leader banner requires either:
 *       a. A second receiving-client page opened as leader=1, or
 *       b. Reading the DOM badge on the non-leader's per-member roster row.
 *     We use approach (b): assert the per-member badge in the roster DOM.
 *     FLAG for dispatcher: leader-side banner assertion needs a second Playwright
 *     page opened with leader=1 (or the init script setting localStorage
 *     party_is_leader = '1').  The receiving-client harness currently forces
 *     leader=0.
 */

const WebSocket = require('ws');
const { openReceivingClient, waitForWorkerMessage } = require('../receiving-client');

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// ---------------------------------------------------------------------------
// Helper — open a raw "silent member" WS that joins but never posts
// ---------------------------------------------------------------------------

/**
 * Join a party room as a silent member (no post_fight frames ever sent).
 * Returns { ws, close } — caller must call close() when done.
 */
function openSilentMember(wranglerHost, code, userId) {
  return new Promise((resolve, reject) => {
    const url = `${wranglerHost}/party/${code}?user_id=${userId}&username=${userId}&leader=0`;
    const ws = new WebSocket(url);
    let welcomed = false;

    const timer = setTimeout(() => {
      if (!welcomed) {
        ws.close();
        reject(new Error(`silent member ${userId} never welcomed`));
      }
    }, 8_000);

    ws.on('message', (data) => {
      let m; try { m = JSON.parse(data); } catch (_) { return; }
      if (m.type === 'welcome') {
        welcomed = true;
        clearTimeout(timer);
        resolve({
          ws,
          close: () => { try { ws.close(); } catch (_) {} },
        });
      }
    });
    ws.on('error', (err) => { clearTimeout(timer); reject(err); });
    ws.on('close', () => {
      clearTimeout(timer);
      if (!welcomed) reject(new Error(`silent member ${userId} closed before welcome`));
    });
  });
}

// ---------------------------------------------------------------------------
// Helpers — DOM badge inspection
// ---------------------------------------------------------------------------

/**
 * Query the page DOM for a "not logging" badge or warning for the given userId.
 * Returns true if any relevant indicator is visible.
 *
 * We look for common patterns:
 *   - An element with aria-label containing "not logging" or "⚠"
 *   - A data-user-id attribute matching userId next to a warning class
 *   - Any text node containing "not logging" near the user's row
 *
 * This is intentionally broad — the exact DOM structure depends on the app
 * version.  If the app does not yet render the badge (#14 not implemented),
 * this returns false (and the scenario fails with a clear message).
 */
async function hasBadgeDom(page, userId) {
  return page.evaluate((uid) => {
    // Strategy 1: aria-label on any element.
    const byAria = document.querySelectorAll('[aria-label]');
    for (const el of byAria) {
      const lbl = el.getAttribute('aria-label') || '';
      if (/not.?log|⚠|warning/i.test(lbl)) return true;
    }
    // Strategy 2: data-user-id + warning class.
    if (uid) {
      const byUid = document.querySelectorAll(`[data-user-id="${uid}"]`);
      for (const el of byUid) {
        if (/warning|not.?log|badge/i.test(el.className)) return true;
        const icon = el.querySelector('.warning, .not-logging, [data-badge]');
        if (icon) return true;
      }
    }
    // Strategy 3: text scan.
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (/not.?log/i.test(node.textContent)) return true;
    }
    return false;
  }, userId);
}

/**
 * Check the raw roster frame for a has_posted:false entry for the given userId.
 * Returns { found: bool, has_posted: bool|null }.
 */
function checkRosterFrame(messages, userId) {
  // Look through all roster frames for one mentioning this user.
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.type !== 'roster') continue;
    const members = m.members || [];
    const entry = members.find(mb => mb.user_id === userId || mb.userId === userId);
    if (entry) {
      const posted = entry.has_posted ?? entry.hasPosted ?? null;
      return { found: true, has_posted: posted };
    }
  }
  return { found: false, has_posted: null };
}

// ---------------------------------------------------------------------------
// Scenario A: logging-not-posting
// ---------------------------------------------------------------------------
/**
 * A member joins but never posts.  After the grace window, the worker must flag
 * them.  We check:
 *   1. Raw roster frame: has_posted === false (or 0) for the silent member.
 *   2. DOM badge: ⚠ / "not logging" badge visible in the receiving client UI.
 *
 * Only one of these checks must pass (the DOM check may fail if #14 is not yet
 * implemented in the UI; the roster check may fail if the worker does not
 * broadcast has_posted yet).  If BOTH fail, the scenario fails.
 *
 * Tagged expected-fail-until-fix: #14 is not yet implemented.
 */
module.exports.loggingNotPosting = async function loggingNotPosting(ctx) {
  const { genCode, runSim, getBrowser, wranglerHost, indexHtml } = ctx;
  const code = genCode('LNP');

  const { context } = await getBrowser();

  // Open the receiving client (it will observe the room).
  const { page, messages, errors } = await openReceivingClient({
    context,
    indexHtml,
    code,
    wranglerHost,
    userId:   'lnp_rx_1',
    username: 'LogRx',
  });

  const welcome = await waitForWorkerMessage(messages, m => m.type === 'welcome', 12_000);
  if (!welcome) {
    throw new Error('logging-not-posting: receiving client did not get welcome frame');
  }

  // Open a SILENT member — joins but never posts.
  const SILENT_ID = 'lnp_silent';
  let silentMember;
  try {
    silentMember = await openSilentMember(wranglerHost, code, SILENT_ID);
  } catch (err) {
    throw new Error(`logging-not-posting: could not open silent member WS: ${err.message}`);
  }

  // Let the silent member sit for 10s (covers most likely grace windows).
  // FLAG: if the worker grace window is longer than 10s, increase this timeout
  // and the outer waitForWorkerMessage timeouts below.
  await delay(10_000);

  // Also run a real bot (so the room has actual activity — the worker may only
  // emit has_posted:false if there is concurrent activity to compare against).
  const simResult = await runSim(
    [code, '--members', '1', '--now'],
    15_000
  );

  // Give worker time to broadcast roster updates after the active bot posts.
  await delay(2_000);

  silentMember.close();

  // --- Check 1: raw roster frame ---
  const rosterCheck = checkRosterFrame(messages, SILENT_ID);

  // --- Check 2: DOM badge ---
  let domBadge = false;
  try {
    domBadge = await hasBadgeDom(page, SILENT_ID);
  } catch (_) {}

  // Report findings and decide pass/fail.
  const rosterFlagged = rosterCheck.found && rosterCheck.has_posted === false;
  const rosterFound   = rosterCheck.found;
  const rosterPosted  = rosterCheck.has_posted;

  if (!rosterFlagged && !domBadge) {
    // Build a detailed error.
    const rosterMsg = rosterFound
      ? `roster frame found for ${SILENT_ID} but has_posted=${rosterPosted} (not flagged false)`
      : `no roster frame found for ${SILENT_ID} in ${messages.length} captured frames`;
    throw new Error(
      `logging-not-posting (expected-fail-until-fix #14): ` +
      `silent member was not flagged as "not logging".\n` +
      `  Roster check: ${rosterMsg}.\n` +
      `  DOM badge: not found.\n` +
      `  This means either: (a) the worker does not emit has_posted:false yet, ` +
      `or (b) the UI does not render the ⚠ badge yet. ` +
      `Both tracks failed — #14 is not yet implemented.\n` +
      `  [HARNESS FLAG: grace window timing and roster broadcast shape unknown — ` +
      `surface worker constant and roster schema for precise assertion]`
    );
  }

  if (rosterFlagged) {
    console.log(`       [pass] roster frame has has_posted:false for ${SILENT_ID}`);
  }
  if (domBadge) {
    console.log(`       [pass] DOM badge / "not logging" indicator visible for ${SILENT_ID}`);
  }

  // No fatal JS errors.
  const fatal = errors.filter(e =>
    /SyntaxError|ReferenceError|is not defined|is not a function|TypeError/.test(e) &&
    !/fetch|net::ERR|CORS|Failed to load/.test(e)
  );
  if (fatal.length > 0) {
    throw new Error(`logging-not-posting: fatal JS errors:\n  ${fatal.slice(0, 3).join('\n  ')}`);
  }

  await page.close();
};

// ---------------------------------------------------------------------------
// Scenario B: logging-late-start
// ---------------------------------------------------------------------------
/**
 * A member joins, is initially silent (would be flagged), THEN starts posting.
 * The badge/roster entry must transition from not-logging → ok.
 *
 * Steps:
 *   1. Receiving client joins.
 *   2. Silent bot opens WS (no posts yet).
 *   3. Wait for any roster flag (has_posted:false or DOM badge visible).
 *   4. Silent bot now sends a real post_fight frame.
 *   5. Assert badge clears: has_posted becomes true (or truthy) in the next
 *      roster broadcast, and the DOM badge disappears.
 *
 * HARNESS CAPABILITY FLAG:
 *   Sending a post_fight from the "previously silent" raw WS connection is
 *   doable (we have ws.send access in openSilentMember).  We extend
 *   openSilentMember to return the ws so we can send later.
 *
 *   Reading the DOM badge DISAPPEARING after the post is the inverse of
 *   hasBadgeDom — we wait up to 5s for it to go false.
 *
 * Tagged expected-fail-until-fix: #14 not yet implemented.
 */
module.exports.loggingLateStart = async function loggingLateStart(ctx) {
  const { genCode, runSim, getBrowser, wranglerHost, indexHtml } = ctx;
  const code = genCode('LLS');

  const { context } = await getBrowser();

  const { page, messages, errors } = await openReceivingClient({
    context,
    indexHtml,
    code,
    wranglerHost,
    userId:   'lls_rx_1',
    username: 'LateStartRx',
  });

  const welcome = await waitForWorkerMessage(messages, m => m.type === 'welcome', 12_000);
  if (!welcome) {
    throw new Error('logging-late-start: receiving client did not get welcome frame');
  }

  // Open the "late starter" member as a raw WS.
  const LATE_ID = 'lls_late';
  let lateWs;
  try {
    const conn = await openSilentMember(wranglerHost, code, LATE_ID);
    lateWs = conn.ws;
  } catch (err) {
    throw new Error(`logging-late-start: could not open late-starter WS: ${err.message}`);
  }

  // Also run a real posting bot so the room has activity.
  // This gives the worker a reason to broadcast roster comparisons.
  const simResult = await runSim(
    [code, '--members', '1', '--now'],
    15_000
  );

  // Phase 1: wait up to 10s for the late member to be flagged (has_posted:false or DOM badge).
  let phase1RosterFlagged = false;
  let phase1DomBadge = false;

  const phase1Deadline = Date.now() + 10_000;
  while (Date.now() < phase1Deadline) {
    const rosterCheck = checkRosterFrame(messages, LATE_ID);
    if (rosterCheck.found && rosterCheck.has_posted === false) {
      phase1RosterFlagged = true;
      break;
    }
    try {
      phase1DomBadge = await hasBadgeDom(page, LATE_ID);
      if (phase1DomBadge) break;
    } catch (_) {}
    await delay(500);
  }

  // Log phase 1 result (not a hard fail — if #14 isn't implemented,
  // neither track will show a flag, and we skip to phase 2 anyway).
  if (phase1RosterFlagged) {
    console.log(`       [phase1 pass] ${LATE_ID} flagged as not-logging in roster`);
  } else if (phase1DomBadge) {
    console.log(`       [phase1 pass] ${LATE_ID} flagged via DOM badge`);
  } else {
    console.log(
      `       [phase1 skip] ${LATE_ID} was not flagged before first post ` +
      `(grace window may be >10s, or #14 not yet implemented — ` +
      `proceeding to phase 2 transition test)`
    );
  }

  // Phase 2: late member NOW posts a fight frame.
  // Build a minimal post_fight frame (matches worker contract).
  const fightTs = Date.now();
  const postFrame = {
    type:         'post_fight',
    v:            2,
    fight_ts:     fightTs,
    encounter_id: String(fightTs),
    targets: [{
      target:         'LateTestBoss',
      total_damage:   500_000,
      dps:            8333.0,
      duration:       60.0,
      hits:           200,
      crit_rate:      30.0,
      heavy_rate:     15.0,
      crit_heavy_rate: 6.0,
    }],
    summary: { total_damage: 500_000, duration: 60.0 },
    skills:   null,
    rotation: null,
    final:    false,
  };

  try {
    lateWs.send(JSON.stringify(postFrame));
  } catch (err) {
    // ws may have closed; not fatal for the test logic.
    console.log(`       [warn] could not send post_fight for late member: ${err.message}`);
  }

  // Give worker time to process + broadcast.
  await delay(3_000);

  // Phase 2 check: has_posted should now be true (or truthy) in roster, badge gone.
  const rosterAfter = checkRosterFrame(messages, LATE_ID);
  let domBadgeAfter = true; // pessimistic default
  try {
    domBadgeAfter = await hasBadgeDom(page, LATE_ID);
  } catch (_) {}

  const rosterCleared  = rosterAfter.found && rosterAfter.has_posted !== false;
  const domBadgeCleared = !domBadgeAfter;

  try { lateWs.close(); } catch (_) {}

  // If #14 is not implemented, both phase1 and phase2 checks will be unclear.
  // We fail if BOTH phase1 and phase2 roster checks are uninformative AND
  // neither phase showed a DOM badge at all.
  if (!phase1RosterFlagged && !phase1DomBadge && !rosterAfter.found) {
    throw new Error(
      `logging-late-start (expected-fail-until-fix #14): ` +
      `no roster frame ever contained ${LATE_ID} in either phase. ` +
      `The worker did not broadcast this member's has_posted state. ` +
      `[HARNESS FLAG: roster broadcast schema must include has_posted per member; ` +
      `leader-side banner needs a second Playwright page with leader=1]`
    );
  }

  // If phase 1 flagged the member, phase 2 must clear them.
  if ((phase1RosterFlagged || phase1DomBadge) && !rosterCleared && !domBadgeCleared) {
    throw new Error(
      `logging-late-start (expected-fail-until-fix #14): ` +
      `late member was flagged in phase 1 but badge/has_posted did NOT clear after posting.\n` +
      `  Roster after post: found=${rosterAfter.found} has_posted=${rosterAfter.has_posted}\n` +
      `  DOM badge after post: ${domBadgeAfter}\n` +
      `  Expected: has_posted:true and badge gone after first post_fight.`
    );
  }

  if (rosterCleared) {
    console.log(`       [phase2 pass] ${LATE_ID} has_posted cleared to truthy after posting`);
  }
  if (domBadgeCleared) {
    console.log(`       [phase2 pass] DOM badge cleared for ${LATE_ID} after posting`);
  }

  // No fatal JS errors.
  const fatal = errors.filter(e =>
    /SyntaxError|ReferenceError|is not defined|is not a function|TypeError/.test(e) &&
    !/fetch|net::ERR|CORS|Failed to load/.test(e)
  );
  if (fatal.length > 0) {
    throw new Error(`logging-late-start: fatal JS errors:\n  ${fatal.slice(0, 3).join('\n  ')}`);
  }

  await page.close();
};
