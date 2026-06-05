#!/usr/bin/env node
// Encounter-combine GRADER.
//
//   node tests/encounter-combine/grade.mjs            # grade every answer key
//   node tests/encounter-combine/grade.mjs zuy5-difficult   # grade one
//
// Loads a captured run -> runs the recognizer -> scores its grouping against the run's
// answer key -> prints PASS/FAIL per check and an overall verdict. Exit 0 = all green.
//
// The big run exports are LOCAL ONLY (not in the repo). Point the grader at them with
//   TLDPS_CAPTURE_DIR=/path/to/captures   (default: the Desktop "TL-DPS Debug" folder)
// A run whose export is missing is SKIPPED, not failed.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractSegments, loadExport } from './lib/extract.mjs';
import { groupSegments } from './lib/recognizer.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KEYS_DIR = path.join(HERE, 'answer-keys');
const CAPTURE_DIR = process.env.TLDPS_CAPTURE_DIR || 'C:/Users/Admin/Desktop/TL-DPS Debug';

const C = { red: '\x1b[31m', grn: '\x1b[32m', dim: '\x1b[2m', yel: '\x1b[33m', rst: '\x1b[0m', bold: '\x1b[1m' };
const ok = (b) => (b ? `${C.grn}PASS${C.rst}` : `${C.red}FAIL${C.rst}`);

function gradeRun(key) {
  const exportPath = path.join(CAPTURE_DIR, key.source_export);
  if (!fs.existsSync(exportPath)) {
    return { run: key.run, skipped: true, reason: `export not found: ${exportPath}` };
  }

  const { segments, activeId } = extractSegments(loadExport(exportPath));
  const groups = groupSegments(segments);
  const strict = key.video_verified === true;
  const tol = (key.tolerance && key.tolerance.group_count) || 0;

  const checks = [];

  // C2 — blanks suppressed (the active/live encounter is allowed to be blank).
  const blankGroups = groups.filter((g) => g.is_blank && !g.segment_ids.includes(activeId));
  checks.push({
    name: 'blanks suppressed',
    pass: blankGroups.length === 0,
    detail: `${blankGroups.length} blank group(s) left (want 0)`,
  });

  // C3 — each boss family collapses to the expected number of fights.
  for (const [fam, expCount] of Object.entries(key.expected_groups_by_family)) {
    const actual = groups.filter((g) => g.family === fam).length;
    const pass = strict ? actual === expCount : actual >= 1 && actual <= expCount + tol;
    checks.push({
      name: `family "${fam}" -> ${strict ? '' : '≈'}${expCount} fight(s)`,
      pass,
      detail: `got ${actual}`,
    });
  }

  // C4 — scatter resolution: across a boss family's group(s), every active poster is
  // represented (none lost to scatter). Measured as the union over all the family's groups,
  // so a legit multi-pull boss (different roster per pull) isn't penalized — consolidation
  // itself is the family-count check above.
  for (const [fam, expCount] of Object.entries(key.expected_groups_by_family)) {
    void expCount;
    const famGroups = groups.filter((g) => g.family === fam);
    if (!famGroups.length) continue;
    const union = new Set();
    famGroups.forEach((g) => g.submitters.forEach((u) => union.add(u)));
    const n = union.size;
    // a boss can have fewer active posters than the party (someone dark/absent for THAT boss);
    // an optional per-family override records that truth instead of the party-wide default.
    const exp = (key.expected_union_by_family && key.expected_union_by_family[fam]) ?? key.expected_union_submitters;
    const pass = strict ? n === exp : n >= exp;
    checks.push({
      name: `family "${fam}" posters -> ${strict ? '' : '≥'}${exp}`,
      pass,
      detail: `got ${n}`,
    });
  }

  const namedGroups = groups.filter((g) => !g.is_blank).length;
  const passed = checks.every((c) => c.pass);
  return { run: key.run, skipped: false, strict, namedGroups, expectedFights: key.expected_total_fights, checks, passed };
}

// ---- run -------------------------------------------------------------------------------
const only = process.argv[2];
const keyFiles = fs.readdirSync(KEYS_DIR).filter((f) => f.endsWith('.json') && (!only || f === `${only}.json`));
if (!keyFiles.length) {
  console.error(`No answer keys matched${only ? ` "${only}"` : ''} in ${KEYS_DIR}`);
  process.exit(2);
}

console.log(`\n${C.bold}Encounter-combine grader${C.rst}  ${C.dim}(captures: ${CAPTURE_DIR})${C.rst}\n`);

let anyFail = false, anyRan = false;
for (const f of keyFiles) {
  const key = JSON.parse(fs.readFileSync(path.join(KEYS_DIR, f), 'utf8'));
  const r = gradeRun(key);

  if (r.skipped) {
    console.log(`${C.yel}— SKIP${C.rst}  ${r.run}\n        ${C.dim}${r.reason}${C.rst}\n`);
    continue;
  }
  anyRan = true;
  const tag = r.strict ? '' : `${C.dim}(inferred key)${C.rst}`;
  console.log(`${r.passed ? C.grn + '● GREEN' : C.red + '● RED'}${C.rst}  ${C.bold}${r.run}${C.rst}  ${tag}`);
  console.log(`        fights: got ${r.namedGroups} named group(s), want ~${r.expectedFights}`);
  for (const c of r.checks) {
    console.log(`        ${ok(c.pass)}  ${c.name}  ${C.dim}(${c.detail})${C.rst}`);
  }
  console.log('');
  if (!r.passed) anyFail = true;
}

if (!anyRan) {
  console.log(`${C.yel}Nothing graded — no run exports found. Set TLDPS_CAPTURE_DIR.${C.rst}\n`);
  process.exit(0);
}
console.log(anyFail
  ? `${C.red}${C.bold}RESULT: RED${C.rst} — at least one run is not grouped correctly.\n`
  : `${C.grn}${C.bold}RESULT: GREEN${C.rst} — all runs grouped correctly.\n`);
process.exit(anyFail ? 1 : 0);
