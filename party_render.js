// party_render.js — SINGLE SOURCE OF TRUTH for the party scoreboard's shared constants
// + formatters (F5 "light seam"). Edit HERE only.
//
// This file is INLINED into both surfaces at build time by build.py inline_party_render():
//   - index.html              (the main app — base party view)
//   - overlay/src/index.html  (the Tauri spectator overlay)
// ...inside a `@inject:party_render ... @end:party_render` region. The committed copies in
// those files are GENERATED from this one — never hand-edit the region; edit this file and the
// build (or `python build.py`'s inline step) refreshes both. A drift check asserts they match.
//
// Namespaced under `PartyRender` so it can be inlined into the base app WITHOUT colliding with
// the base's own app-wide `formatNumber`/`escapeHtml` globals (used by the solo meter too).
// The base view adopts the shared CATEGORY_LABELS; the overlay delegates its label map AND
// formatters here (it previously kept its own copies — that was the drift this kills).
//
// Phase 3 (per-skill drill-down, tabs) will grow this into the shared RENDER module — the seam
// is here now so that work lands in one place instead of being built twice.
const PartyRender = {
  // Pretty labels for the room's boss_category (server-side detected).
  CATEGORY_LABELS: {
    archboss: '👑 Archboss',
    field_boss: '🌍 Field Boss',
    world_boss: '🌍 World Boss',
    raid_boss: '⚔️ Raid Boss',
    dungeon_boss: '🏰 Dungeon Boss',
    boss: '💀 Boss',
    mini_boss: '☠️ Mini Boss',
    unknown: '🎯 Boss',
  },
  catLabel(cat) {
    return PartyRender.CATEGORY_LABELS[cat] || PartyRender.CATEGORY_LABELS.unknown;
  },
  // Plain grouped integer (e.g. 1,234,567). Used for DPS + the base view's damage column.
  fmtNum(n) {
    return Math.round(Number(n) || 0).toLocaleString();
  },
  // Compact damage (1.2M / 34.5K) — the overlay's tight layout.
  fmtDmg(n) {
    n = Number(n) || 0;
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return Math.round(n).toLocaleString();
  },
  escapeHtml(t) {
    const d = document.createElement('div');
    d.textContent = t == null ? '' : t;
    return d.innerHTML;
  },

  // ===== Phase 3 / C2 — shared member-drill-down render (skill table + rotation) =====
  // Both surfaces feed these the raw ``rotation`` hit list the room serves via
  // ``get_member_detail`` (solo-hit shape: {relative_time, skill, damage, is_crit,
  // is_heavy}). SELF-CONTAINED on purpose — no dependency on the base app's globals
  // (``groupBySkill`` / ``calculateRotationStats`` / ``formatNumber``), so the overlay
  // (which has only PartyRender) renders identically. Variant via ``opts.compact``.

  // Raw hits -> per-skill rows (mirrors the solo skill block + groupBySkill), damage desc.
  aggregateSkills(rotation) {
    const rows = {};
    let total = 0;
    (rotation || []).forEach((h) => {
      const name = (h && h.skill) || 'Unknown';
      const r = rows[name] || (rows[name] = { name: name, damage: 0, hits: 0, crits: 0, heavies: 0 });
      const dmg = Number(h && h.damage) || 0;
      r.damage += dmg; r.hits += 1;
      if (h && h.is_crit) r.crits += 1;
      if (h && h.is_heavy) r.heavies += 1;
      total += dmg;
    });
    const list = Object.keys(rows).map((k) => rows[k]).sort((a, b) => b.damage - a.damage);
    list.forEach((r) => {
      r.percent = total > 0 ? +(r.damage / total * 100).toFixed(1) : 0;
      r.crit_rate = r.hits > 0 ? +(r.crits / r.hits * 100).toFixed(1) : 0;
      r.heavy_rate = r.hits > 0 ? +(r.heavies / r.hits * 100).toFixed(1) : 0;
    });
    return list;
  },

  // 60s rotation stats (port of the solo ``calculateRotationStats``) — self-contained.
  rotationStats(rotation) {
    if (!rotation || !rotation.length) return null;
    const dps = {};
    for (let i = 0; i <= 60; i++) dps[i] = 0;
    rotation.forEach((h) => {
      const s = Math.floor((h && h.relative_time) || 0);
      if (s >= 0 && s <= 60) dps[s] += Number(h && h.damage) || 0;
    });
    const first = Math.floor((rotation[0] && rotation[0].relative_time) || 0);
    const last = Math.floor((rotation[rotation.length - 1] && rotation[rotation.length - 1].relative_time) || 0);
    let peak = 0;
    for (let i = 0; i <= 55; i++) {
      let sum = 0;
      for (let j = i; j < i + 5; j++) sum += dps[j] || 0;
      if (sum / 5 > peak) peak = sum / 5;
    }
    const active = Object.keys(dps).filter((i) => dps[i] > 0 && +i >= first && +i <= last).length;
    const totalSec = Math.max(1, last - first + 1);
    return { dpsPerSecond: dps, peakDps: peak, activityRate: active / totalSec * 100, firstHitTime: first, lastHitTime: last };
  },

  // Skill-table HTML for a member's rotation. ``opts.compact`` => overlay variant.
  skillTableHtml(rotation, opts) {
    opts = opts || {};
    const skills = PartyRender.aggregateSkills(rotation);
    if (!skills.length) return '<div class="pr-empty">No skill data</div>';
    let max = 1;
    skills.forEach((s) => { if (s.damage > max) max = s.damage; });
    const esc = PartyRender.escapeHtml;
    if (opts.compact) {
      // overlay: name · bar · compact dmg · %
      const rows = skills.map((s) => {
        const w = (s.damage / max * 100).toFixed(1);
        return '<div class="pr-skill-row">'
          + '<span class="pr-skill-name" title="' + esc(s.name) + '">' + esc(s.name) + '</span>'
          + '<span class="pr-skill-bar"><span style="width:' + w + '%"></span></span>'
          + '<span class="pr-skill-dmg">' + PartyRender.fmtDmg(s.damage) + '</span>'
          + '<span class="pr-skill-pct">' + s.percent + '%</span>'
          + '</div>';
      }).join('');
      return '<div class="pr-skill-list">' + rows + '</div>';
    }
    // base: full 9-col table mirroring the solo skill table (reuses the solo num/bar classes).
    const body = skills.map((s) => {
      const w = (s.damage / max * 100).toFixed(1);
      return '<tr><td>' + esc(s.name) + '</td>'
        + '<td class="num cyan">' + PartyRender.fmtNum(s.damage) + '</td>'
        + '<td><div class="damage-bar-container"><div class="damage-bar" style="width:' + w + '%"></div></div></td>'
        + '<td class="num">' + s.hits + '</td>'
        + '<td class="num yellow">' + s.crits + '</td>'
        + '<td class="num yellow">' + s.crit_rate + '%</td>'
        + '<td class="num orange">' + s.heavies + '</td>'
        + '<td class="num orange">' + s.heavy_rate + '%</td>'
        + '<td class="num purple">' + s.percent + '%</td></tr>';
    }).join('');
    return '<table class="pr-skill-table"><thead><tr>'
      + '<th>Skill</th><th>Damage</th><th></th><th>Hits</th><th>Crits</th><th>Crit%</th>'
      + '<th>Heavy</th><th>Heavy%</th><th>%</th></tr></thead><tbody>' + body + '</tbody></table>';
  },

  // Rotation chart HTML (61 one-second bars, 0..60s). ``opts.compact`` => overlay variant.
  rotationChartHtml(rotation, opts) {
    opts = opts || {};
    const stats = PartyRender.rotationStats(rotation);
    if (!stats) return '<div class="pr-empty">No rotation data</div>';
    let max = 1;
    for (let i = 0; i <= 60; i++) { if ((stats.dpsPerSecond[i] || 0) > max) max = stats.dpsPerSecond[i]; }
    let bars = '';
    for (let i = 0; i <= 60; i++) {
      const d = stats.dpsPerSecond[i] || 0;
      const h = max > 0 ? (d / max * 100) : 0;
      let cls = 'normal';
      if (d === 0 && i >= stats.firstHitTime && i <= stats.lastHitTime) cls = 'gap';
      bars += '<div class="pr-rot-bar ' + cls + '" style="height:' + Math.max(h, 1) + '%"></div>';
    }
    return '<div class="pr-rot">'
      + '<div class="pr-rot-meta">Activity ' + stats.activityRate.toFixed(0) + '% · Peak 5s '
        + PartyRender.fmtNum(Math.round(stats.peakDps)) + '</div>'
      + '<div class="pr-rot-chart' + (opts.compact ? ' compact' : '') + '">' + bars + '</div>'
      + '<div class="pr-rot-axis"><span>0s</span><span>15s</span><span>30s</span><span>45s</span><span>60s</span></div>'
      + '</div>';
  },
};
