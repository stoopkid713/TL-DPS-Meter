// Capture: feedback/report-a-bug modal + the (forced) update banner.
// Run: npx playwright test capture-feedback.spec.js
const { test, expect } = require('@playwright/test');
const { openApp } = require('./harness');
const path = require('path');
const SHOTS = path.join(__dirname, 'shots');

test('feedback modal + update banner render', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await openApp(page);

  // elements present
  const hasBtn = await page.evaluate(() => !!document.querySelector('[onclick="openFeedbackModal()"]'));
  const hasBanner = await page.evaluate(() => !!document.getElementById('updateBanner'));
  const hasFn = await page.evaluate(() => typeof openFeedbackModal === 'function' && typeof checkUpdateBanner === 'function');
  console.log('[feedback button present]:', hasBtn, '| #updateBanner present:', hasBanner, '| fns global:', hasFn);

  // open the modal (type=bug) and screenshot it
  await page.evaluate(() => openFeedbackModal('bug'));
  await page.waitForTimeout(250);
  const modalText = await page.evaluate(() => { const m = document.querySelector('.fb-modal'); return m ? m.innerText.replace(/\s+/g, ' ').slice(0, 160) : '(no modal)'; });
  console.log('[modal text]:', modalText);
  await page.screenshot({ path: path.join(SHOTS, 'feedback-modal.png') });

  // expand "what's included" + screenshot
  await page.evaluate(() => { const w = document.getElementById('fbWhat'); if (w) w.click(); });
  await page.waitForTimeout(150);
  await page.screenshot({ path: path.join(SHOTS, 'feedback-modal-expanded.png') });

  // close, then force-render the update banner to verify its styling (the real check is gated on a GitHub fetch)
  await page.evaluate(() => { const ov = document.getElementById('fbOverlay'); if (ov) ov.remove(); });
  await page.evaluate(() => {
    const b = document.getElementById('updateBanner');
    b.innerHTML = '⬆ Update available: <strong>v1.0.4</strong> — <a href="#">Download</a> <span style="opacity:.65">(you have v1.0.3)</span><button class="update-banner-x">✕</button>';
    b.style.display = 'flex';
  });
  await page.waitForTimeout(150);
  await page.screenshot({ path: path.join(SHOTS, 'update-banner.png'), clip: { x: 0, y: 0, width: 1280, height: 260 } });

  expect(hasBtn).toBe(true);
  expect(hasBanner).toBe(true);
  expect(hasFn).toBe(true);
  expect(modalText).toContain('Bug');
});
