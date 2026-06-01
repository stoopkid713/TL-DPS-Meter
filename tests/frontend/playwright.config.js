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
    // ALWAYS-ON recording so we can replay + review behavior together after any run
    // (Kyle: "wire to our debug run so we can go back over behavior", 2026-05-31).
    // Artifacts -> test-results/ (videos, traces) + playwright-report/ (browsable HTML),
    // both gitignored. Review with: `npx playwright show-report` (embeds video+trace+screens
    // per test) or `npx playwright show-trace <test-results/.../trace.zip>` (step time-travel).
    screenshot: 'on',
    trace: 'on',
    video: 'on',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
