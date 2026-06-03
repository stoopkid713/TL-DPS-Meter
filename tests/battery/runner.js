#!/usr/bin/env node
/**
 * TL-DPS-Meter — Internal Sim Test Battery Runner
 * Phase 1 (S1.1 + S1.2 + S1.3)
 *
 * Orchestrates:
 *   1. `wrangler dev` — local worker at ws://127.0.0.1:8787  (never prod)
 *   2. sim_party.py bots — the SENDER side (existing tool, driven as subprocess)
 *   3. Playwright receiving-client — REAL WebSocket to wrangler dev (not mocked)
 *   4. Per-scenario assertions → PASS/FAIL matrix
 *
 * Usage:
 *   node runner.js --smoke          # fast core scenarios (runtime: browser)
 *   node runner.js --full           # all wired scenarios
 *   node runner.js --list           # print scenario metadata + runtime tags
 *   node runner.js --scenario boot  # run a single scenario by name
 *
 * Architecture notes (S1.1):
 *   - Python path: C:/Users/Admin/Projects/TL-DPS-Meter/backend/.venv/Scripts/python.exe
 *   - wrangler dev is started from  workers/party/ dir (wrangler.toml there)
 *   - Worker takes ~3-5 s to start; runner polls /party/PROBE (HTTP 200 or 404 = up)
 *   - Receiving-client harness lives in ./receiving-client.js (S1.2)
 *   - Each scenario exports { name, runtime, tags, fn(ctx) }
 *   - runtime: 'browser'   => automated runner clears it
 *   - runtime: 'real-app'  => tagged+reported, skipped in automation (exe gate only)
 *
 * runtime: tag meaning (D1/D2 from the spec):
 *   'browser'  — target A (raw index.html + real WebSocket) is sufficient. Runs on every
 *                battery invocation. Covers UI logic, render, both-sides data flow.
 *   'real-app' — must pass on the BUILT EXE (target B) before release. pywebview / WebView2
 *                / packaging-sensitive surfaces. Tagged+reported here, NOT auto-run.
 */

'use strict';

const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('@playwright/test');

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
// REPO_ROOT = the worktree root (TL-DPS-laneBattery) — worker + index.html live here.
// MAIN_REPO = the primary checkout (TL-DPS-Meter) — backend/.venv + tools live there.
// In a worktree the two differ; in a straight clone they are the same dir.
//
// Resolution order for MAIN_REPO (where backend/.venv lives):
//   1. env var TLDPS_MAIN_REPO (explicit override)
//   2. sibling "TL-DPS-Meter" directory (standard worktree layout)
//   3. REPO_ROOT itself (straight clone, no worktree)
const REPO_ROOT   = path.resolve(__dirname, '..', '..');
const fs_check    = require('fs');
const _parentDir  = path.dirname(REPO_ROOT);
const _candidates = [
  process.env.TLDPS_MAIN_REPO,
  path.join(_parentDir, 'TL-DPS-Meter'),
  REPO_ROOT,
];
const MAIN_REPO   = _candidates.find(p => p && fs_check.existsSync(path.join(p, 'backend', '.venv'))) || REPO_ROOT;

const WORKER_DIR  = path.join(REPO_ROOT, 'workers', 'party');
const BACKEND_DIR = path.join(MAIN_REPO, 'backend');
const PYTHON      = path.join(BACKEND_DIR, '.venv', 'Scripts', 'python.exe');
const SIM_SCRIPT  = path.join(BACKEND_DIR, 'tools', 'sim_party.py');
const INDEX_HTML  = path.join(MAIN_REPO, 'index.html');
// Deterministic combat-log fixture (Aelindra → Tevent, a known boss, 180 DamageDone hits).
// Injected into any sim call that would otherwise read the machine's LIVE combat log,
// so scenario results don't depend on whether the user is currently playing.
const FIXTURE_LOG = path.join(__dirname, 'fixtures', 'party_fixture_tevent.txt');

const WRANGLER_PORT = 8787;
const WRANGLER_HOST = `ws://127.0.0.1:${WRANGLER_PORT}`;
const WRANGLER_HTTP = `http://127.0.0.1:${WRANGLER_PORT}`;

// ---------------------------------------------------------------------------
// Scenario registry — loaded lazily from ./scenarios/
// ---------------------------------------------------------------------------
const { scenarios } = require('./scenarios');

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const FLAG_SMOKE    = args.includes('--smoke');
const FLAG_FULL     = args.includes('--full');
const FLAG_LIST     = args.includes('--list');
const SINGLE_IDX    = args.indexOf('--scenario');
const SINGLE_NAME   = SINGLE_IDX >= 0 ? args[SINGLE_IDX + 1] : null;
// If nothing specified, default to --smoke
const RUN_MODE      = FLAG_FULL ? 'full' : (SINGLE_NAME ? 'single' : 'smoke');

// ---------------------------------------------------------------------------
// Wrangler dev lifecycle
// ---------------------------------------------------------------------------

/** Start `wrangler dev` and return a handle with .kill(). */
function startWrangler() {
  console.log('[battery] starting wrangler dev ...');
  const proc = spawn(
    'npx', ['wrangler', 'dev', '--port', String(WRANGLER_PORT), '--local'],
    {
      cwd: WORKER_DIR,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  proc.stdout.on('data', d => process.stdout.write(`[wrangler] ${d}`));
  proc.stderr.on('data', d => process.stderr.write(`[wrangler:err] ${d}`));
  proc.on('exit', (code, sig) => {
    if (code !== null && code !== 0)
      console.log(`[wrangler] exited code=${code} sig=${sig}`);
  });
  return proc;
}

/** Poll until wrangler is ready (HTTP upgrade on any WS path responds). */
async function waitForWrangler(timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const http = require('http');
      await new Promise((res, rej) => {
        const req = http.get(`${WRANGLER_HTTP}/health`, r => {
          r.resume();
          res(r.statusCode);
        });
        req.on('error', rej);
        // 3 s per-attempt: wrangler's first request initialises the DO + SQLite
        // and can take 1-2 s even after "Ready on ..." is printed.
        req.setTimeout(3_000, () => { req.destroy(); rej(new Error('timeout')); });
      });
      return; // any response = worker is up
    } catch (_) {
      await new Promise(r => setTimeout(r, 800));
    }
  }
  throw new Error(`wrangler dev did not start within ${timeoutMs}ms`);
}

// ---------------------------------------------------------------------------
// sim_party.py runner
// ---------------------------------------------------------------------------

/**
 * Run sim_party.py with given args; return {stdout, stderr, code}.
 * Always targets the LOCAL wrangler dev (--host ws://127.0.0.1:8787).
 */
function runSim(simArgs, timeoutMs = 20_000) {
  return new Promise((resolve) => {
    // If this call would read the LIVE combat log (no --multiboss/--scenario/--log),
    // inject the deterministic fixture so the test is reproducible regardless of the
    // machine's current combat log state.
    const needsLog = !simArgs.some(a => a === '--multiboss' || a === '--scenario' || a === '--log');
    const logArgs = needsLog ? ['--log', FIXTURE_LOG] : [];
    const fullArgs = [SIM_SCRIPT, ...simArgs, ...logArgs, '--host', WRANGLER_HOST];
    const proc = spawn(PYTHON, fullArgs, {
      cwd: BACKEND_DIR,
      shell: false,
    });
    let stdout = '', stderr = '';
    proc.stdout.on('data', d => { stdout += d; });
    proc.stderr.on('data', d => { stderr += d; });

    let timer = setTimeout(() => {
      proc.kill();
      resolve({ stdout, stderr, code: -1, timedOut: true });
    }, timeoutMs);

    proc.on('close', code => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code, timedOut: false });
    });
  });
}

// ---------------------------------------------------------------------------
// Playwright browser context (shared across scenarios per run)
// ---------------------------------------------------------------------------

let _browser = null;
let _context = null;

async function getBrowser() {
  if (!_browser) {
    _browser = await chromium.launch({ headless: true });
    _context = await _browser.newContext();
  }
  return { browser: _browser, context: _context };
}

async function closeBrowser() {
  if (_browser) {
    await _browser.close().catch(() => {});
    _browser = null;
    _context = null;
  }
}

// ---------------------------------------------------------------------------
// Utility: generate a random party code
// ---------------------------------------------------------------------------
function genCode(prefix = 'BT') {
  const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = prefix;
  while (s.length < 6) s += CHARS[Math.floor(Math.random() * CHARS.length)];
  return s;
}

// ---------------------------------------------------------------------------
// Scenario context object passed to each scenario fn
// ---------------------------------------------------------------------------
function makeCtx({ code }) {
  return {
    code,
    wranglerHost: WRANGLER_HOST,
    wranglerHttp: WRANGLER_HTTP,
    indexHtml: INDEX_HTML,
    genCode,
    runSim,
    getBrowser,
  };
}

// ---------------------------------------------------------------------------
// Main runner
// ---------------------------------------------------------------------------

async function main() {
  // --list: just print scenario table and exit
  if (FLAG_LIST) {
    console.log('\n  TL-DPS-Meter Battery — Scenario Catalog\n');
    console.log('  Name'.padEnd(35) + 'Runtime'.padEnd(12) + 'Tags');
    console.log('  ' + '-'.repeat(68));
    for (const s of scenarios) {
      const tags = (s.tags || []).join(', ');
      console.log('  ' + s.name.padEnd(33) + s.runtime.padEnd(12) + tags);
    }
    console.log('');
    const browser = scenarios.filter(s => s.runtime === 'browser').length;
    const real    = scenarios.filter(s => s.runtime === 'real-app').length;
    console.log(`  Total: ${scenarios.length}  (browser=${browser}, real-app=${real})\n`);
    return 0;
  }

  // Filter scenarios to run
  let toRun;
  if (SINGLE_NAME) {
    toRun = scenarios.filter(s => s.name === SINGLE_NAME);
    if (!toRun.length) {
      console.error(`[battery] unknown scenario "${SINGLE_NAME}". Use --list to see names.`);
      return 1;
    }
  } else if (RUN_MODE === 'full') {
    toRun = scenarios.filter(s => s.runtime === 'browser');
  } else {
    // smoke: only smoke-tagged browser scenarios
    toRun = scenarios.filter(s => s.runtime === 'browser' && (s.tags || []).includes('smoke'));
  }

  // Report real-app skips
  const realAppCount = scenarios.filter(s => s.runtime === 'real-app').length;
  if (realAppCount > 0 && RUN_MODE !== 'single') {
    console.log(`[battery] NOTE: ${realAppCount} scenario(s) tagged runtime:real-app are SKIPPED`);
    console.log(`          (require the built .exe — not automatable in this runner).`);
  }

  console.log(`\n[battery] mode=${RUN_MODE}  running ${toRun.length} scenario(s)  wrangler=LOCAL:${WRANGLER_PORT}\n`);

  // Start wrangler dev
  const wranglerProc = startWrangler();

  // Ensure cleanup on exit
  const cleanup = async () => {
    await closeBrowser();
    wranglerProc.kill('SIGTERM');
  };
  process.on('SIGINT', async () => { await cleanup(); process.exit(1); });
  process.on('SIGTERM', async () => { await cleanup(); process.exit(1); });

  let exitCode = 0;
  try {
    await waitForWrangler();
    console.log('[battery] wrangler dev is up.\n');

    const results = [];

    for (const scenario of toRun) {
      const code = genCode('BT');
      const ctx = makeCtx({ code });
      const label = `${scenario.name}  [runtime:${scenario.runtime}]`;
      process.stdout.write(`  RUNNING  ${label} ... `);
      const t0 = Date.now();

      let status = 'PASS';
      let detail = '';
      try {
        await scenario.fn(ctx);
      } catch (err) {
        status = 'FAIL';
        detail = err.message || String(err);
      }

      const ms = Date.now() - t0;
      console.log(`${status}  (${ms}ms)${detail ? '\n           ' + detail : ''}`);
      results.push({ name: scenario.name, status, ms, runtime: scenario.runtime, detail });
    }

    // Print matrix
    console.log('\n' + '═'.repeat(72));
    console.log('  BATTERY RESULTS  ' + new Date().toISOString());
    console.log('═'.repeat(72));
    for (const r of results) {
      const icon = r.status === 'PASS' ? '✔' : '✘';
      console.log(`  ${icon}  ${r.name.padEnd(40)} ${r.status.padEnd(6)}  ${r.ms}ms`);
    }
    const passed = results.filter(r => r.status === 'PASS').length;
    const failed = results.filter(r => r.status === 'FAIL').length;
    console.log('═'.repeat(72));
    console.log(`  ${passed} passed, ${failed} failed  (${toRun.length} total)\n`);

    // Print real-app required list for awareness
    const realApp = scenarios.filter(s => s.runtime === 'real-app');
    if (realApp.length) {
      console.log('  🏷  real-app gate (must pass on built .exe before release):');
      for (const s of realApp) {
        console.log(`       - ${s.name}  [${(s.tags || []).join(', ')}]`);
      }
      console.log('');
    }

    exitCode = failed > 0 ? 1 : 0;
  } catch (err) {
    console.error('[battery] FATAL:', err.message);
    exitCode = 2;
  } finally {
    await cleanup();
  }

  return exitCode;
}

main().then(code => process.exit(code)).catch(err => {
  console.error(err);
  process.exit(2);
});
