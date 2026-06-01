// Playwright config for the TL-DPS frontend harness.
// We load the REAL index.html over file:// and intercept its two WebSockets (see mock-app.js),
// so the actual screens render scripted party runs with no game / backend / worker.
const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.js',
  fullyParallel: false,        // the app is heavy (1.27MB); keep runs serial + stable
  timeout: 30_000,
  expect: { timeout: 7_000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    headless: true,
    // index.html is loaded via file:// per-test (see fixtures.js) — no webServer needed.
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
