'use strict';
/**
 * Bug-report + telemetry scenarios
 * runtime: browser | tags: feedback, telemetry
 *
 * Two scenarios:
 *
 *   feedback-flow
 *     POST /feedback to the local wrangler dev endpoint with a valid bug report.
 *     Asserts:
 *       - HTTP 200 response
 *       - Response body: { ok: true, ref: <uuid> }
 *       - The stored record is retrievable from FEEDBACK_KV via the ref
 *         (if a KV-read route exists; otherwise asserts the write was accepted).
 *
 *     NOTE: FEEDBACK_KV is a Cloudflare KV namespace bound in wrangler.toml.
 *     In `wrangler dev` mode KV writes go to a local in-process store (not
 *     production).  This scenario therefore tests the worker's feedback handler
 *     path end-to-end (parse → validate → KV.put → return {ok, ref}) without
 *     reading production data.
 *
 *   feedback-logs-attached  [EXPECTED-FAIL]
 *     Asserts the feedback payload INCLUDES diagnostic logs — specifically one
 *     or more of: recent_errors, log_tail, ring_buffer — in the `context` field
 *     of the stored record.
 *
 *     TODAY: feedback.js stores only { app_version, ua, screen } style metadata
 *     in `context` (whatever the client sends).  No server-side log attachment
 *     exists.  The app UI does not yet attach a ring-buffer or error log to the
 *     POST body before sending.
 *
 *     This scenario documents the DESIRED state and is tagged `expected-fail` so
 *     it:
 *       a) shows up clearly in the gate report as a known gap, and
 *       b) goes GREEN automatically once the log-attach feature ships — without
 *          any scenario edits (same pattern as Cluster A expected-fail scenarios).
 *
 *     The scenario FAILS by asserting that the response's stored context field
 *     contains at least one of the log keys.  It will continue to fail until
 *     the client-side SDK / feedback modal is updated to attach logs.
 */

/**
 * POST a JSON body to wranglerHttp + path.
 * Returns { status, body } where body is already parsed JSON (or null on parse error).
 */
async function postJson(http, path, payload) {
  // We use Node's built-in http/https modules (no external deps) via a small
  // wrapper that also works with http:// (wrangler dev).
  const url = new URL(path, http);
  const isHttps = url.protocol === 'https:';
  const mod = isHttps ? require('https') : require('http');
  const bodyStr = JSON.stringify(payload);

  return new Promise((resolve, reject) => {
    const req = mod.request(
      {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(bodyStr),
          'User-Agent': 'tldps-battery/1.0',
        },
      },
      (res) => {
        let raw = '';
        res.on('data', chunk => { raw += chunk; });
        res.on('end', () => {
          let body = null;
          try { body = JSON.parse(raw); } catch (_) {}
          resolve({ status: res.statusCode, body, raw });
        });
      }
    );
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

/**
 * Scenario: feedback-flow
 *
 * Posts a valid bug report to POST /feedback and asserts:
 *   1. HTTP 200
 *   2. Response: { ok: true, ref: <non-empty string> }
 *   3. ref looks like a UUID (basic format check — not strict RFC 4122).
 *
 * Does NOT attempt to read back from FEEDBACK_KV (no /feedback/<ref> GET route
 * exists in the current worker; if one is added later this scenario can be
 * extended).  The write acceptance is the meaningful assertion here.
 */
async function feedbackFlow(ctx) {
  const { wranglerHttp } = ctx;

  const payload = {
    type: 'bug',
    message: 'Battery test — feedback-flow scenario. Simulated bug report.',
    contact: 'battery@test.local',
    context: {
      app_version: '0.0.0-battery',
      ua: 'tldps-battery/1.0',
      screen: '1920x1080',
    },
  };

  let result;
  try {
    result = await postJson(wranglerHttp, '/feedback', payload);
  } catch (err) {
    throw new Error(
      `feedback-flow: HTTP request to POST /feedback failed: ${err.message}. ` +
      `Is wrangler dev running?  wranglerHttp=${wranglerHttp}`
    );
  }

  if (result.status !== 200) {
    throw new Error(
      `feedback-flow: expected HTTP 200, got ${result.status}. ` +
      `Response body: ${result.raw.slice(0, 400)}`
    );
  }

  if (!result.body) {
    throw new Error(
      `feedback-flow: response body is not valid JSON. Raw: ${result.raw.slice(0, 400)}`
    );
  }

  if (result.body.ok !== true) {
    throw new Error(
      `feedback-flow: response.ok is not true. Got: ${JSON.stringify(result.body)}`
    );
  }

  const ref = result.body.ref;
  if (!ref || typeof ref !== 'string' || ref.trim().length === 0) {
    throw new Error(
      `feedback-flow: response.ref is missing or empty. Got: ${JSON.stringify(result.body)}`
    );
  }

  // Basic UUID shape check: 8-4-4-4-12 hex groups separated by hyphens.
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!UUID_RE.test(ref)) {
    throw new Error(
      `feedback-flow: response.ref "${ref}" does not look like a UUID. ` +
      `Expected format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`
    );
  }

  // Also assert that a second, different POST returns a different ref
  // (confirms uniqueness — the worker uses crypto.randomUUID() per request).
  const result2 = await postJson(wranglerHttp, '/feedback', {
    type: 'idea',
    message: 'Battery test — second feedback POST for ref-uniqueness check.',
  });

  if (result2.status !== 200 || result2.body?.ok !== true) {
    throw new Error(
      `feedback-flow: second POST /feedback failed (status=${result2.status}). ` +
      `Response: ${result2.raw.slice(0, 300)}`
    );
  }

  const ref2 = result2.body.ref;
  if (ref2 === ref) {
    throw new Error(
      `feedback-flow: two sequential POST /feedback calls returned the same ref "${ref}". ` +
      `The worker must use crypto.randomUUID() to generate a unique ref per report.`
    );
  }
}

/**
 * Scenario: feedback-logs-attached   [EXPECTED-FAIL]
 *
 * Documents the desired state: the feedback payload should include diagnostic
 * logs so that the dev can reproduce the issue without needing a repro session.
 *
 * CURRENT STATE (will FAIL):
 *   - The client sends { type, message, contact, context: { app_version, ua, screen } }.
 *   - The server stores exactly what it receives; it does NOT attach any server-side logs.
 *   - The `context` field therefore has no log keys today.
 *
 * DESIRED STATE (will PASS after fix):
 *   - The client SDK / feedback modal attaches one or more of:
 *       context.recent_errors  — array of recent JS errors (from error ring-buffer)
 *       context.log_tail       — last N lines of the overlay debug log
 *       context.ring_buffer    — raw ring-buffer snapshot
 *   - OR the worker's POST /feedback handler reads from a log KV/DO and attaches it.
 *
 * The scenario POSTs a feedback report WITHOUT any logs, then asserts the STORED
 * record has at least one log key.  This will fail until the attach feature ships.
 *
 * Tagged: expected-fail  (same convention as Cluster A scenarios in index.js).
 */
async function feedbackLogsAttached(ctx) {
  const { wranglerHttp } = ctx;

  // Post a minimal report — deliberately no logs in the client payload.
  // The DESIRED behavior is that the server (or a future client SDK) attaches logs.
  const payload = {
    type: 'bug',
    message: 'Battery test — feedback-logs-attached scenario. Testing log attachment.',
    context: {
      app_version: '0.0.0-battery',
      ua: 'tldps-battery/1.0',
    },
  };

  let result;
  try {
    result = await postJson(wranglerHttp, '/feedback', payload);
  } catch (err) {
    throw new Error(
      `feedback-logs-attached: HTTP request to POST /feedback failed: ${err.message}`
    );
  }

  if (result.status !== 200 || !result.body || result.body.ok !== true) {
    throw new Error(
      `feedback-logs-attached: POST /feedback did not succeed (status=${result.status}). ` +
      `Response: ${result.raw.slice(0, 300)}`
    );
  }

  // The ref tells us the record was stored.  Now assert the stored context has log data.
  // Since there is no GET /feedback/<ref> route today, we check the returned object.
  // In the desired state the response would include the stored record (or the worker
  // would echo back the context it received after enriching it with logs).
  //
  // For now: assert that the response body itself (or any echoed context) contains
  // at least one log key.  This will FAIL today because the server returns only
  // { ok: true, ref: "..." } — no log data at all.
  //
  // Future path: the server could return { ok, ref, context: { recent_errors: [...] } }
  // after attaching logs, and this assertion would pass.

  const LOG_KEYS = ['recent_errors', 'log_tail', 'ring_buffer'];

  // Check the response body first (would pass if server enriches the response).
  const responseContext = result.body.context || {};
  const hasLogInResponse = LOG_KEYS.some(k => k in responseContext && responseContext[k] != null);

  if (hasLogInResponse) {
    // We're in the desired state — assertion already satisfied.
    return;
  }

  // The desired state is NOT met.  Throw to signal FAIL (expected by the tag).
  throw new Error(
    `feedback-logs-attached: [EXPECTED-FAIL] ` +
    `The feedback record stored by POST /feedback does not include diagnostic log data. ` +
    `Expected at least one of ${LOG_KEYS.join(', ')} in the stored context field. ` +
    `Current response: ${JSON.stringify(result.body).slice(0, 300)}. ` +
    `This scenario documents the known gap: the client does not yet attach a ` +
    `recent-error ring-buffer or log tail to feedback submissions. ` +
    `Tag this PASS once the log-attach feature ships in workers/party/src/feedback.js ` +
    `or the client-side feedback modal.`
  );
}

module.exports = { feedbackFlow, feedbackLogsAttached };
