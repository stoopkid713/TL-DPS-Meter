/**
 * gamedata.js — GET /skills handler for the tldps-party worker.
 *
 * Serves the derived skill->weapon assignments bundled from the repo-root
 * weapon_config.json at Wrangler build time (static import, NO KV, NO env binding).
 *
 * Route (wire in workers/party/src/index.js):
 *   GET /skills  ->  handleSkills(request, env)
 *
 * Response shape:
 *   {
 *     "version": <number>,
 *     "patch": <string|null>,
 *     "last_updated": <string|null>,
 *     "assignments": { "<skill name>": "<weapon slug>", ... }
 *   }
 *
 * CORS: permissive (* for all origins) on GET + OPTIONS preflight so the
 * TL-DPS-Meter desktop app and any web client can fetch this without CORS errors.
 * This is the cloud source the app's "Update" button fetches to refresh its
 * local skill->weapon map without requiring an app reinstall.
 */

import weaponConfig from "../../../weapon_config.json";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

/**
 * Handle GET /skills and OPTIONS /skills preflight.
 *
 * No env bindings are required — all data is bundled from weapon_config.json
 * at Wrangler build time via a static ESM import.
 *
 * @param {Request} request
 * @param {object} env   - Cloudflare Worker env (unused but required by the routing contract)
 * @returns {Response}
 */
export async function handleSkills(request, env) {
  // OPTIONS preflight — respond immediately so browsers don't block the real GET
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: CORS_HEADERS,
    });
  }

  // Only GET is meaningful here; anything else gets a 405
  if (request.method !== "GET") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { ...CORS_HEADERS, Allow: "GET, OPTIONS" },
    });
  }

  const body = JSON.stringify({
    version: weaponConfig.version ?? 1,
    patch: weaponConfig.patch ?? null,
    last_updated: weaponConfig.last_updated ?? null,
    assignments: weaponConfig.skillAssignments ?? {},
  });

  return new Response(body, {
    status: 200,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json; charset=utf-8",
      // Cache-Control: short-lived so clients get fresh data after a deploy but
      // don't hammer the worker on every page load.  The auto-refresh workflow
      // re-deploys weekly, so 1-hour client cache is plenty.
      "Cache-Control": "public, max-age=3600, s-maxage=3600",
    },
  });
}
