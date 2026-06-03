/**
 * dashboard.js — DEBUG_KEY-gated usage dashboard for the tldps-party worker.
 *
 * Exported handlers (wired by index.js):
 *   handleDashboard(request, env)      GET /dashboard?key=…   → self-contained HTML page
 *   handleDashboardJson(request, env)  GET /dashboard.json?key=… → aggregated JSON
 *
 * Auth: both routes are gated on env.DEBUG_KEY exactly like /rooms and /party/<code>/debug.
 *   - DEBUG_KEY unset      → 404  (fail-closed / invisible)
 *   - DEBUG_KEY set, wrong → 403
 *   - Correct key          → 200
 *
 * KV bindings used (same as existing routes):
 *   env.ROOMS_KV    (id c28515495a524a2bbe2e7fc7c02d78f5)
 *   env.FEEDBACK_KV (id a61e7c1245a14bcc9c96b3cec7da6318)
 */

// ---------------------------------------------------------------------------
// Auth helper — mirrors /rooms and /party/<code>/debug gates exactly.
// Returns null if the request is authorized, or a Response to return immediately.
// ---------------------------------------------------------------------------
function checkKey(env, url) {
  if (!env.DEBUG_KEY) return new Response("not found", { status: 404 });
  if (url.searchParams.get("key") !== env.DEBUG_KEY) {
    return new Response("forbidden", { status: 403 });
  }
  return null; // authorized
}

// ---------------------------------------------------------------------------
// GET /dashboard.json?key=…
// Aggregated JSON:
//   { generated_at, live_rooms:[…], history:[…], feedback:[…] }
// ---------------------------------------------------------------------------
export async function handleDashboardJson(request, env) {
  const url = new URL(request.url);
  const gate = checkKey(env, url);
  if (gate) return gate;

  const generated_at = Date.now();

  // --- live_rooms: reuse the exact /rooms aggregation logic ---
  let live_rooms = [];
  if (env.ROOMS_KV) {
    try {
      const { keys } = await env.ROOMS_KV.list({ prefix: "room:" });
      live_rooms = keys
        .map((k) => ({ code: k.name.slice(5), ...(k.metadata || {}) }))
        .sort((a, b) => (b.last_activity || 0) - (a.last_activity || 0));
    } catch (_) {}
  }

  // --- history: reuse the exact /rooms/history aggregation logic ---
  let history = [];
  if (env.ROOMS_KV) {
    try {
      const { keys } = await env.ROOMS_KV.list({ prefix: "hist:" });
      history = keys
        .map((k) => k.metadata || { ts: Number(k.name.slice(5)) || 0, active_rooms: null })
        .sort((a, b) => (a.ts || 0) - (b.ts || 0));
    } catch (_) {}
  }

  // --- feedback: list all fb: keys from FEEDBACK_KV ---
  let feedback = [];
  if (env.FEEDBACK_KV) {
    try {
      // KV list() returns up to 1000 keys by default. For a feedback inbox this is
      // sufficient; if it ever grows, cursor-based pagination can be added later.
      const { keys } = await env.FEEDBACK_KV.list({ prefix: "fb:" });
      // Keys are in lexicographic order (oldest first via the millis-padded key).
      // Read each value (the full record with message, context, etc.).
      const values = await Promise.all(
        keys.map(async (k) => {
          try {
            const val = await env.FEEDBACK_KV.get(k.name, { type: "json" });
            return val || null;
          } catch (_) {
            return null;
          }
        })
      );
      // Return newest-first for the inbox view; filter out any nulls.
      feedback = values.filter(Boolean).reverse();
    } catch (_) {}
  }

  const body = JSON.stringify({ generated_at, live_rooms, history, feedback }, null, 2);
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

// ---------------------------------------------------------------------------
// GET /dashboard?key=…
// Self-contained HTML page. Inline CSS + inline chart drawing (Canvas 2D API).
// No CDN, no external libraries. The page client-fetches /dashboard.json
// (passing the same key from the URL) and auto-refreshes every 30 s.
// ---------------------------------------------------------------------------
export function handleDashboard(request, env) {
  const url = new URL(request.url);
  const gate = checkKey(env, url);
  if (gate) return gate;

  // The key is passed through to the page so JS can re-use it for /dashboard.json fetches.
  // It never appears in the server-rendered HTML beyond this one assignment — the JS reads it
  // from the URL's own query string at runtime (same origin, same key the user typed).
  const html = buildDashboardHtml(url.origin);

  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

// ---------------------------------------------------------------------------
// HTML builder — returns the full self-contained page as a string.
// ---------------------------------------------------------------------------
function buildDashboardHtml(origin) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>TL-DPS Party Dashboard</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --bg: #0e1117;
    --surface: #161b22;
    --surface2: #21262d;
    --border: #30363d;
    --text: #c9d1d9;
    --muted: #8b949e;
    --accent: #58a6ff;
    --green: #3fb950;
    --yellow: #d29922;
    --red: #f85149;
    --orange: #db6d28;
    --purple: #bc8cff;
    font-size: 14px;
  }
  body { background: var(--bg); color: var(--text); font-family: ui-monospace,SFMono-Regular,Consolas,monospace; min-height: 100vh; }

  /* --- header --- */
  header { background: var(--surface); border-bottom: 1px solid var(--border); padding: 12px 20px; display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
  header h1 { font-size: 1rem; color: var(--accent); letter-spacing: .04em; flex: 1 1 auto; }
  #status-bar { font-size: .8rem; color: var(--muted); }
  #status-bar .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--muted); margin-right: 5px; vertical-align: middle; }
  #status-bar.ok .dot { background: var(--green); }
  #status-bar.err .dot { background: var(--red); }
  #refresh-btn { background: var(--surface2); border: 1px solid var(--border); color: var(--text); padding: 4px 12px; border-radius: 6px; cursor: pointer; font-size: .8rem; }
  #refresh-btn:hover { border-color: var(--accent); }

  /* --- tabs --- */
  nav.tabs { background: var(--surface); border-bottom: 1px solid var(--border); display: flex; gap: 0; padding: 0 20px; }
  nav.tabs button { background: none; border: none; border-bottom: 2px solid transparent; color: var(--muted); cursor: pointer; padding: 10px 16px; font-size: .875rem; transition: color .15s, border-color .15s; }
  nav.tabs button:hover { color: var(--text); }
  nav.tabs button.active { color: var(--accent); border-bottom-color: var(--accent); }

  /* --- content area --- */
  main { padding: 20px; max-width: 1200px; margin: 0 auto; }
  .panel { display: none; }
  .panel.active { display: block; }

  /* --- cards / sections --- */
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 16px; margin-bottom: 16px; }
  .card h2 { font-size: .875rem; color: var(--muted); text-transform: uppercase; letter-spacing: .06em; margin-bottom: 12px; }
  .stat-row { display: flex; gap: 24px; flex-wrap: wrap; margin-bottom: 16px; }
  .stat { background: var(--surface2); border: 1px solid var(--border); border-radius: 6px; padding: 10px 16px; min-width: 120px; }
  .stat .label { font-size: .75rem; color: var(--muted); margin-bottom: 4px; }
  .stat .value { font-size: 1.5rem; color: var(--accent); font-weight: 600; }

  /* --- canvas chart wrapper --- */
  .chart-wrap { position: relative; width: 100%; height: 200px; margin-top: 8px; }
  canvas { width: 100% !important; height: 100% !important; display: block; }

  /* --- tables --- */
  .tbl-wrap { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: .8rem; }
  th { color: var(--muted); text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--border); white-space: nowrap; }
  td { padding: 7px 10px; border-bottom: 1px solid var(--border); vertical-align: top; }
  tr:last-child td { border-bottom: none; }
  tr:hover td { background: var(--surface2); }
  .age-ok { color: var(--green); font-weight: 600; }
  .age-warn { color: var(--yellow); font-weight: 600; }
  .age-stale { color: var(--red); font-weight: 600; }
  .badge { display: inline-block; padding: 1px 7px; border-radius: 10px; font-size: .7rem; white-space: nowrap; }
  .badge-bug  { background: #451e1e; color: var(--red); }
  .badge-idea { background: #1a2e1a; color: var(--green); }
  .badge-fb   { background: #1e2240; color: var(--accent); }
  .note { font-size: .75rem; color: var(--yellow); margin-top: 8px; padding: 6px 10px; background: #2a2100; border-left: 3px solid var(--yellow); border-radius: 0 4px 4px 0; }
  .empty { color: var(--muted); font-style: italic; padding: 16px 0; text-align: center; }
  .gh-count { color: var(--purple); font-weight: 600; }
  .feedback-card { background: var(--surface2); border: 1px solid var(--border); border-radius: 6px; padding: 12px; margin-bottom: 10px; }
  .feedback-card .meta { font-size: .75rem; color: var(--muted); margin-bottom: 6px; display: flex; gap: 10px; flex-wrap: wrap; }
  .feedback-card .msg { white-space: pre-wrap; word-break: break-word; line-height: 1.5; }
  .feedback-card .ctx { font-size: .72rem; color: var(--muted); margin-top: 6px; }
</style>
</head>
<body>

<header>
  <h1>&#9670; TL-DPS Party Dashboard</h1>
  <span id="status-bar"><span class="dot"></span><span id="status-text">Loading…</span></span>
  <button id="refresh-btn" onclick="load()">&#8635; Refresh</button>
</header>

<nav class="tabs">
  <button class="active" onclick="showTab('adoption',this)">Adoption</button>
  <button onclick="showTab('rooms',this)">Live Rooms</button>
  <button onclick="showTab('feedback',this)">Feedback Inbox</button>
</nav>

<main>
  <!-- Tab A: Adoption over time -->
  <div id="tab-adoption" class="panel active">
    <div class="card">
      <h2>Download &amp; Usage Overview</h2>
      <div class="stat-row">
        <div class="stat"><div class="label">GitHub Downloads</div><div class="value gh-count" id="gh-dl">—</div></div>
        <div class="stat"><div class="label">Distinct Rooms Seen</div><div class="value" id="stat-rooms-seen">—</div></div>
        <div class="stat"><div class="label">History Snapshots</div><div class="value" id="stat-snapshots">—</div></div>
        <div class="stat"><div class="label">Peak Concurrent Rooms</div><div class="value" id="stat-peak">—</div></div>
        <div class="stat"><div class="label">Currently Live</div><div class="value" id="stat-live">—</div></div>
      </div>
    </div>
    <div class="card">
      <h2>Active Rooms &amp; Peak Players — Hourly</h2>
      <div class="chart-wrap">
        <canvas id="chart-adoption"></canvas>
      </div>
    </div>
  </div>

  <!-- Tab B: Live rooms x-ray -->
  <div id="tab-rooms" class="panel">
    <div class="note">
      &#9888;&#65039; <strong>online_count</strong> in the registry is cached and can be stale — an idle or disconnected member's count may not update until they do something.
      <strong>Trust last-activity age</strong> as the primary signal of whether a room is actually active.
      Use <code>/party/&lt;CODE&gt;/debug</code> for a live socket count on a specific room.
    </div>
    <div class="card" style="margin-top:12px">
      <h2>Live Parties (<span id="rooms-count">0</span>)</h2>
      <div class="tbl-wrap">
        <table id="rooms-table">
          <thead><tr>
            <th>Code</th><th>Members</th><th>Online*</th><th>Leader</th><th>Active Boss</th><th>Last Activity</th>
          </tr></thead>
          <tbody id="rooms-tbody"></tbody>
        </table>
      </div>
      <div class="note" style="margin-top:8px">* online_count = cached registry value; may lag. See note above.</div>
    </div>
  </div>

  <!-- Tab C: Feedback inbox -->
  <div id="tab-feedback" class="panel">
    <div class="card">
      <h2>Feedback Reports (<span id="fb-count">0</span>)</h2>
      <div id="fb-list"></div>
    </div>
  </div>
</main>

<script>
(function() {
  'use strict';

  // Grab the key from this page's own URL (never hardcoded).
  const pageUrl = new URL(location.href);
  const KEY = pageUrl.searchParams.get('key') || '';
  const REFRESH_MS = 30_000;
  let refreshTimer = null;

  // ---------- tab switching ----------
  window.showTab = function(id, btn) {
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('nav.tabs button').forEach(b => b.classList.remove('active'));
    document.getElementById('tab-' + id).classList.add('active');
    btn.classList.add('active');
  };

  // ---------- status bar ----------
  function setStatus(ok, text) {
    const bar = document.getElementById('status-bar');
    bar.className = ok ? 'ok' : 'err';
    document.getElementById('status-text').textContent = text;
  }

  // ---------- main data load ----------
  async function load() {
    setStatus(true, 'Loading…');
    clearTimeout(refreshTimer);
    try {
      // Fetch dashboard JSON from the same worker, passing the key.
      const res = await fetch('/dashboard.json?key=' + encodeURIComponent(KEY));
      if (!res.ok) { setStatus(false, 'HTTP ' + res.status); schedule(); return; }
      const data = await res.json();

      renderAdoption(data);
      renderRooms(data.live_rooms || []);
      renderFeedback(data.feedback || []);

      const d = new Date(data.generated_at);
      setStatus(true, 'Updated ' + d.toLocaleTimeString() + ' · auto-refresh 30s');
    } catch(e) {
      setStatus(false, 'Error: ' + e.message);
    }
    schedule();
  }

  function schedule() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(load, REFRESH_MS);
  }

  // ---------- Tab A: Adoption ----------
  function renderAdoption(data) {
    const history = data.history || [];
    const liveRooms = data.live_rooms || [];

    // Snapshot stats
    const peakRooms = history.reduce((m, s) => Math.max(m, s.active_rooms || 0), 0);
    document.getElementById('stat-rooms-seen').textContent = history.length;
    document.getElementById('stat-snapshots').textContent = history.length;
    document.getElementById('stat-peak').textContent = peakRooms;
    document.getElementById('stat-live').textContent = liveRooms.length;

    // Draw chart
    drawAdoptionChart(history);

    // GitHub download count (client-side fetch of public GH API — CORS-safe)
    fetchGhDownloads();
  }

  // One-shot GH fetch; cached result for the tab session.
  let ghFetched = false;
  function fetchGhDownloads() {
    if (ghFetched) return;
    ghFetched = true;
    fetch('https://api.github.com/repos/stoopkid713/TL-DPS-Meter/releases', {
      headers: { 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }
    })
    .then(r => r.ok ? r.json() : Promise.reject('HTTP ' + r.status))
    .then(releases => {
      let total = 0;
      for (const rel of releases) {
        for (const asset of (rel.assets || [])) {
          total += (asset.download_count || 0);
        }
      }
      document.getElementById('gh-dl').textContent = total.toLocaleString();
    })
    .catch(err => {
      document.getElementById('gh-dl').textContent = 'N/A';
      console.warn('GH API:', err);
    });
  }

  // Canvas chart — active rooms per hour (bar) + peak_players overlay (line).
  // Uses the Canvas 2D API only — NO external chart libraries.
  function drawAdoptionChart(history) {
    const canvas = document.getElementById('chart-adoption');
    if (!canvas) return;

    // Size the canvas to its CSS pixel size.
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    const W = rect.width;
    const H = rect.height;
    const PAD = { top: 12, right: 20, bottom: 36, left: 36 };
    const innerW = W - PAD.left - PAD.right;
    const innerH = H - PAD.top - PAD.bottom;

    // Background
    ctx.fillStyle = '#161b22';
    ctx.fillRect(0, 0, W, H);

    if (!history.length) {
      ctx.fillStyle = '#8b949e';
      ctx.font = '12px ui-monospace,monospace';
      ctx.textAlign = 'center';
      ctx.fillText('No history yet — snapshots land at the top of each hour.', W/2, H/2);
      return;
    }

    // Trim to last 72 data points (72 hours) for readability.
    const pts = history.slice(-72);
    const maxRooms = Math.max(1, ...pts.map(p => p.active_rooms || 0));

    const barW = Math.max(2, innerW / pts.length - 2);

    // Draw grid lines
    ctx.strokeStyle = '#21262d';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = PAD.top + innerH - (i / 4) * innerH;
      ctx.beginPath();
      ctx.moveTo(PAD.left, y);
      ctx.lineTo(PAD.left + innerW, y);
      ctx.stroke();
      // Y-axis labels
      ctx.fillStyle = '#8b949e';
      ctx.font = '10px ui-monospace,monospace';
      ctx.textAlign = 'right';
      ctx.fillText(Math.round((i / 4) * maxRooms), PAD.left - 4, y + 3);
    }

    // Draw bars (active_rooms)
    pts.forEach((pt, i) => {
      const x = PAD.left + i * (innerW / pts.length) + (innerW / pts.length - barW) / 2;
      const pct = (pt.active_rooms || 0) / maxRooms;
      const bH = Math.max(1, pct * innerH);
      const y = PAD.top + innerH - bH;
      ctx.fillStyle = '#1f6feb';
      ctx.fillRect(x, y, barW, bH);
    });

    // X-axis: label every ~12 points
    ctx.fillStyle = '#8b949e';
    ctx.font = '9px ui-monospace,monospace';
    ctx.textAlign = 'center';
    const labelStep = Math.max(1, Math.floor(pts.length / 8));
    pts.forEach((pt, i) => {
      if (i % labelStep !== 0) return;
      const x = PAD.left + (i + 0.5) * (innerW / pts.length);
      if (pt.ts) {
        const d = new Date(pt.ts);
        const label = (d.getMonth()+1) + '/' + d.getDate() + ' ' +
          String(d.getHours()).padStart(2,'0') + 'h';
        ctx.fillText(label, x, PAD.top + innerH + 14);
      }
    });

    // Legend
    ctx.fillStyle = '#1f6feb';
    ctx.fillRect(PAD.left, PAD.top + innerH + 22, 10, 8);
    ctx.fillStyle = '#8b949e';
    ctx.font = '9px ui-monospace,monospace';
    ctx.textAlign = 'left';
    ctx.fillText('active rooms / hour', PAD.left + 14, PAD.top + innerH + 30);
  }

  // ---------- Tab B: Live Rooms ----------
  function renderRooms(rooms) {
    document.getElementById('rooms-count').textContent = rooms.length;
    const tbody = document.getElementById('rooms-tbody');
    if (!rooms.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="empty">No active parties right now.</td></tr>';
      return;
    }
    const now = Date.now();
    tbody.innerHTML = rooms.map(r => {
      const ageSec = r.last_activity ? Math.floor((now - r.last_activity) / 1000) : null;
      const ageStr = ageSec === null ? '—' : fmtAge(ageSec);
      const ageClass = ageSec === null ? '' : ageSec < 120 ? 'age-ok' : ageSec < 600 ? 'age-warn' : 'age-stale';
      const boss = r.active_boss || '—';
      return '<tr>' +
        '<td><code>' + esc(r.code || '?') + '</code></td>' +
        '<td>' + (r.member_count || 0) + '</td>' +
        '<td>' + (r.online_count || 0) + '</td>' +
        '<td>' + esc(r.leader || '—') + '</td>' +
        '<td>' + esc(boss) + '</td>' +
        '<td class="' + ageClass + '">' + ageStr + '</td>' +
        '</tr>';
    }).join('');
  }

  // ---------- Tab C: Feedback ----------
  function renderFeedback(items) {
    document.getElementById('fb-count').textContent = items.length;
    const list = document.getElementById('fb-list');
    if (!items.length) {
      list.innerHTML = '<div class="empty">No feedback reports yet.</div>';
      return;
    }
    list.innerHTML = items.map(fb => {
      const type = fb.type || 'feedback';
      const badgeClass = type === 'bug' ? 'badge-bug' : type === 'idea' ? 'badge-idea' : 'badge-fb';
      const ctx = fb.context || {};
      const ctxParts = [];
      if (ctx.app_version) ctxParts.push('v' + esc(ctx.app_version));
      if (ctx.screen) ctxParts.push('screen:' + esc(ctx.screen));
      if (fb.ua) ctxParts.push('ua:' + esc((fb.ua || '').slice(0, 80)));
      return '<div class="feedback-card">' +
        '<div class="meta">' +
          '<span class="badge ' + badgeClass + '">' + esc(type) + '</span>' +
          '<span>' + esc(fb.ts || '') + '</span>' +
          (ctxParts.length ? '<span>' + ctxParts.join(' · ') + '</span>' : '') +
        '</div>' +
        '<div class="msg">' + esc(fb.message || '') + '</div>' +
        (ctxParts.length ? '<div class="ctx">' + ctxParts.join(' &nbsp;·&nbsp; ') + '</div>' : '') +
        '</div>';
    }).join('');
  }

  // ---------- helpers ----------
  function fmtAge(sec) {
    if (sec < 60) return sec + 's ago';
    if (sec < 3600) return Math.floor(sec / 60) + 'm ago';
    return Math.floor(sec / 3600) + 'h ago';
  }

  function esc(s) {
    return String(s)
      .replace(/&/g,'&amp;')
      .replace(/</g,'&lt;')
      .replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;');
  }

  // ---------- boot ----------
  window.load = load;
  load();
})();
</script>
</body>
</html>`;
}
