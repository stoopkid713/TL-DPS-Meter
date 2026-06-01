// Smoke: the REAL index.html boots under the mock (no game/backend/worker), the WebSocket
// mock is exercised, and there are no fatal JS errors. Proves the harness approach works
// before we script full party scenarios.
const { test, expect } = require('@playwright/test');
const { openApp } = require('./harness');

test('index.html boots with mocked sockets, no fatal JS errors', async ({ page }) => {
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));

  await openApp(page);

  // tab bar rendered (the app's chrome is up)
  const tabs = page.locator('.tab');
  await expect(tabs.first()).toBeVisible({ timeout: 10_000 });
  expect(await tabs.count()).toBeGreaterThan(2);

  // the app attempted its sockets through our mock (proves interception works)
  const counts = await page.evaluate(() => window.__mock.counts());
  expect(counts.total).toBeGreaterThan(0);

  // no parse/reference/type errors (file:// fetch failures for /skills etc. are fine and filtered)
  const fatal = errors.filter(e => /SyntaxError|ReferenceError|is not defined|is not a function/.test(e));
  expect(fatal, 'fatal JS errors:\n' + fatal.join('\n')).toHaveLength(0);
});
