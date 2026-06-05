// Turn a captured party-room EXPORT json into the flat segment list the recognizer eats.
//
// An export carries the room's encounter list in two places that we JOIN on encounter_id:
//   - ws_snapshot.encounters[]  -> boss, boss_category, started_at, total_damage, ended
//   - debug.encounters[]        -> submitters[], submission_count, detail_count
// (Neither alone is enough: ws_snapshot has the boss but not who posted; debug has the
//  posters but not the boss.)
//
// last_activity_at: PHASE 0 leaves this == started_at. Phase 1 will compute the real
// last-damage time from member_detail[id][uid].rotation (the per-hit log, which the video
// correction showed is the gap signal we actually want). The field exists now so the
// recognizer signature is Phase-1-ready.

import fs from 'node:fs';

export function loadExport(path) {
  return JSON.parse(fs.readFileSync(path, 'utf8'));
}

export function extractSegments(exp) {
  const ws = exp.ws_snapshot || {};
  const wsEnc = ws.encounters || [];
  const dbgEnc = (exp.debug && exp.debug.encounters) || [];

  // index submitters by encounter_id. submitters are {user_id, has_detail} objects -> keep
  // the user_id STRING so a Set dedupes to distinct posters (objects never dedupe).
  const subsById = new Map();
  for (const d of dbgEnc) {
    if (d && d.encounter_id != null) {
      const ids = (d.submitters || []).map((x) => (typeof x === 'string' ? x : x && x.user_id)).filter(Boolean);
      subsById.set(String(d.encounter_id), ids);
    }
  }

  const segments = wsEnc.map((e) => {
    const id = String(e.encounter_id);
    return {
      id,
      boss: e.boss || null,
      boss_category: e.boss_category || null,
      started_at: e.started_at || null,
      last_activity_at: e.started_at || null, // Phase 1: derive from rotation
      total_damage: e.total_damage || 0,
      ended: !!e.ended,
      submitters: subsById.get(id) || [],
    };
  });

  return {
    activeId: ws.active_encounter_id != null ? String(ws.active_encounter_id) : null,
    segments,
    raw: {
      total: segments.length,
      named: segments.filter((s) => s.boss).length,
      blank: segments.filter((s) => !s.boss).length,
    },
  };
}
