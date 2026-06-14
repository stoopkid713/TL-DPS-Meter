/**
 * dashboard_analytics.js — pure, runtime-free helpers that build the dashboard's
 * `analytics` block from the D1 `encounter_analytics` table.
 *
 * Split out from dashboard.js so the aggregation logic is unit-testable with node:test
 * (no Cloudflare/DOM deps). The only async piece, buildAnalyticsBlock, takes `env` and
 * runs each D1 query in its own try/catch so one failure can't break the whole block.
 *
 * D1 read API: env.ANALYTICS_DB.prepare(sql).bind(...).all() -> { results: [...] }.
 */

const WINDOW_DAYS = 7;   // rolling window for "current" aggregates
const SERIES_DAYS = 30;  // length of the daily encounters series

// --- pure row -> shape mappers ---------------------------------------------

export function mapTopBosses(rows) {
  return (rows || [])
    .filter((r) => r && r.boss_name != null)
    .map((r) => ({ boss: r.boss_name, count: Number(r.n) || 0, boss_damage: Number(r.dmg) || 0 }));
}

function dayKey(ms) {
  return new Date(ms).toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

export function fillDailySeries(rows, nowMs, days) {
  const byDay = new Map((rows || []).map((r) => [r.day, Number(r.n) || 0]));
  const out = [];
  const startMs = nowMs - (days - 1) * 86_400_000;
  for (let i = 0; i < days; i++) {
    const k = dayKey(startMs + i * 86_400_000);
    out.push({ day: k, count: byDay.get(k) || 0 });
  }
  return out;
}

export function mapPartySizeDist(rows) {
  return (rows || [])
    .map((r) => ({ size: Number(r.party_size) || 0, count: Number(r.n) || 0 }))
    .sort((a, b) => a.size - b.size);
}

export function mapContentMix(rows) {
  return (rows || []).map((r) => ({
    content_type: r.content_type ?? null,
    content_tier: r.content_tier ?? null,
    count: Number(r.n) || 0,
  }));
}

export function bucketDamage(rows, n = 12) {
  const vals = (rows || []).map((r) => Number(r.boss_damage) || 0);
  if (!vals.length) return { buckets: [], max: 0 };
  const max = Math.max(...vals);
  if (max <= 0) return { buckets: [{ lo: 0, hi: 0, count: vals.length }], max: 0 };
  const w = max / n;
  const buckets = Array.from({ length: n }, (_, i) => ({ lo: i * w, hi: (i + 1) * w, count: 0 }));
  for (const v of vals) {
    let idx = Math.floor(v / w);
    if (idx >= n) idx = n - 1; // max value lands in the last (inclusive) bucket
    buckets[idx].count++;
  }
  return { buckets, max };
}

export function computeHitQuality(rows) {
  let hits = 0, crit = 0, heavy = 0, critHeavy = 0;
  for (const r of rows || []) {
    let q = null;
    try { q = JSON.parse(r.detail || "null")?.quality || null; } catch (_) { q = null; }
    if (!q) continue;
    const h = Number(q.hits) || 0;
    if (h <= 0) continue;
    hits += h;
    crit += (Number(q.crit_rate) || 0) * h;
    heavy += (Number(q.heavy_rate) || 0) * h;
    critHeavy += (Number(q.crit_heavy_rate) || 0) * h;
  }
  if (hits <= 0) return null;
  return { crit_rate: crit / hits, heavy_rate: heavy / hits, crit_heavy_rate: critHeavy / hits };
}

// --- async assembler -------------------------------------------------------

async function q(env, sql, binds, mapper, fallback) {
  try {
    const { results } = await env.ANALYTICS_DB.prepare(sql).bind(...binds).all();
    return mapper(results || []);
  } catch (_) {
    return fallback;
  }
}

export async function buildAnalyticsBlock(env, nowMs) {
  if (!env || !env.ANALYTICS_DB) return null;
  const sinceWin = nowMs - WINDOW_DAYS * 86_400_000;
  const sinceSeries = nowMs - SERIES_DAYS * 86_400_000;

  const top_bosses = await q(env,
    "SELECT boss_name, COUNT(*) n, SUM(COALESCE(boss_damage,0)) dmg FROM encounter_analytics WHERE created_at >= ? AND boss_name IS NOT NULL GROUP BY boss_name ORDER BY n DESC LIMIT 10",
    [sinceWin], mapTopBosses, []);

  const epdRows = await q(env,
    "SELECT strftime('%Y-%m-%d', created_at/1000, 'unixepoch') day, COUNT(*) n FROM encounter_analytics WHERE created_at >= ? GROUP BY day",
    [sinceSeries], (r) => r, []);
  const encounters_per_day = fillDailySeries(epdRows, nowMs, SERIES_DAYS);

  const dpRows = await q(env,
    "SELECT COUNT(DISTINCT party_code_hash) n FROM encounter_analytics WHERE created_at >= ?",
    [sinceWin], (r) => r, []);
  const distinct_parties = Number(dpRows?.[0]?.n) || 0;

  const party_size_dist = await q(env,
    "SELECT party_size, COUNT(*) n FROM encounter_analytics WHERE created_at >= ? GROUP BY party_size",
    [sinceWin], mapPartySizeDist, []);

  const content_mix = await q(env,
    "SELECT content_type, content_tier, COUNT(*) n FROM encounter_analytics WHERE created_at >= ? GROUP BY content_type, content_tier ORDER BY n DESC",
    [sinceWin], mapContentMix, []);

  const damage_dist = await q(env,
    "SELECT boss_damage FROM encounter_analytics WHERE created_at >= ? AND boss_damage IS NOT NULL",
    [sinceWin], (r) => bucketDamage(r, 12), { buckets: [], max: 0 });

  const hit_quality = await q(env,
    "SELECT detail FROM encounter_analytics WHERE created_at >= ? AND detail IS NOT NULL",
    [sinceWin], computeHitQuality, null);

  return {
    window_days: WINDOW_DAYS,
    top_bosses,
    encounters_per_day,
    distinct_parties,
    party_size_dist,
    content_mix,
    damage_dist,
    hit_quality,
    time_based: null, // P3 / #56
  };
}
