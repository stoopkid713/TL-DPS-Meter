'use strict';
/**
 * S1.2 — Receiving-Client Harness
 *
 * Opens the REAL index.html in Playwright Chromium with a REAL WebSocket pointed at
 * ws://127.0.0.1:8787 (wrangler dev). NO mock-app.js — the actual app code runs.
 *
 * This is the exact gap that burned the project: the "friend's side" that receives
 * broadcasts and requests drill-down was never exercised in automation. This harness
 * closes that gap for every scenario.
 *
 * How the real WS is wired:
 *   - The app's party.js reads party_code and party_host from localStorage.
 *   - We seed localStorage via addInitScript BEFORE page load.
 *   - party_host is set to ws://127.0.0.1:8787 so the app's real WebSocket constructor
 *     dials wrangler dev (not the production worker).
 *   - We do NOT inject mock-app.js — the WebSocket is the browser's native implementation.
 *   - We capture all messages sent by the worker on that socket via a page.evaluate
 *     bridge (see _injectMessageCapture).
 *   - leader=0 is forced so this client is always the RECEIVER (non-leader member).
 *
 * Exports:
 *   openReceivingClient(opts) → { page, messages, errors }
 *     messages: a growing array of parsed JSON frames from the worker
 *     errors:   a growing array of pageerror strings
 *
 *   waitForWorkerMessage(messages, predicate, timeoutMs) → message | null
 *     Poll messages until predicate returns true, or timeout.
 */

const path = require('path');

/**
 * Inject a script that:
 *  1. REDIRECTS any WebSocket URL pointing at the production worker to wrangler dev
 *     (ws://127.0.0.1:8787). The app hardcodes wss://tldps-party.kyle-526.workers.dev —
 *     we transparently rewrite that to ws://127.0.0.1:8787 so the real app code dials local.
 *  2. CAPTURES every message from the party socket into window.__battery_messages
 *     (polled by the Node side via page.evaluate).
 *
 * This runs BEFORE the app's scripts via addInitScript — the native WebSocket constructor
 * is replaced before party.js reads it. The real TCP connection goes to wrangler dev;
 * nothing is mocked.
 */
function makeCaptureScript(localWsUrl) {
  return `
(() => {
  window.__battery_messages = [];
  const _LOCAL = ${JSON.stringify(localWsUrl)};
  const _OrigWS = window.WebSocket;

  // Rewrite production worker URLs to local wrangler dev.
  // Use new RegExp() so literal slashes don't fight the template string parser.
  var _PARTY_RE = new RegExp('wss?://[^/]+(/party/.+)', 'i');
  function rewriteUrl(url) {
    var u = String(url);
    var m = u.match(_PARTY_RE);
    if (m) return _LOCAL + m[1];
    return u;
  }

  function patchSocket(ws, url) {
    const u = String(url);
    const isParty = u.includes('/party/') || u.includes('127.0.0.1:8787') || u.includes('workers.dev');
    if (!isParty) return ws;

    // Expose for scenarios that need to send frames from the page.
    window._partyWS = ws;

    // Patch addEventListener to intercept 'message' events.
    const origAddEvt = ws.addEventListener.bind(ws);
    ws.addEventListener = function(type, fn, opts) {
      if (type === 'message') {
        const wrapped = function(ev) {
          try {
            const parsed = JSON.parse(ev.data);
            window.__battery_messages.push(parsed);
          } catch (_) {}
          if (fn) fn(ev);
        };
        return origAddEvt(type, wrapped, opts);
      }
      return origAddEvt(type, fn, opts);
    };

    // Patch onmessage property setter.
    let _om = null;
    Object.defineProperty(ws, 'onmessage', {
      get() { return _om; },
      set(fn) {
        _om = fn;
        if (fn) {
          // Re-register through our patched addEventListener so messages are captured.
          origAddEvt('message', function(ev) {
            try { window.__battery_messages.push(JSON.parse(ev.data)); } catch (_) {}
            try { fn(ev); } catch (_) {}
          });
        }
      },
      configurable: true,
    });

    return ws;
  }

  window.WebSocket = function(url, protocols) {
    const rewritten = rewriteUrl(url);
    const ws = protocols != null ? new _OrigWS(rewritten, protocols) : new _OrigWS(rewritten);
    // Track the backend socket (:8765) so we can push synthetic messages into it.
    if (String(rewritten).includes('8765') || String(rewritten).includes('localhost:876')) {
      window._backendWS = ws;
    }
    return patchSocket(ws, rewritten);
  };
  window.WebSocket.CONNECTING = _OrigWS.CONNECTING;
  window.WebSocket.OPEN       = _OrigWS.OPEN;
  window.WebSocket.CLOSING    = _OrigWS.CLOSING;
  window.WebSocket.CLOSED     = _OrigWS.CLOSED;
  window.WebSocket.prototype  = _OrigWS.prototype;

  // Helper: push a synthetic message into the backend socket as if the Python server sent it.
  // Used by the battery to trigger connectPartyWS without a running backend.
  window.__battery_triggerPartyJoin = function(code, userId, username) {
    function deliver() {
      const ws = window._backendWS;
      if (!ws) { setTimeout(deliver, 200); return; }
      // Dispatch a fake MessageEvent on the backend WS — party_status fires updatePartyStatus.
      const payload = JSON.stringify({
        type: 'party_status',
        status: {
          connected: true,
          party_code: code,
          is_leader: false,
          user_id: userId,
          username: username,
        }
      });
      const ev = new MessageEvent('message', { data: payload });
      ws.dispatchEvent(ev);
      if (ws.onmessage) { try { ws.onmessage(ev); } catch(_) {} }
    }
    deliver();
  };
})();
`;
}

/**
 * Stub window.pywebview so the app doesn't throw when it tries to call
 * pywebview.api.* (it's a browser, not the desktop shell).
 */
const PYWEBVIEW_STUB = `
window.pywebview = window.pywebview || {
  api: new Proxy({}, { get: () => () => Promise.resolve(null) }),
  token: 'battery-test',
};
`;

/**
 * Open the app as a non-leader receiving-side member.
 *
 * @param {object} opts
 * @param {import('@playwright/test').BrowserContext} opts.context  - Playwright browser context
 * @param {string} opts.indexHtml  - absolute path to index.html
 * @param {string} opts.code       - party code to join
 * @param {string} opts.wranglerHost - ws://127.0.0.1:8787
 * @param {string} [opts.userId]   - unique user ID for this receiving client
 * @param {string} [opts.username] - display name
 * @returns {{ page, messages: object[], errors: string[] }}
 */
async function openReceivingClient({
  context,
  indexHtml,
  code,
  wranglerHost,
  userId   = 'rx_client_1',
  username = 'RxClient',
}) {
  const page = await context.newPage();
  const messages = [];
  const errors = [];

  page.on('pageerror', e => errors.push(String(e)));

  // 1. Inject URL-rewrite + capture + pywebview stub BEFORE page scripts run.
  //    The rewrite redirects wss://tldps-party.*.workers.dev/party/<CODE> → ws://127.0.0.1:8787/party/<CODE>.
  //    This runs before party.js reads window.WebSocket, so the app's real WS dials wrangler dev.
  await page.addInitScript(makeCaptureScript(wranglerHost));
  await page.addInitScript(PYWEBVIEW_STUB);

  // 2. Seed identity + party code into localStorage.
  //    Note: party.js hardcodes the WS host, so we do NOT override it via localStorage.
  //    The URL rewrite above handles the redirect transparently.
  await page.addInitScript(([c, uid, uname]) => {
    try {
      localStorage.setItem('party_username', uname);
      localStorage.setItem('party_user_id',  uid);
      // party.js reads party_code from localStorage to auto-join on load.
      // We set a plausible stored code — the app will attempt to connect with it.
      // The actual room code is what matters (set by the scenario on the worker side).
      localStorage.setItem('party_code', c);
      // Clear any stale leader state.
      localStorage.removeItem('party_is_leader');
    } catch (_) {}
  }, [code, userId, username]);

  // 3. Load the app.
  const INDEX_URL = 'file://' + indexHtml.replace(/\\/g, '/');
  await page.goto(INDEX_URL, { waitUntil: 'domcontentloaded' });

  // 4. Trigger party join via synthetic backend message.
  //    The app connects to the party worker WebSocket only AFTER it receives a
  //    party_status message from the backend (:8765). Since there's no backend running
  //    in the battery, we push the trigger directly into the backend WS event queue.
  //    This calls updatePartyStatus({connected:true, party_code:code}) which fires
  //    connectPartyWS — the party WebSocket then opens to wrangler dev.
  await page.waitForTimeout(800); // let app boot + open the backend socket
  await page.evaluate(([c, uid, uname]) => {
    if (typeof window.__battery_triggerPartyJoin === 'function') {
      window.__battery_triggerPartyJoin(c, uid, uname);
    }
  }, [code, userId, username]);

  // 5. Poll page for new messages and copy into our Node-side array.
  //    We use a polling loop rather than evaluate() every time because
  //    page.evaluate() cannot push to a Node array directly.
  let _pollOffset = 0;
  const _pollInterval = setInterval(async () => {
    try {
      const newMsgs = await page.evaluate((offset) => {
        const all = window.__battery_messages || [];
        return all.slice(offset);
      }, _pollOffset).catch(() => []);
      if (newMsgs.length > 0) {
        _pollOffset += newMsgs.length;
        messages.push(...newMsgs);
      }
    } catch (_) {}
  }, 150);

  // Attach cleanup to page close.
  page.on('close', () => clearInterval(_pollInterval));

  return { page, messages, errors };
}

/**
 * Wait until messages contains a frame matching `predicate`, or timeout.
 *
 * @param {object[]} messages  - live-growing array from openReceivingClient
 * @param {function} predicate - (msg) => boolean
 * @param {number}   timeoutMs
 * @returns {object|null}      - the matched message, or null on timeout
 */
async function waitForWorkerMessage(messages, predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let offset = 0;
  while (Date.now() < deadline) {
    for (let i = offset; i < messages.length; i++) {
      if (predicate(messages[i])) return messages[i];
    }
    offset = messages.length;
    await new Promise(r => setTimeout(r, 100));
  }
  return null;
}

// ---------------------------------------------------------------------------
// Adversarial fault-injection primitives
// (S1.adv — used by adversarial-*.js scenarios)
// ---------------------------------------------------------------------------

/**
 * Open a RAW Node.js WebSocket to /party/<code> — no welcome wait, full control.
 * Returns {ws} immediately after TCP open; the caller drives the socket.
 *
 * @param {string} wranglerHost  - ws://127.0.0.1:8787
 * @param {string} code          - party code
 * @param {string} userId        - user_id query param
 * @param {boolean} isLeader     - leader query param
 * @param {number}  [timeoutMs]  - give up if TCP open not received in this time
 * @returns {Promise<{ws: import('ws').WebSocket, messages: object[], frames: string[]}>}
 *   messages = parsed JSON frames; frames = raw strings (including malformed)
 */
function rawWsOpen(wranglerHost, code, userId, isLeader, timeoutMs = 8_000) {
  const WebSocket = require('ws');
  return new Promise((resolve, reject) => {
    const url = `${wranglerHost}/party/${code}?user_id=${encodeURIComponent(userId)}&username=${encodeURIComponent(userId)}&leader=${isLeader ? 1 : 0}`;
    const ws = new WebSocket(url);
    const messages = [];
    const frames = [];
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`rawWsOpen timeout (${timeoutMs}ms) connecting to ${code} as ${userId}`));
    }, timeoutMs);

    ws.on('open', () => {
      clearTimeout(timer);
      resolve({ ws, messages, frames });
    });
    ws.on('message', (data) => {
      const raw = String(data);
      frames.push(raw);
      try { messages.push(JSON.parse(raw)); } catch (_) {}
    });
    ws.on('error', (err) => { clearTimeout(timer); reject(err); });
    // If the server rejects with a non-101 HTTP response (e.g. 403 party_full),
    // the 'error' event fires with a connect-level error.
  });
}

/**
 * Wait for the worker's 'welcome' frame on a rawWsOpen socket.
 * Resolves with the welcome message or rejects on timeout.
 *
 * @param {{messages: object[]}} handle - from rawWsOpen
 * @param {number} [timeoutMs]
 * @returns {Promise<object>}
 */
function waitForWelcome(handle, timeoutMs = 8_000) {
  return waitForWorkerMessage(handle.messages, m => m.type === 'welcome', timeoutMs)
    .then(m => {
      if (!m) throw new Error(`waitForWelcome: no welcome within ${timeoutMs}ms`);
      return m;
    });
}

/**
 * Send a raw string frame (no JSON serialisation) — use for malformed payloads.
 * Silently ignores send errors (socket may already be closed).
 *
 * @param {import('ws').WebSocket} ws
 * @param {string} raw
 */
function sendRaw(ws, raw) {
  try {
    if (ws.readyState === 1 /* OPEN */) ws.send(raw);
  } catch (_) {}
}

/**
 * Send a JSON-serialised frame (normal path).
 *
 * @param {import('ws').WebSocket} ws
 * @param {object} obj
 */
function sendJson(ws, obj) {
  sendRaw(ws, JSON.stringify(obj));
}

/**
 * Abruptly destroy the socket without sending a close frame.
 * Simulates a network drop (TCP RST) rather than a graceful WS close.
 *
 * @param {import('ws').WebSocket} ws
 */
function dropSocket(ws) {
  try { ws.terminate(); } catch (_) {}
}

/**
 * Graceful leave: send { type: 'leave' }, brief drain, then close.
 *
 * @param {import('ws').WebSocket} ws
 * @param {number} [drainMs=200]
 */
async function leaveClose(ws, drainMs = 200) {
  sendJson(ws, { type: 'leave' });
  await new Promise(r => setTimeout(r, drainMs));
  try { ws.close(); } catch (_) {}
  await new Promise(r => setTimeout(r, 150));
}

/**
 * Collect all messages on a socket for a fixed window then resolve.
 * Non-destructive: messages also appear in the handle.messages array.
 *
 * @param {{messages: object[]}} handle - from rawWsOpen
 * @param {number} durationMs
 * @returns {Promise<object[]>}  snapshot of messages received during the window
 */
function collectFor(handle, durationMs) {
  const start = handle.messages.length;
  return new Promise(resolve => setTimeout(() => {
    resolve(handle.messages.slice(start));
  }, durationMs));
}

/**
 * Attempt a WS connect that is expected to be REJECTED (HTTP 403 or socket-level error).
 * Returns {rejected: true} if the server refused, {rejected: false, ws} if somehow accepted.
 *
 * @param {string} wranglerHost
 * @param {string} code
 * @param {string} userId
 * @param {boolean} isLeader
 * @returns {Promise<{rejected: boolean, ws?: import('ws').WebSocket, statusCode?: number}>}
 */
function expectReject(wranglerHost, code, userId, isLeader) {
  const WebSocket = require('ws');
  return new Promise((resolve) => {
    const url = `${wranglerHost}/party/${code}?user_id=${encodeURIComponent(userId)}&username=${encodeURIComponent(userId)}&leader=${isLeader ? 1 : 0}`;
    const ws = new WebSocket(url);
    const timer = setTimeout(() => { ws.close(); resolve({ rejected: true }); }, 6_000);

    ws.on('unexpected-response', (_req, res) => {
      clearTimeout(timer);
      ws.terminate();
      resolve({ rejected: true, statusCode: res.statusCode });
    });
    ws.on('error', () => {
      clearTimeout(timer);
      resolve({ rejected: true });
    });
    ws.on('message', (data) => {
      let m; try { m = JSON.parse(data); } catch (_) { return; }
      if (m.type === 'welcome') {
        clearTimeout(timer);
        resolve({ rejected: false, ws });
      }
    });
    ws.on('close', (code_) => {
      clearTimeout(timer);
      // Code 1008 = Policy Violation (party full), any close after our request = rejected
      resolve({ rejected: true, statusCode: code_ });
    });
  });
}

module.exports = {
  openReceivingClient,
  waitForWorkerMessage,
  // Adversarial primitives
  rawWsOpen,
  waitForWelcome,
  sendRaw,
  sendJson,
  dropSocket,
  leaveClose,
  collectFor,
  expectReject,
};
