#!/usr/bin/env node
// Tiny rule-tests for the recognizer — one per real moment from the captured runs, so each
// behavior is locked and can't silently regress. No framework; run with:
//   node tests/encounter-combine/rules.test.mjs
import { groupSegments, DEFAULTS } from './lib/recognizer.mjs';

const { PAUSE_MS, CEIL_MS } = DEFAULTS;
let pass = 0, fail = 0;
const seg = (id, boss, tSec, subs = ['a']) =>
  ({ id: String(id), boss, started_at: tSec * 1000, last_activity_at: tSec * 1000, total_damage: 1, submitters: subs });
function check(name, cond) {
  console.log(`  ${cond ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}`);
  cond ? pass++ : fail++;
}

// 1. Phase rename (different NAME, same family) glues into one fight — no name logic needed.
{
  const g = groupSegments([seg(1, 'Vulkan', 0), seg(2, 'Radeth', 100)]);
  check('radeth-glues: Vulkan -> Radeth = 1 fight', g.length === 1 && g[0].family === 'Constructs');
}
// 2. Boss transform glues (Calanthia -> Calanthia of Destruction).
{
  const g = groupSegments([seg(1, 'Calanthia', 0), seg(2, 'Calanthia of Destruction', 100)]);
  check('of-destruction-glues: Calanthia -> of Destruction = 1 fight', g.length === 1);
}
// 3. Short same-boss gap = mechanic pause -> glue, NO re-pull flag.
{
  const g = groupSegments([seg(1, 'Dragaryle', 0), seg(2, 'Dragaryle', (PAUSE_MS / 1000) - 5)]);
  check('mechanic-pause-glues: short gap = 1 fight, no flag', g.length === 1 && g[0].repull_flag === false);
}
// 4. Medium same-boss gap = ambiguous wipe -> glue but FLAG (glue-and-flag default).
{
  const mid = (PAUSE_MS / 1000) + (CEIL_MS / 1000) / 2;
  const g = groupSegments([seg(1, 'Dragaryle', 0), seg(2, 'Dragaryle', mid)]);
  check('dragaryle-wipe-glues-and-flags: medium gap = 1 fight, repull_flag', g.length === 1 && g[0].repull_flag === true);
}
// 5. Different boss families split, even back-to-back.
{
  const g = groupSegments([seg(1, 'Dragaryle', 0), seg(2, 'Vulkan', 10)]);
  check('different-boss-splits: Dragaryle | Vulkan = 2 fights', g.length === 2);
}
// 6. Same boss past the ceiling = a genuinely new fight (the early-Calanthia / re-clear case).
{
  const g = groupSegments([seg(1, 'Calanthia', 0), seg(2, 'Calanthia', (CEIL_MS / 1000) + 60)]);
  check('past-ceiling-splits: same boss, huge gap = 2 fights', g.length === 2);
}
// 7. Blank (no-boss) segments are dropped — they neither form a group nor bridge two fights.
{
  const blank = { id: 'b', boss: null, started_at: 30000, last_activity_at: 30000, total_damage: 9, submitters: ['x'] };
  const g = groupSegments([seg(1, 'Dragaryle', 0), blank, seg(2, 'Dragaryle', 60)]);
  check('blank-dropped: blank between hits = 1 fight, no blank group', g.length === 1 && !g.some((x) => x.is_blank));
}
// 8. Scatter resolves: staggered posters across same-fight segments union into one board.
{
  const g = groupSegments([seg(1, 'Radeth', 0, ['a']), seg(2, 'Radeth', 50, ['b', 'c'])]);
  check('scatter-resolves: union of posters across segments', g.length === 1 && g[0].submitters.size === 3);
}

console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m`);
process.exit(fail ? 1 : 0);
