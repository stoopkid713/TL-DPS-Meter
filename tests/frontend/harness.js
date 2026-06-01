// Shared harness helpers: load the REAL index.html with the WebSocket mock installed
// and a saved party identity seeded, so tests land straight in a usable app.
const path = require('path');

const INDEX_URL = 'file://' + path.resolve(__dirname, '..', '..', 'index.html').replace(/\\/g, '/');

async function openApp(page, opts = {}) {
  const { username = 'TestUser', userId = 'user_test_1' } = opts;
  await page.addInitScript({ path: path.join(__dirname, 'mock-app.js') });
  await page.addInitScript(([u, id]) => {
    try {
      localStorage.setItem('party_username', u);
      localStorage.setItem('party_user_id', id);
    } catch (e) {}
  }, [username, userId]);
  await page.goto(INDEX_URL);
  // give the app's boot + the mocked backend socket a tick to settle
  await page.waitForFunction(() => window.__mock && window.__mock.counts().total > 0, null, { timeout: 10_000 });
}

module.exports = { openApp, INDEX_URL };
