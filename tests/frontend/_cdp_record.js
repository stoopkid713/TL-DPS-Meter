// Attach Playwright to the LIVE pywebview/WebView2 app over CDP and record the
// session for review-together. The app must be launched with a debug port:
//   WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222
// Usage:  node _cdp_record.js [seconds]
//   seconds -> trace that long then save (timed). no arg -> until Ctrl+C, then save.
// Output: test-results/human-run-<ts>.zip  (npx playwright show-trace <zip>)
//         test-results/human-console.log    (live console + page errors)
const fs = require('fs');
const { chromium } = require('@playwright/test');
const PORT = process.env.CDP_PORT || '9222';
const secs = process.argv[2] ? Number(process.argv[2]) : null;
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const tracePath = `test-results/human-run-${stamp}.zip`;
const consolePath = 'test-results/human-console.log';

async function connectWithRetry(ms = 30000) {
  const deadline = Date.now() + ms;
  for (;;) {
    try { return await chromium.connectOverCDP(`http://localhost:${PORT}`); }
    catch (e) {
      if (Date.now() > deadline) throw e;
      await new Promise(r => setTimeout(r, 1000)); // waiting for the app window
    }
  }
}

(async () => {
  console.log(`waiting for the app on :${PORT} ...`);
  const browser = await connectWithRetry();
  const ctx = browser.contexts()[0];
  const page = ctx.pages()[0];
  fs.mkdirSync('test-results', { recursive: true });
  fs.writeFileSync(consolePath, `# human session ${stamp}\n`);
  page.on('console', m => fs.appendFileSync(consolePath, `[${m.type()}] ${m.text()}\n`));
  page.on('pageerror', e => fs.appendFileSync(consolePath, `[pageerror] ${e.message}\n`));
  await ctx.tracing.start({ screenshots: true, snapshots: true, sources: true });
  console.log(`RECORDING -> ${tracePath}`);
  const finish = async () => {
    try { await ctx.tracing.stop({ path: tracePath }); } catch (e) {}
    console.log(`\nSAVED -> ${tracePath}\nReview: npx playwright show-trace ${tracePath}`);
    process.exit(0);
  };
  process.on('SIGINT', finish);
  process.on('SIGTERM', finish);
  if (secs) setTimeout(finish, secs * 1000);
  else console.log('Interact with the app, then close this window / Ctrl+C to save the trace.');
})().catch(e => { console.error('RECORD FAILED:', e.message); process.exit(1); });
