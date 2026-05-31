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
};
