// Unit tests for the pure dashboard analytics helpers (node:test, zero-dep).
// Run: cd workers/party && node --test test/dashboard_analytics.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mapTopBosses,
  fillDailySeries,
  mapPartySizeDist,
  mapContentMix,
  bucketDamage,
  computeHitQuality,
  buildAnalyticsBlock,
} from "../src/dashboard_analytics.js";

// --- Task 1: mapTopBosses ---
test("mapTopBosses maps rows and drops null boss_name", () => {
  const rows = [
    { boss_name: "Daigon", n: 41, dmg: 999 },
    { boss_name: null, n: 5, dmg: 10 },
  ];
  assert.deepEqual(mapTopBosses(rows), [{ boss: "Daigon", count: 41, boss_damage: 999 }]);
});

test("mapTopBosses on empty input returns []", () => {
  assert.deepEqual(mapTopBosses([]), []);
});

// --- Task 2: fillDailySeries ---
test("fillDailySeries zero-fills gaps and is ascending", () => {
  const now = Date.parse("2026-06-03T12:00:00Z");
  const rows = [
    { day: "2026-06-01", n: 4 },
    { day: "2026-06-03", n: 7 },
  ];
  assert.deepEqual(fillDailySeries(rows, now, 3), [
    { day: "2026-06-01", count: 4 },
    { day: "2026-06-02", count: 0 },
    { day: "2026-06-03", count: 7 },
  ]);
});

// --- Task 3: mapPartySizeDist + mapContentMix ---
test("mapPartySizeDist sorts ascending by size", () => {
  const rows = [{ party_size: 4, n: 9 }, { party_size: 2, n: 3 }];
  assert.deepEqual(mapPartySizeDist(rows), [{ size: 2, count: 3 }, { size: 4, count: 9 }]);
});

test("mapContentMix passes through type/tier with counts", () => {
  const rows = [{ content_type: "dungeon", content_tier: "hard", n: 5 }];
  assert.deepEqual(mapContentMix(rows), [{ content_type: "dungeon", content_tier: "hard", count: 5 }]);
});

// --- Task 4: bucketDamage ---
test("bucketDamage builds N equal buckets over [0, max]", () => {
  const rows = [{ boss_damage: 0 }, { boss_damage: 50 }, { boss_damage: 100 }];
  const h = bucketDamage(rows, 2);
  assert.equal(h.max, 100);
  assert.equal(h.buckets.length, 2);
  // buckets are [0,50) and [50,100]; boundary value 50 lands in the upper bucket
  assert.equal(h.buckets[0].count, 1); // {0}
  assert.equal(h.buckets[1].count, 2); // {50, 100}
});

test("bucketDamage on empty input returns max 0, empty buckets", () => {
  assert.deepEqual(bucketDamage([], 2), { buckets: [], max: 0 });
});

// --- Task 5: computeHitQuality ---
test("computeHitQuality is hits-weighted and normalizes 0-100 source to 0-1", () => {
  // source rates are stored 0-100 (per the data convention); output is 0-1.
  const rows = [
    { detail: JSON.stringify({ quality: { hits: 100, crit_rate: 40, heavy_rate: 20, crit_heavy_rate: 10 } }) },
    { detail: JSON.stringify({ quality: { hits: 300, crit_rate: 20, heavy_rate: 10, crit_heavy_rate: 5 } }) },
  ];
  const q = computeHitQuality(rows);
  // weighted crit = (100*40 + 300*20)/400 = 25 (percent) -> /100 = 0.25
  assert.ok(Math.abs(q.crit_rate - 0.25) < 1e-9);
  assert.ok(q.crit_rate <= 1 && q.heavy_rate <= 1 && q.crit_heavy_rate <= 1);
});

test("computeHitQuality returns null when no quality present", () => {
  assert.equal(computeHitQuality([{ detail: "{}" }, { detail: null }]), null);
});

// --- Task 6: buildAnalyticsBlock ---
function fakeDB(map) {
  return {
    prepare(sql) {
      const key = Object.keys(map).find((k) => sql.includes(k));
      const results = key ? map[key] : [];
      return { bind: () => ({ all: async () => ({ results }) }) };
    },
  };
}

test("buildAnalyticsBlock assembles all sub-blocks", async () => {
  const now = Date.parse("2026-06-03T12:00:00Z");
  const env = {
    ANALYTICS_DB: fakeDB({
      "GROUP BY boss_name": [{ boss_name: "Daigon", n: 41, dmg: 9 }],
      "GROUP BY day": [{ day: "2026-06-03", n: 7 }],
      "COUNT(DISTINCT": [{ n: 12 }],
      "GROUP BY party_size": [{ party_size: 4, n: 9 }],
      "GROUP BY content_type": [{ content_type: "dungeon", content_tier: "hard", n: 5 }],
      "SELECT boss_damage": [{ boss_damage: 100 }],
      "SELECT detail": [{ detail: JSON.stringify({ quality: { hits: 10, crit_rate: 0.5, heavy_rate: 0, crit_heavy_rate: 0 } }) }],
    }),
  };
  const a = await buildAnalyticsBlock(env, now);
  assert.equal(a.top_bosses[0].boss, "Daigon");
  assert.equal(a.distinct_parties, 12);
  assert.equal(a.time_based, null);
  assert.equal(a.encounters_per_day.at(-1).day, "2026-06-03");
  assert.equal(a.window_days, 7);
});

test("buildAnalyticsBlock returns null when ANALYTICS_DB missing", async () => {
  assert.equal(await buildAnalyticsBlock({}, Date.now()), null);
});

test("buildAnalyticsBlock isolates a failing query", async () => {
  const env = {
    ANALYTICS_DB: {
      prepare(sql) {
        if (sql.includes("GROUP BY boss_name")) throw new Error("boom");
        return { bind: () => ({ all: async () => ({ results: [] }) }) };
      },
    },
  };
  const a = await buildAnalyticsBlock(env, Date.now());
  assert.deepEqual(a.top_bosses, []); // failed query -> empty, not thrown
  assert.equal(a.distinct_parties, 0);
});
