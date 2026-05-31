/**
 * feedback.js — KV-only feedback intake handler
 *
 * Exported handler: handleFeedback(request, env)
 * Route:           POST /feedback  (wired by main worker)
 * KV binding:      env.FEEDBACK_KV  (must be added to wrangler.toml by dispatcher)
 */

const ALLOWED_TYPES = new Set(["bug", "idea", "feedback"]);
const MAX_MESSAGE_LEN = 10_000;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

export async function handleFeedback(request, env) {
  // Handle CORS preflight
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  // Guard: KV binding unavailable
  if (!env.FEEDBACK_KV) {
    return json(503, { ok: false, error: "feedback storage unavailable" });
  }

  // Parse body defensively
  let body;
  try {
    const text = await request.text();
    body = JSON.parse(text);
  } catch {
    return json(400, { ok: false, error: "invalid JSON body" });
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return json(400, { ok: false, error: "body must be a JSON object" });
  }

  // Validate message
  const message = body.message;
  if (!message || typeof message !== "string" || message.trim().length === 0) {
    return json(400, { ok: false, error: "message is required and must be a non-empty string" });
  }
  if (message.length > MAX_MESSAGE_LEN) {
    return json(400, { ok: false, error: `message exceeds maximum length of ${MAX_MESSAGE_LEN} characters` });
  }

  // Normalize type — default to "feedback" if missing/invalid
  const rawType = body.type;
  const type = ALLOWED_TYPES.has(rawType) ? rawType : "feedback";

  // Optional fields
  const contact = typeof body.contact === "string" ? body.contact.slice(0, 500) : undefined;
  const context = body.context !== undefined ? body.context : undefined;

  // Build record
  const ref = crypto.randomUUID();
  const ts = new Date().toISOString();
  // Sortable key: fb:<ts padded-millis>:<ref>
  const millis = String(Date.now()).padStart(15, "0");
  const kvKey = `fb:${millis}:${ref}`;

  const record = {
    ref,
    ts,
    type,
    message,
    ...(contact !== undefined && { contact }),
    ...(context !== undefined && { context }),
    ua: request.headers.get("user-agent") || null,
  };

  try {
    await env.FEEDBACK_KV.put(kvKey, JSON.stringify(record));
  } catch (err) {
    return json(503, { ok: false, error: "failed to store feedback" });
  }

  return json(200, { ok: true, ref });
}
