
        // Phase 2 (A5): repurpose the old Targets dropdown into the encounter switcher.
        // Lists every stored encounter (oldest-first), with a category icon, boss, time, and an
        // attempt ordinal (#1/#2) for duplicate bosses; the live/active one is marked ●.
        function renderEncounterSwitcher() {
            const sel = document.getElementById('partyTargetFilter');
            if (!sel) return;
            const list = partyState.encounters || [];
            if (!list.length) {
                sel.innerHTML = '<option value="">No encounters yet</option>';
                return;
            }
            // Count boss occurrences first so duplicates get ordinals.
            const totalByBoss = {};
            list.forEach((e) => { const k = (e.boss || '∅').toLowerCase(); totalByBoss[k] = (totalByBoss[k] || 0) + 1; });
            const seen = {};
            const activeId = partyState.active_encounter_id;
            sel.innerHTML = list.map((e) => {
                const k = (e.boss || '∅').toLowerCase();
                seen[k] = (seen[k] || 0) + 1;
                const ord = totalByBoss[k] > 1 ? ` #${seen[k]}` : '';
                const icon = PartyRender.catLabel(e.boss_category || 'unknown').split(' ')[0];
                const bossName = e.boss || 'Recording…';
                const t = e.started_at ? new Date(e.started_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
                const live = (e.encounter_id === activeId && !e.ended) ? ' ●' : '';
                const text = `${icon} ${bossName}${ord}${t ? ' · ' + t : ''}${live}`;
                return `<option value="${escapeHtml(e.encounter_id)}">${escapeHtml(text)}</option>`;
            }).join('');
            sel.value = partyState.viewing_encounter_id || activeId || '';
        }

        function onPartyEncounterChange() {
            const sel = document.getElementById('partyTargetFilter');
            if (!sel) return;
            partyState.viewing_encounter_id = sel.value || null;
            renderPartyResults();
        }

        // Phase 3 (C4): tab switching. Scoreboard is the live board (+ drill-down); the other
        // tabs are post-combat views that reuse the shared PartyRender renderers fed by the
        // member-detail payloads the room serves (same data path as C3 drill-down).
        function switchPartyTab(tab) {
            partyState.activeTab = tab;
            // Leaving a member drill-down when changing tabs (drill-down belongs to Scoreboard).
            if (tab !== 'scoreboard') partyState.detail = null;
            document.querySelectorAll('#partyTabStrip .party-tab').forEach((b) => {
                b.classList.toggle('active', b.dataset.ptab === tab);
            });
            renderPartyResults();
        }

        // The board (entries) for whichever encounter the UI is currently showing.
        function currentPartyBoard() {
            const viewId = partyState.viewing_encounter_id || partyState.active_encounter_id;
            if (viewId && partyState.boards[viewId]) return partyState.boards[viewId];
            if (!viewId) return partyState.scoreboard;
            return null;
        }

        // Ensure a member's detail is fetched (lazy) — used by Skills/Rotation/Compare tabs.
        // True if the room's board flags this member as having a stored breakdown for this
        // encounter (set the moment their fight FINALIZES). Gating fetches on this is what makes
        // the drill-down rate-safe + self-healing instead of caching an empty answer forever.
        function memberHasDetail(encounterId, userId) {
            const board = partyState.boards[encounterId]
                || (partyState.scoreboard && partyState.scoreboard.encounter_id === encounterId ? partyState.scoreboard : null);
            const e = board && Array.isArray(board.entries) ? board.entries.find((x) => x.user_id === userId) : null;
            return !!(e && e.has_detail);
        }

        // Event-driven, rate-safe drill-down fetch. Requests ONLY when the server says the
        // member's breakdown exists (has_detail) and we haven't already received a response.
        // The scoreboard is re-broadcast the instant has_detail flips true, which re-renders and
        // calls this again → exactly ONE fetch per member, fired when the data lands. No polling,
        // and we never cache an empty "still in combat" answer that could get stuck on "Loading…".
        function ensureMemberDetail(encounterId, userId) {
            if (!encounterId || !userId) return;
            const key = `${encounterId}:${userId}`;
            if (partyState.memberDetails[key]) return;          // already received a response
            if (!memberHasDetail(encounterId, userId)) return;  // no breakdown stored yet (still fighting) — wait
            if (!partyState.detailPending) partyState.detailPending = new Set();
            if (partyState.detailPending.has(key)) return;      // request already in flight
            if (!(partyWS && partyWS.readyState === WebSocket.OPEN)) return;
            partyState.detailPending.add(key);
            try {
                partyWS.send(JSON.stringify({ type: 'get_member_detail', encounter_id: encounterId, user_id: userId }));
                partyDebug('party.member_detail.request', { encounter_id: encounterId, user_id: userId, via: partyState.activeTab });
            } catch (e) { console.warn('[Party] get_member_detail failed:', e); partyState.detailPending.delete(key); }
        }

        function rotationFor(encounterId, userId) {
            const d = partyState.memberDetails[`${encounterId}:${userId}`];
            return (d && d.rotation) || null;
        }

        function renderPartyResults() {
            const container = document.getElementById('partyResultsContainer');
            // Phase 3 (C4): route non-scoreboard tabs to their own renderers.
            const tab = partyState.activeTab || 'scoreboard';
            if (tab === 'skills')   { renderPartySkillsTab();   return; }
            if (tab === 'rotation') { renderPartyRotationTab(); return; }
            if (tab === 'compare')  { renderPartyCompareTab();  return; }
            if (tab === 'history')  { renderPartyHistoryTab();  return; }
            // Phase 3 (C3): if drilled into a member, render their detail panel instead of the board.
            if (partyState.detail) { renderMemberDetail(); return; }
            // Resolve which encounter's board to show: the explicitly-viewed one, else the active.
            const viewId = partyState.viewing_encounter_id || partyState.active_encounter_id;
            let sb;
            if (viewId && partyState.boards[viewId]) {
                sb = partyState.boards[viewId];
            } else if (!viewId) {
                sb = partyState.scoreboard; // following active before any explicit selection
            } else {
                // A past encounter we have no cached board for (e.g. joined after it ended).
                const meta = (partyState.encounters || []).find((e) => e.encounter_id === viewId);
                container.innerHTML = `
                    <div class="party-empty-state">
                        <div class="party-empty-icon">📊</div>
                        <div class="party-empty-title">${meta && meta.boss ? escapeHtml(meta.boss) : 'Encounter'}</div>
                        <div class="party-empty-text">Detailed board not available — you weren't connected during this encounter.${meta ? ` (${meta.entries_n || 0} members · ${formatNumber(meta.total_damage || 0)} total)` : ''}</div>
                    </div>
                `;
                return;
            }
            const entries = (sb && Array.isArray(sb.entries)) ? sb.entries : [];

            if (entries.length === 0) {
                container.innerHTML = `
                    <div class="party-empty-state">
                        <div class="party-empty-icon">📊</div>
                        <div class="party-empty-title">${partyState.encounter_active ? 'Recording...' : 'No Results Yet'}</div>
                        <div class="party-empty-text">${partyState.encounter_active ? 'Boss damage appears when members exit combat' : 'Start an encounter to see the boss scoreboard'}</div>
                    </div>
                `;
                return;
            }

            // The room already chose THE BOSS, filtered trash, ranked members, and computed
            // each member's contribution %. We just render the one boss section.
            const bossName = escapeHtml(sb.boss || 'Boss');
            const catLabel = PartyRender.catLabel(sb.boss_category);
            const totalDamage = sb.total_damage || 0;
            const encId = sb.encounter_id;

            const rowsHtml = entries.map((e) => {
                const isYou = e.user_id === partyState.user_id;
                const color = getPlayerColor(e.user_id);
                // Fix #2: ALL rows are always clickable — no has_detail gate.
                // On click we request get_member_detail and show a loading state until it arrives.
                const drillAttrs = ` onclick="openPartyMemberDetail('${encId}','${e.user_id}')" title="View skill breakdown"`;
                return PartyRender.scoreboardRowHtml(e, totalDamage, {
                    isYou: isYou,
                    color: color,
                    drillAttrs: drillAttrs,
                    compact: false,
                });
            }).join('');

            container.innerHTML = `
                <div class="party-target-section" data-target="${bossName}">
                    <div class="party-target-header">
                        <span>${catLabel}</span>
                        <span class="party-target-name">${bossName}</span>
                        <span class="party-target-total">${formatNumber(totalDamage)} total</span>
                    </div>
                    <div class="party-results-bars">
                        ${rowsHtml}
                    </div>
                </div>
            `;
        }

        // ===== Phase 3 (C3) — member drill-down (skill table + rotation chart) =====
        // Click a drillable board row -> lazily fetch that member's per-hit detail from the
        // room (get_member_detail) -> render a solo-style skill table + rotation chart using
        // the shared PartyRender module. Back returns to the board.
        function openPartyMemberDetail(encounterId, userId) {
            // Resolve the member's display name from the board we're showing.
            const board = partyState.boards[encounterId]
                || (partyState.scoreboard && partyState.scoreboard.encounter_id === encounterId ? partyState.scoreboard : null);
            const entry = board && Array.isArray(board.entries)
                ? board.entries.find((x) => x.user_id === userId) : null;
            partyState.detail = {
                encounter_id: encounterId,
                user_id: userId,
                username: (entry && entry.username) || 'Member',
            };
            // Fetch via the rate-safe, has_detail-gated path; the member_detail handler re-renders on arrival.
            ensureMemberDetail(encounterId, userId);
            renderMemberDetail();
        }

        function closePartyMemberDetail() {
            partyState.detail = null;
            renderPartyResults();
        }

        function renderMemberDetail() {
            const container = document.getElementById('partyResultsContainer');
            const d = partyState.detail;
            if (!d) { renderPartyResults(); return; }
            const key = `${d.encounter_id}:${d.user_id}`;
            const detail = partyState.memberDetails[key];
            const header = `
                <div class="party-detail-header">
                    <button class="party-detail-back" onclick="closePartyMemberDetail()">← Back</button>
                    <span class="party-detail-name">${escapeHtml(d.username)}</span>
                </div>`;
            if (!detail) {
                // No response yet: "Loading" only if the server has it (fetching); otherwise the
                // member is still in combat — say so instead of a forever-"Loading…".
                const fetching = memberHasDetail(d.encounter_id, d.user_id);
                const inner = fetching
                    ? `<div class="party-empty-icon">⏳</div><div class="party-empty-text">Loading breakdown…</div>`
                    : `<div class="party-empty-icon">⚔️</div><div class="party-empty-text">No breakdown yet — this member's fight hasn't ended. Updates automatically when it does.</div>`;
                container.innerHTML = header + `<div class="party-empty-state">${inner}</div>`;
                return;
            }
            const rotation = detail.rotation || [];
            if (!rotation.length) {
                container.innerHTML = header + `<div class="party-empty-state"><div class="party-empty-icon">📊</div><div class="party-empty-text">No detailed breakdown for this member (older client or no hits recorded).</div></div>`;
                return;
            }
            container.innerHTML = header
                + `<div class="party-detail-body">`
                + `<div class="party-detail-section"><div class="party-detail-section-title">Skills</div>${PartyRender.skillTableHtml(rotation)}</div>`
                + `<div class="party-detail-section"><div class="party-detail-section-title">Rotation</div>${PartyRender.rotationChartHtml(rotation)}</div>`
                + `</div>`;
        }

        // ===== Phase 3 (C4) — tab renderers (Skills / Rotation / Compare / History) =====
        // Build the <option> list of all members on the viewed board.
        // Fix #2: no longer filtered to has_detail — all members are drillable (detail fetched on click).
        function partyMemberOptions(board, selected) {
            const entries = (board && Array.isArray(board.entries)) ? board.entries : [];
            const opts = ['<option value="">— pick member —</option>'].concat(
                entries.map((e) => `<option value="${escapeHtml(e.user_id)}"${e.user_id === selected ? ' selected' : ''}>${escapeHtml(e.username)}</option>`)
            );
            return opts.join('');
        }

        // A single-member skill OR rotation view, with a member picker. ``kind`` = 'skills'|'rotation'.
        function renderPartySingleMemberTab(kind) {
            const container = document.getElementById('partyResultsContainer');
            const board = currentPartyBoard();
            // Fix #2: show all members (not just has_detail); detail is fetched on demand.
            const entries = (board && Array.isArray(board.entries)) ? board.entries : [];
            const sel = partyState[kind === 'skills' ? 'skillsMember' : 'rotationMember'];
            // Default to the top (rank-1) drillable member.
            const chosen = (sel && entries.some((e) => e.user_id === sel)) ? sel : (entries[0] && entries[0].user_id) || null;
            if (kind === 'skills') partyState.skillsMember = chosen; else partyState.rotationMember = chosen;

            if (!entries.length) {
                container.innerHTML = `<div class="party-empty-state"><div class="party-empty-icon">📊</div><div class="party-empty-text">No member breakdowns available for this encounter yet.</div></div>`;
                return;
            }
            const encId = board.encounter_id;
            const picker = `<div class="party-cmp-pickers">
                <span class="pr-cmp-vs-lbl">Member</span>
                <select onchange="onPartySingleMemberChange('${kind}', this.value)">${partyMemberOptions(board, chosen)}</select>
            </div>`;
            ensureMemberDetail(encId, chosen);
            const rotation = rotationFor(encId, chosen);
            let body;
            if (rotation && rotation.length) {
                body = kind === 'skills' ? PartyRender.skillTableHtml(rotation) : PartyRender.rotationChartHtml(rotation);
            } else if (rotation) {
                body = `<div class="pr-empty">No detailed breakdown for this member.</div>`;
            } else if (memberHasDetail(encId, chosen)) {
                body = `<div class="party-empty-state"><div class="party-empty-icon">⏳</div><div class="party-empty-text">Loading breakdown…</div></div>`;
            } else {
                body = `<div class="party-empty-state"><div class="party-empty-icon">⚔️</div><div class="party-empty-text">No breakdown yet — this member's fight hasn't ended. Updates automatically.</div></div>`;
            }
            container.innerHTML = picker + `<div class="party-detail-body">${body}</div>`;
        }

        function onPartySingleMemberChange(kind, userId) {
            if (kind === 'skills') partyState.skillsMember = userId || null;
            else partyState.rotationMember = userId || null;
            renderPartyResults();
        }

        function renderPartySkillsTab()   { renderPartySingleMemberTab('skills'); }
        function renderPartyRotationTab() { renderPartySingleMemberTab('rotation'); }

        function renderPartyCompareTab() {
            const container = document.getElementById('partyResultsContainer');
            const board = currentPartyBoard();
            // Fix #2: show all members; detail fetched on demand.
            const entries = (board && Array.isArray(board.entries)) ? board.entries : [];
            if (entries.length < 2) {
                container.innerHTML = `<div class="party-empty-state"><div class="party-empty-icon">⚖️</div><div class="party-empty-text">Need at least two members to compare.</div></div>`;
                return;
            }
            const encId = board.encounter_id;
            // Default A/B to the top two drillable members if unset / stale.
            const ids = entries.map((e) => e.user_id);
            if (!ids.includes(partyState.compare.a)) partyState.compare.a = entries[0].user_id;
            if (!ids.includes(partyState.compare.b) || partyState.compare.b === partyState.compare.a) {
                partyState.compare.b = (entries.find((e) => e.user_id !== partyState.compare.a) || entries[1]).user_id;
            }
            const a = partyState.compare.a, b = partyState.compare.b;
            const nameOf = (uid) => { const e = entries.find((x) => x.user_id === uid); return e ? e.username : uid; };

            ensureMemberDetail(encId, a);
            ensureMemberDetail(encId, b);
            const rotA = rotationFor(encId, a), rotB = rotationFor(encId, b);

            const pickers = `<div class="party-cmp-pickers">
                <select onchange="onPartyCompareChange('a', this.value)">${partyMemberOptions(board, a)}</select>
                <span class="pr-cmp-vs-lbl">VS</span>
                <select onchange="onPartyCompareChange('b', this.value)">${partyMemberOptions(board, b)}</select>
            </div>`;
            let body;
            if (rotA && rotB) {
                body = PartyRender.compareHtml(rotA, rotB, { name: nameOf(a) }, { name: nameOf(b) });
            } else {
                // A breakdown isn't in yet. "Loading" ONLY if the server already has it; otherwise
                // that member's fight hasn't ended — say so instead of a forever-"Loading breakdowns…".
                const stillFighting = (uid, rot) => !rot && !memberHasDetail(encId, uid);
                const inCombat = stillFighting(a, rotA) || stillFighting(b, rotB);
                body = inCombat
                    ? `<div class="party-empty-state"><div class="party-empty-icon">⚔️</div><div class="party-empty-text">Waiting for breakdowns — a teammate's fight hasn't ended yet. Updates automatically.</div></div>`
                    : `<div class="party-empty-state"><div class="party-empty-icon">⏳</div><div class="party-empty-text">Loading breakdowns…</div></div>`;
            }
            container.innerHTML = pickers + body;
        }

        function onPartyCompareChange(slot, userId) {
            partyState.compare[slot] = userId || null;
            // Avoid comparing a member with themselves — bump the other slot if they collide.
            if (partyState.compare.a && partyState.compare.a === partyState.compare.b) {
                const board = currentPartyBoard();
                // Fix #2: no has_detail filter — all members are drillable.
                const entries = (board && Array.isArray(board.entries)) ? board.entries : [];
                const other = entries.find((e) => e.user_id !== userId);
                if (other) partyState.compare[slot === 'a' ? 'b' : 'a'] = other.user_id;
            }
            renderPartyResults();
        }

        function renderPartyHistoryTab() {
            const container = document.getElementById('partyResultsContainer');
            const list = (partyState.encounters || []).slice().reverse(); // newest first
            if (!list.length) {
                container.innerHTML = `<div class="party-empty-state"><div class="party-empty-icon">📜</div><div class="party-empty-text">No encounters recorded yet.</div></div>`;
                return;
            }
            const activeId = partyState.active_encounter_id;
            const rows = list.map((e) => {
                const icon = PartyRender.catLabel(e.boss_category || 'unknown').split(' ')[0];
                const t = e.started_at ? new Date(e.started_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
                const live = (e.encounter_id === activeId && !e.ended) ? ' <span style="color:#22c55e;font-weight:700;">● LIVE</span>' : '';
                return `<div class="party-result-row party-result-clickable" onclick="onPartyHistorySelect('${escapeHtml(e.encounter_id)}')" style="cursor:pointer;padding:8px 10px;display:flex;gap:10px;align-items:center;">
                    <span style="font-size:1.1rem;">${icon}</span>
                    <span style="flex:1;color:#e2e8f0;font-weight:600;">${escapeHtml(e.boss || 'Recording…')}${live}</span>
                    <span style="color:#64748b;font-size:0.78rem;">${escapeHtml(t)}</span>
                    <span style="color:#94a3b8;font-size:0.8rem;">${e.entries_n || 0} · ${formatNumber(e.total_damage || 0)}</span>
                </div>`;
            }).join('');
            container.innerHTML = `<div class="party-detail-body" style="gap:6px;">${rows}</div>`;
        }

        function onPartyHistorySelect(encId) {
            partyState.viewing_encounter_id = encId;
            const sel = document.getElementById('partyTargetFilter');
            if (sel) sel.value = encId;
            switchPartyTab('scoreboard');
        }

        function partyLogout() {
            if (confirm('Reset party settings? You will need to enter your username again.')) {
                unsubscribeFromParty();
                // Reset local party state
                partyState.connected = false;
                partyState.party_code = null;
                partyState.is_leader = false;
                partyState.encounter_active = false;
                partyState.results = {};
                partyState.members = [];
                partyState.onlineMembers = {};
                
                document.getElementById('partyUsernameInput').value = '';
                document.getElementById('partyNameArea').style.display = 'flex';
                document.getElementById('partyNameTag').style.display = 'none';
                document.getElementById('partyJoinSection').style.display = 'none';
                document.getElementById('partyPlaceholder').style.display = 'block';
            }
        }

        // Filter change handlers
        document.getElementById('filterClass').addEventListener('change', updateSavedEncountersList);
        document.getElementById('filterBuild').addEventListener('change', updateSavedEncountersList);

        // Log filter event listeners
        document.getElementById('logSearch').addEventListener('input', renderLogTable);
        document.getElementById('logSkillFilter').addEventListener('change', renderLogTable);
        document.getElementById('logTargetFilter').addEventListener('change', renderLogTable);
        
        document.getElementById('logCritOnly').addEventListener('change', function() {
            document.getElementById('logCritToggle').classList.toggle('active', this.checked);
            renderLogTable();
        });
        
        document.getElementById('logHeavyOnly').addEventListener('change', function() {
            document.getElementById('logHeavyToggle').classList.toggle('active', this.checked);
            renderLogTable();
        });
        
        // Sort handling for log table
        document.querySelectorAll('.log-table th.sortable').forEach(th => {
            th.addEventListener('click', () => {
                const field = th.dataset.sort;
                if (logSortField === field) {
                    logSortAsc = !logSortAsc;
                } else {
                    logSortField = field;
                    logSortAsc = field === 'time' ? false : true;
                }
                
                // Update sort indicators
                document.querySelectorAll('.log-table th.sortable').forEach(h => {
                    h.classList.remove('sorted');
                    h.querySelector('.sort-icon').textContent = '↕';
                });
                th.classList.add('sorted');
                th.querySelector('.sort-icon').textContent = logSortAsc ? '↑' : '↓';
                
                renderLogTable();
            });
        });

        // ============================================================
        // UI ZOOM (Ctrl +/-/0) — CSS zoom on the whole UI, persisted
        // ============================================================
        const ZOOM_MIN = 0.5, ZOOM_MAX = 2.0, ZOOM_STEP = 0.1;
        function getZoom() { return parseFloat(localStorage.getItem('ui_zoom') || '1') || 1; }
        function applyZoom(z) {
            z = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z * 100) / 100));
            // CSS `zoom` shrinks the element but viewport units (100vh/100vw) are
            // measured against the UNZOOMED window, so the viewport-locked layout
            // (body min-height, .app height) renders short and the webview's black
            // background shows. Counter it: size those to 1/zoom so, once scaled, they
            // render back to a full window. `zoom` (unlike transform) keeps scrolling.
            const inv = 100 / z;
            document.body.style.zoom = z;
            document.body.style.minHeight = inv + 'vh';
            document.body.style.width = inv + 'vw';
            const app = document.querySelector('.app');
            if (app) app.style.height = inv + 'vh';
            localStorage.setItem('ui_zoom', String(z));
            const el = document.getElementById('zoomLevel');
            if (el) el.textContent = Math.round(z * 100) + '%';
            return z;
        }
        function zoomIn()    { applyZoom(getZoom() + ZOOM_STEP); }
        function zoomOut()   { applyZoom(getZoom() - ZOOM_STEP); }
        function zoomReset() { applyZoom(1); }
        applyZoom(getZoom());  // restore saved zoom on load

        // ============================================================
        // CHECK FOR UPDATES — compare APP_VERSION to latest GitHub release
        // ============================================================
        const APP_VERSION = '1.0.2';
        const RELEASES_LATEST_API = 'https://api.github.com/repos/stoopkid713/TL-DPS-Meter/releases/latest';
        const RELEASES_PAGE = 'https://github.com/stoopkid713/TL-DPS-Meter/releases/latest';
        function _verTuple(v) { return String(v || '').replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0); }
        function _verGt(a, b) {
            const x = _verTuple(a), y = _verTuple(b);
            for (let i = 0; i < Math.max(x.length, y.length); i++) {
                if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
            }
            return false;
        }
        async function checkForUpdates() {
            const status = document.getElementById('updateStatus');
            if (status) status.textContent = 'Checking…';
            try {
                const r = await fetch(RELEASES_LATEST_API, { headers: { 'Accept': 'application/vnd.github+json' } });
                if (!r.ok) throw new Error('HTTP ' + r.status);
                const data = await r.json();
                const latest = (data.tag_name || '').replace(/^v/, '');
                const url = data.html_url || RELEASES_PAGE;
                if (latest && _verGt(latest, APP_VERSION)) {
                    status.innerHTML = `Update available: <strong style="color:#22d3ee;">v${latest}</strong> — `
                        + `<a href="${url}" target="_blank" style="color:#22d3ee;">Download</a> (you have v${APP_VERSION})`;
                } else {
                    status.textContent = `You're up to date (v${APP_VERSION})`;
                }
            } catch (e) {
                status.innerHTML = `Couldn't check (${e.message}). `
                    + `<a href="${RELEASES_PAGE}" target="_blank" style="color:#22d3ee;">View releases</a>`;
            }
        }

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                closeSettings();
                closeSaveModal();
                closeGuide();
            }
            // UI zoom — Ctrl +/-/0 (preventDefault to override native webview zoom)
            if (e.ctrlKey && !e.altKey && !e.shiftKey) {
                if (e.key === '=' || e.key === '+' || e.code === 'NumpadAdd') { e.preventDefault(); zoomIn(); }
                else if (e.key === '-' || e.code === 'NumpadSubtract') { e.preventDefault(); zoomOut(); }
                else if (e.key === '0' || e.code === 'Numpad0') { e.preventDefault(); zoomReset(); }
            }
        });
        
        // Initialize target assignments
        initializeTargetAssignments();
        
        // ============================================================
        // INTERACTIVE TOUR
        // ============================================================
        const TOUR_STEPS = [
            {
                icon: '👋',
                title: 'Welcome to CK DPS Meter',
                text: 'This quick tour walks you through the key features. Takes about 2 minutes. Use the arrows to navigate or ✕ to skip.',
                target: null, tab: null
            },
            {
                icon: '🎯',
                title: 'Build Testing',
                text: 'Your main workspace for testing builds on the dummy. Everything starts here.',
                target: '[data-tab="buildTesting"]', tab: 'buildTesting', position: 'bottom'
            },
            {
                icon: '🔄',
                title: 'Reset Before Every Pull',
                text: 'Always hit Reset before attacking. It clears the current encounter so your data is clean. The Ctrl+Tab hotkey does the same from in-game.',
                target: '#resetTestBtn', tab: 'buildTesting', position: 'right'
            },
            {
                icon: '📊',
                title: 'Your Stats',
                text: 'After combat ends, your DPS, hits, Crit%, Heavy%, and Crit+Heavy% appear here. C+H hits are max roll AND 2× damage — the ones that really move the needle.',
                target: '#buildTestStatsPanel', tab: 'buildTesting', position: 'right',
                demo: 'stats'
            },
            {
                icon: '📋',
                title: 'Session Queue',
                text: 'Every completed 60s run automatically queues here. Tag each run with your build name while you keep testing — no need to stop and save between pulls.',
                target: '#sessionQueuePanel', tab: 'buildTesting', position: 'right',
                demo: 'queue'
            },
            {
                icon: '🔬',
                title: 'Run Lab — Compare Two Runs',
                text: 'Assign any two runs as A and B using the slot buttons, then open Run Lab. It computes the key differences: extra casts, avg damage per cast, and C+H rate per skill.',
                target: '[data-subtab="runlab"]', tab: 'buildTesting', position: 'bottom',
                demo: 'queue'
            },
            {
                icon: '📈',
                title: 'Rotation Analysis',
                text: 'The stacked chart shows what skill did damage each second. Performance Analysis identifies which skills were absent in your weakest segment and flags dropped casts.',
                target: null, tab: 'buildTesting', subtab: 'rotation'
            },
            {
                icon: '💾',
                title: 'Save All When Done',
                text: 'Once you\'re happy with your session, hit Save All in the queue. Runs get saved with your tags and show up in Saved for long-term tracking.',
                target: '#saveAllSessionBtn', tab: 'buildTesting', position: 'right',
                demo: 'queue'
            },
            {
                icon: '⚖️',
                title: 'Compare Tab',
                text: 'Compare up to 3 saved builds side by side — skill breakdown, rotation timing, DPS by segment. Great for cross-session build comparisons.',
                target: '[data-tab="compare"]', tab: 'compare', position: 'bottom'
            },
            {
                icon: '🎉',
                title: 'You\'re Ready',
                text: 'Hit the dummy, build your queue, and let Run Lab tell you what\'s actually different. Good luck finding that extra DPS.',
                target: null, tab: null
            }
        ];

        let tourCurrentStep = 0;
        let tourActive = false;
        let tourDemoInjected = false;

        function toggleSidebar() {
            const sidebar = document.getElementById('mainSidebar');
            const btn = document.getElementById('sidebarCollapseBtn');
            const collapsed = sidebar.classList.toggle('collapsed');
            btn.textContent = collapsed ? '›' : '‹';
            btn.title = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
        }

        function startTour() {
            tourActive = true;
            tourCurrentStep = 0;
            document.body.style.overflow = 'hidden';
            document.getElementById('tourOverlay').style.display = 'block';
            renderTourStep(0);
        }

        function endTour() {
            tourActive = false;
            document.body.style.overflow = '';
            document.getElementById('tourOverlay').style.display = 'none';
            document.getElementById('tourSpotlight').style.display = 'none';
            tourCleanupDemo();
        }

        function nextTourStep() {
            if (tourCurrentStep < TOUR_STEPS.length - 1) {
                tourCurrentStep++;
                renderTourStep(tourCurrentStep);
            } else {
                endTour();
            }
        }

        function prevTourStep() {
            if (tourCurrentStep > 0) {
                tourCurrentStep--;
                renderTourStep(tourCurrentStep);
            }
        }

        function tourInjectDemo(type) {
            if (type === 'stats') {
                // Show fake completed test stats
                document.getElementById('buildTestStatsPanel').style.display = 'block';
                document.getElementById('buildTestExtendedStats').style.display = 'grid';
                document.getElementById('btDps').textContent  = '185,420';
                document.getElementById('btHits').textContent = '1,847';
                document.getElementById('btCrit').textContent  = '34.2%';
                document.getElementById('btHeavy').textContent = '27.8%';
                document.getElementById('btNormal').textContent    = '53.1%';
                document.getElementById('btCritHeavy').textContent = '18.3%';
                document.getElementById('btAvgHit').textContent    = '6,012';
                const card = document.getElementById('activeTargetCard');
                if (card) {
                    card.style.display = 'block';
                    card.style.borderColor = 'rgba(34,197,94,0.3)';
                    card.style.background  = 'rgba(34,197,94,0.05)';
                    card.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center;">
                        <div>
                            <div style="font-size:0.75rem;color:#22c55e;font-weight:600;">✓ Test Complete</div>
                            <div style="font-size:1rem;color:#e2e8f0;font-weight:500;margin-top:4px;">Practice Dummy</div>
                        </div>
                        <div style="text-align:right;"><div style="font-size:0.7rem;color:#64748b;">60 seconds</div></div>
                    </div>`;
                }
                tourDemoInjected = true;
            }
            if (type === 'queue' && !tourDemoInjected) {
                // Inject fake session queue runs
                const fakeRuns = [
                    { runNumber:1, tempTag:'__demo1__', finalTag:'4pc Blood CDR',  playerClass:'Oracle', dps:192450, critRate:34.2, heavyRate:27.8, critHeavyRate:18.3, id:'__d1__', saved:false, runLabSlot:'A', rotation:[], skills:[], notes:'' },
                    { runNumber:2, tempTag:'__demo2__', finalTag:'2pc Veiled',      playerClass:'Oracle', dps:178320, critRate:31.5, heavyRate:25.1, critHeavyRate:16.7, id:'__d2__', saved:false, runLabSlot:'B', rotation:[], skills:[], notes:'' },
                    { runNumber:3, tempTag:'__demo3__', finalTag:'',               playerClass:'',       dps:185890, critRate:33.1, heavyRate:26.4, critHeavyRate:17.9, id:null,    saved:false, runLabSlot:null, rotation:[], skills:[], notes:'' }
                ];
                fakeRuns.forEach(r => sessionQueue.push(r));
                const panel = document.getElementById('sessionQueuePanel');
                if (panel) panel.style.display = 'block';
                renderSessionQueue();
                tourDemoInjected = true;
            }
        }

        function tourCleanupDemo() {
            if (!tourDemoInjected) return;
            // Remove demo queue items
            sessionQueue = sessionQueue.filter(i => !i.tempTag || !i.tempTag.startsWith('__demo'));
            renderSessionQueue();
            if (sessionQueue.length === 0) {
                const panel = document.getElementById('sessionQueuePanel');
                if (panel) panel.style.display = 'none';
            }
            // Reset stats display if no real test is complete
            if (!buildTestComplete) {
                document.getElementById('buildTestStatsPanel').style.display = 'none';
                document.getElementById('buildTestExtendedStats').style.display = 'none';
                const card = document.getElementById('activeTargetCard');
                if (card) card.style.display = 'none';
            }
            tourDemoInjected = false;
        }

        function renderTourStep(index) {
            const step = TOUR_STEPS[index];
            const total = TOUR_STEPS.length;

            // Navigate to right tab
            if (step.tab) {
                const tabBtn = document.querySelector(`[data-tab="${step.tab}"]`);
                if (tabBtn) tabBtn.click();
            }
            if (step.subtab) {
                setTimeout(() => switchBuildTestSubtab(step.subtab), 150);
            }

            // Inject demo data for this step
            if (step.demo) tourInjectDemo(step.demo);

            // Update tooltip content
            document.getElementById('tourStepIcon').textContent  = step.icon;
            document.getElementById('tourStepTitle').textContent = step.title;
            document.getElementById('tourStepText').textContent  = step.text;
            document.getElementById('tourStepCounter').textContent = `Step ${index + 1} of ${total}`;

            // Progress dots
            document.getElementById('tourDots').innerHTML = TOUR_STEPS.map((_, i) =>
                `<div style="width:${i===index?'20px':'7px'}; height:7px; border-radius:4px;
                     background:${i===index?'#a78bfa':'rgba(100,116,139,0.4)'};
                     transition:all 0.3s;"></div>`
            ).join('');

            // Buttons
            document.getElementById('tourPrevBtn').style.display = index === 0 ? 'none' : 'block';
            document.getElementById('tourNextBtn').textContent = index === total - 1 ? '✓ Done' : 'Next →';

            // Demo steps need extra time for injected panels to reflow before measuring
            const posDelay = step.demo ? 500 : 220;
            setTimeout(() => positionTourStep(step), posDelay);
        }

        function positionTourStep(step) {
            const backdrop  = document.getElementById('tourBackdrop');
            const spotlight = document.getElementById('tourSpotlight');
            const tooltip   = document.getElementById('tourTooltip');
            const PAD = 10;

            if (!step.target) {
                // Centered card — use backdrop, hide spotlight
                spotlight.style.display = 'none';
                backdrop.style.display  = 'block';
                backdrop.style.background = 'rgba(0,0,0,0.6)';
                tooltip.style.top  = '50%';
                tooltip.style.left = '50%';
                tooltip.style.transform = 'translate(-50%, -50%)';
                return;
            }

            tooltip.style.transform = '';
            const el = document.querySelector(step.target);
            if (!el) {
                spotlight.style.display = 'none';
                backdrop.style.display  = 'block';
                tooltip.style.top  = '50%';
                tooltip.style.left = '50%';
                tooltip.style.transform = 'translate(-50%, -50%)';
                return;
            }

            el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

            setTimeout(() => {
                const rect = el.getBoundingClientRect();

                // Guard: if element has no dimensions it's not rendered yet — centre the tooltip
                if (rect.width === 0 && rect.height === 0) {
                    spotlight.style.display = 'none';
                    backdrop.style.display  = 'block';
                    tooltip.style.top  = '50%';
                    tooltip.style.left = '50%';
                    tooltip.style.transform = 'translate(-50%, -50%)';
                    return;
                }
                const vpW  = window.innerWidth;
                const vpH  = window.innerHeight;
                const TW   = 320;
                const TH   = 280;

                // Use spotlight only — hide the separate backdrop to avoid double darkening
                backdrop.style.display  = 'none';
                spotlight.style.display = 'block';
                spotlight.style.top     = (rect.top    - PAD) + 'px';
                spotlight.style.left    = (rect.left   - PAD) + 'px';
                spotlight.style.width   = (rect.width  + PAD * 2) + 'px';
                spotlight.style.height  = (rect.height + PAD * 2) + 'px';

                // Position tooltip
                let top, left;
                const pos = step.position || 'bottom';
                if (pos === 'bottom') {
                    top  = rect.bottom + PAD + 14;
                    left = rect.left + rect.width / 2 - TW / 2;
                    if (top + TH > vpH) top = rect.top - TH - PAD - 14;
                } else if (pos === 'right') {
                    top  = rect.top + rect.height / 2 - TH / 2;
                    left = rect.right + PAD + 14;
                    if (left + TW > vpW) left = rect.left - TW - PAD - 14;
                } else if (pos === 'top') {
                    top  = rect.top - TH - PAD - 14;
                    left = rect.left + rect.width / 2 - TW / 2;
                    if (top < 0) top = rect.bottom + PAD + 14;
                }

                left = Math.max(12, Math.min(left, vpW - TW - 12));
                top  = Math.max(12, Math.min(top,  vpH - TH - 12));

                tooltip.style.top  = top  + 'px';
                tooltip.style.left = left + 'px';
            }, 80);
        }

        // === ROTATION SKILL FILTER FUNCTIONS ===

        function toggleRotationSkill(skill) {
            if (rotationHiddenSkills.has(skill)) rotationHiddenSkills.delete(skill);
            else rotationHiddenSkills.add(skill);
            if (lastRotationCache) renderBTStackedChart(lastRotationCache.rotation);
        }
        function rotationShowAll() {
            rotationHiddenSkills.clear();
            if (lastRotationCache) renderBTStackedChart(lastRotationCache.rotation);
        }
        function toggleEncRotationSkill(skill) {
            if (encRotationHiddenSkills.has(skill)) encRotationHiddenSkills.delete(skill);
            else encRotationHiddenSkills.add(skill);
            if (lastEncRotationCache) renderEncStackedChart(lastEncRotationCache.rotation, lastEncRotationCache.duration);
        }
