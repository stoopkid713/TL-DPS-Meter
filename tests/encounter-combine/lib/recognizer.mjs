// Encounter-combine recognizer.
//
// Glues the many gap-split pieces of one boss fight back into one fight, using two signals
// that DON'T depend on capturing the whole raid's damage (see WORKSTREAM-ENCOUNTER-COMBINE):
//   1. boss-name relationship (the family map) — a rename to a known phase/co-boss is the
//      SAME fight (Vulkan/Zairos -> Radeth; Calanthia -> Calanthia of Destruction);
//   2. an idle-gap ceiling — separates a genuinely new fight of the same boss.
// Blanks (no-boss trash/downtime) are dropped. The ambiguous same-boss medium gap (a wipe
// that looks like a long pause) is glued-and-FLAGGED (repull_flag), per the chosen default.

// --- Boss family map (the seed of the Phase-1 "phase-map") -------------------------------
// Boss display name -> the logical FIGHT it belongs to. Phase transitions and dual bosses
// that are really ONE fight share a family, so a rename mid-fight (Vulkan/Zairos -> Radeth,
// Calanthia -> Calanthia of Destruction) does not look like a new fight. This is the small,
// hand-curated, generalizable table described in the build plan — same kind of static data
// as the shipped target-assignments catalog.
export const BOSS_FAMILY = {
  'Dragaryle': 'Dragaryle',                          // boss 1
  'Vulkan': 'Constructs',                            // boss 2 (dual boss -> Radeth phase)
  'Zairos': 'Constructs',
  'Radeth': 'Constructs',
  'Calanthia': 'Calanthia',                          // boss 3 (-> "of Destruction" phase)
  'Calanthia of Destruction': 'Calanthia',
};

export function familyOf(boss) {
  if (!boss) return null;
  return BOSS_FAMILY[boss] || boss;
}

// --- Tunables (ms). Tuned against the captured runs via the grader. --------------------
export const DEFAULTS = {
  PAUSE_MS: 60_000,   // <= this same-boss gap is a mechanic pause -> merge, no flag
  CEIL_MS: 300_000,   // same-boss gap beyond this = a new fight -> split
                      // (PAUSE..CEIL = ambiguous wipe-vs-long-pause -> merge + repull_flag)
};

// --- The recognizer ---------------------------------------------------------------------
// segments: [{ id, boss, boss_category, started_at, last_activity_at, total_damage, submitters[] }]
// returns:  [{ label, family, boss, segment_ids[], submitters:Set, total_damage, is_blank, repull_flag }]
export function groupSegments(segments, opts = {}) {
  const { PAUSE_MS, CEIL_MS } = { ...DEFAULTS, ...opts };
  const sorted = [...segments].sort((a, b) => (a.started_at || 0) - (b.started_at || 0));

  const groups = [];
  let cur = null;

  const lastActivity = (g) => g._segs.reduce((m, s) => Math.max(m, s.last_activity_at || s.started_at || 0), 0);
  const open = (s) => {
    cur = { _segs: [s], family: familyOf(s.boss), repull_flag: false };
    groups.push(cur);
  };

  for (const s of sorted) {
    if (!s.boss) continue;                          // drop blanks (trash/downtime) entirely
    if (!cur) { open(s); continue; }

    const sameFamily = cur.family === familyOf(s.boss);
    const gap = (s.started_at || 0) - lastActivity(cur);

    if (sameFamily && gap <= CEIL_MS) {
      cur._segs.push(s);                            // phase rename or pause/wipe of same boss
      if (gap > PAUSE_MS) cur.repull_flag = true;   // medium gap -> glued but flag possible re-pull
    } else {
      open(s);                                      // different boss, or same boss past the ceiling
    }
  }

  // Finalize: union submitters, sum damage, label by the highest-damage segment (usually the
  // final phase, e.g. "Calanthia of Destruction" / "Radeth").
  return groups.map((g) => {
    const submitters = new Set();
    let total = 0;
    let label = g._segs[0].boss;
    let best = -1;
    for (const s of g._segs) {
      (s.submitters || []).forEach((u) => submitters.add(u));
      total += s.total_damage || 0;
      if ((s.total_damage || 0) > best) { best = s.total_damage || 0; label = s.boss; }
    }
    return {
      label,
      family: g.family,
      boss: label,
      segment_ids: g._segs.map((s) => s.id),
      submitters,
      total_damage: total,
      is_blank: false,
      repull_flag: g.repull_flag,
    };
  });
}
