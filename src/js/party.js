        function openPartyOverlay(code, name, isLeader) {
            if (window.ckOverlay?.openPartyOverlay) {
                // Running in Electron - use IPC
                window.ckOverlay.openPartyOverlay({ code, name, leader: isLeader });
            } else {
                // Running in browser - ask server to spawn overlay
                sendCommand('open_overlay', { code, name, leader: isLeader });
            }
        }
        
        // Close party overlay
        function closePartyOverlay() {
            if (window.ckOverlay?.closePartyOverlay) {
                window.ckOverlay.closePartyOverlay();
            } else {
                sendCommand('close_overlay');
            }
        }
        
        // Toggle party overlay
        function togglePartyOverlay(code, name, isLeader) {
            if (window.ckOverlay?.togglePartyOverlay) {
                window.ckOverlay.togglePartyOverlay({ code, name, leader: isLeader });
            } else {
                // Server tracks the overlay process and toggles it (open if closed, close if open).
                sendCommand('toggle_overlay', { code, name, leader: isLeader });
            }
        }

        // === PARTY DPS (owned Cloudflare Durable Object room — Workstream B) ===
        // Transport = a single WebSocket to wss://tldps-party.kyle-526.workers.dev/party/<CODE>.
        // The room is the source of truth: it picks the boss server-side, filters trash, and
        // broadcasts a ranked boss scoreboard + roster. Post-combat model — no live streaming.
        let partyState = {
            connected: false,
            connecting: false,
            party_code: null,
            is_leader: false,
            leader_id: null,
            username: '',
            user_id: '',
            encounter_active: false,
            created_at: null,  // Party creation time for expiration display
            roster: [],        // [{user_id, username, is_leader, online}] from the room
            scoreboard: null,  // latest (active) {encounter_id, boss, boss_category, total_damage, entries:[...]} from the room
            // Phase 2 (A5) — multi-encounter switcher:
            encounters: [],            // room enumeration: [{encounter_id, boss, boss_category, started_at, ended, entries_n, total_damage}]
            active_encounter_id: null, // the room's currently-active encounter
            viewing_encounter_id: null,// which encounter the UI shows (null = follow active)
            boards: {},                // cache of scoreboards keyed by encounter_id (from `scoreboard` broadcasts)
            // Phase 3 (C3) — member drill-down:
            detail: null,              // {encounter_id, user_id, username} when drilled into a member
            memberDetails: {},         // cache: `${encounter_id}:${user_id}` -> {skills, rotation}
            // Phase 3 (C4) — tabs + A/B compare:
            activeTab: 'scoreboard',   // scoreboard | skills | rotation | compare | history
            skillsMember: null,        // selected member for the Skills tab
            rotationMember: null,      // selected member for the Rotation tab
            compare: { a: null, b: null }, // selected member user_ids for the Compare tab
            // legacy fields kept so older render paths don't throw:
            members: [],
            onlineMembers: {},
            results: {}
        };

        // --- WebSocket relay to the owned room ---
        const PARTY_WS_BASE = 'wss://tldps-party.kyle-526.workers.dev';

        // Bridge party/overlay room-WS events into the backend tracer so `TLDPS_DEBUG=1`
        // captures the whole party flow in tldps-debug.jsonl (+ live _monitor.py sink) — the
        // transport is client-side and otherwise invisible to the Python tracer. Always
        // console.logs (prefix [PartyDbg]); forwards to the server only when its socket is open.
        function partyDebug(event, fields) {
            try { console.log('[PartyDbg] ' + event, fields || ''); } catch (e) {}
            try { sendCommand('client_debug', { event: event, fields: fields || {} }); } catch (e) {}
        }
        let partyWS = null;
        let partyWSConnected = false;
        let partyWSWantOpen = false;   // we intend to stay connected (drives reconnect)
        let partyWelcomed = false;     // got a welcome since the last (re)connect
        let partyWSReconnect = null;   // reconnect timer
        let partyPingInterval = null;  // keepalive
        let expirationInterval = null; // expiration display timer
        let partyLiveHitDebounce = null; // trailing-debounce timer for live hydration posts

        function startPartyPing() {
            stopPartyPing();
            partyPingInterval = setInterval(() => {
                if (partyWS && partyWS.readyState === WebSocket.OPEN) {
                    try { partyWS.send(JSON.stringify({ type: 'ping' })); } catch (e) {}
                }
            }, 30000);
        }
        function stopPartyPing() {
            if (partyPingInterval) { clearInterval(partyPingInterval); partyPingInterval = null; }
        }

        // Open (or re-open) the room socket. isLeader is passed to the room as a query param.
        function connectPartyWS(code, isLeader) {
            if (!partyState.user_id || !partyState.username) return;
            if (partyWSReconnect) { clearTimeout(partyWSReconnect); partyWSReconnect = null; }
            partyWSWantOpen = true;
            partyWelcomed = false;
            partyDebug('party.connect', { code: code, leader: !!isLeader });
            if (partyWS) { try { partyWS.onclose = null; partyWS.close(); } catch (e) {} partyWS = null; }

            const qs = new URLSearchParams({
                user_id: partyState.user_id,
                username: partyState.username,
                leader: isLeader ? '1' : '0',
            });
            const url = `${PARTY_WS_BASE}/party/${encodeURIComponent(code)}?${qs.toString()}`;
            let ws;
            try { ws = new WebSocket(url); }
            catch (e) { console.error('[Party] WS construct failed:', e); return; }
            partyWS = ws;

            ws.onopen = () => {
                console.log('[Party] Room connected:', code);
                partyDebug('party.open', { code: code });
                partyWSConnected = true;
                startPartyPing();
                startExpirationTimer();
                if (diagnosticsOpen) refreshDiagnostics();
            };
            ws.onmessage = (ev) => {
                let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
                handlePartyRoomMessage(m);
            };
            ws.onerror = (e) => { console.warn('[Party] Room socket error'); partyDebug('party.error', {}); };
            ws.onclose = (ev) => {
                partyWSConnected = false;
                stopPartyPing();
                partyDebug('party.close', { code: (ev && ev.code), wanted: partyWSWantOpen, welcomed: partyWelcomed });
                if (diagnosticsOpen) refreshDiagnostics();
                if (!partyWSWantOpen) return;  // intentional leave
                if (!partyWelcomed) {
                    // Closed before any welcome on the initial connect = rejected
                    // (party full / bad code) or unreachable. Don't spin on it.
                    console.warn('[Party] Could not join room (full, bad code, or offline)');
                    partyWSWantOpen = false;
                    alert('Could not join party. It may be full, the code may be invalid, or the server is unreachable.');
                    partyState.connected = false; partyState.party_code = null;
                    partyState.is_leader = false; partyState.encounter_active = false;
                    updatePartyUI();
                    return;
                }
                // Otherwise: transient drop — reconnect and keep our spot.
                console.log('[Party] Room dropped; reconnecting…');
                partyWSReconnect = setTimeout(() => {
                    if (partyWSWantOpen && partyState.party_code) {
                        connectPartyWS(partyState.party_code, partyState.is_leader);
                    }
                }, 2000);
            };
        }

        function disconnectPartyWS() {
            partyWSWantOpen = false;
            if (partyWSReconnect) { clearTimeout(partyWSReconnect); partyWSReconnect = null; }
            stopPartyPing();
            stopExpirationTimer();
            if (partyWS) { try { partyWS.onclose = null; partyWS.close(); } catch (e) {} partyWS = null; }
            partyWSConnected = false;
            partyWelcomed = false;
        }

        // Dispatch a frame from the room (see workers/party/README.md wire protocol).
        function handlePartyRoomMessage(m) {
            partyDebug('party.msg', {
                type: m && m.type,
                boss: m && m.scoreboard ? m.scoreboard.boss : (m && m.boss),
                entries: m && m.scoreboard ? (m.scoreboard.entries || []).length : (m && m.entries ? m.entries.length : undefined),
                roster: m && m.roster ? m.roster.length : (m && m.members ? m.members.length : undefined),
                enc: m && m.encounter_active,
            });
            switch (m && m.type) {
                case 'welcome':
                    partyWelcomed = true;
                    if (m.you) partyState.is_leader = !!m.you.is_leader;
                    partyState.roster = m.roster || [];
                    partyState.scoreboard = m.scoreboard || null;
                    partyState.encounters = m.encounters || [];
                    partyState.active_encounter_id = m.active_encounter_id
                        || (m.scoreboard && m.scoreboard.encounter_id) || null;
                    if (m.scoreboard && m.scoreboard.encounter_id) {
                        partyState.boards[m.scoreboard.encounter_id] = m.scoreboard;
                    }
                    // Default to following the active encounter on (re)join.
                    if (partyState.viewing_encounter_id == null) {
                        partyState.viewing_encounter_id = partyState.active_encounter_id;
                    }
                    renderPartyMembers();
                    renderEncounterSwitcher();
                    renderPartyResults();
                    // Auto-record (keystone, 2026-05-31): arm local recording for the whole party
                    // session the moment we're in the room — no manual Start button. The room now
                    // treats encounter_start as a no-op, so this replaces the old broadcast chain.
                    // The backend session-arms on this, then auto-arms each fight on first combat hit.
                    armPartyRecording();
                    updatePartyUI();
                    break;
                case 'roster':
                    partyState.roster = m.members || [];
                    renderPartyMembers();
                    break;
                case 'scoreboard':
                    // Cache every board by its encounter_id so the switcher can show past ones.
                    if (m.encounter_id) partyState.boards[m.encounter_id] = m;
                    partyState.scoreboard = m; // last board (the active one) for legacy paths
                    // Re-render only if the user is currently viewing THIS encounter (or following
                    // active). Updates for an encounter they aren't looking at are cached silently.
                    if (partyState.viewing_encounter_id == null
                        || partyState.viewing_encounter_id === m.encounter_id) {
                        renderPartyResults();
                    }
                    break;
                case 'encounters': {
                    // Enumeration of all stored encounters (A4). Update the switcher; auto-follow
                    // the new active encounter ONLY if the user was following active / on the
                    // previous active (don't yank them off a past board they opened).
                    const prevActive = partyState.active_encounter_id;
                    partyState.encounters = m.list || [];
                    partyState.active_encounter_id = m.active_id || null;
                    if (partyState.viewing_encounter_id == null
                        || partyState.viewing_encounter_id === prevActive) {
                        partyState.viewing_encounter_id = partyState.active_encounter_id;
                    }
                    renderEncounterSwitcher();
                    renderPartyResults();
                    break;
                }
                case 'encounter_start':
                    handleEncounterStart(m);
                    break;
                case 'encounter_end':
                    handleEncounterEnd(m);
                    break;
                case 'member_joined':
                case 'member_left':
                case 'member_offline':
                    // Roster is refreshed by the room's separate `roster` broadcast.
                    break;
                case 'member_kicked':
                    // Fix #7: Room broadcasts this when a member is kicked; update local roster.
                    if (m.user_id === partyState.user_id) {
                        // We were kicked — leave gracefully.
                        alert('You have been kicked from the party.');
                        partyWSWantOpen = false;
                        disconnectPartyWS();
                        partyState.connected = false;
                        partyState.party_code = null;
                        partyState.is_leader = false;
                        partyState.roster = [];
                        updatePartyUI();
                    } else {
                        // Remove the kicked member from the local roster and re-render.
                        partyState.roster = partyState.roster.filter((r) => r.user_id !== m.user_id);
                        renderPartyMembers();
                    }
                    partyDebug('party.member_kicked', { user_id: m && m.user_id });
                    break;
                case 'member_detail': {
                    // Phase 3 (C3): lazy drill-down payload for one (encounter, member).
                    // Cache it; re-render the panel only if it's the member we're viewing.
                    const key = `${m.encounter_id}:${m.user_id}`;
                    if (partyState.detailPending) partyState.detailPending.delete(key); // request resolved
                    partyState.memberDetails[key] = { skills: m.skills || null, rotation: m.rotation || null };
                    if (partyState.detail
                        && partyState.detail.encounter_id === m.encounter_id
                        && partyState.detail.user_id === m.user_id) {
                        renderMemberDetail();
                    } else if (partyState.activeTab && partyState.activeTab !== 'scoreboard') {
                        // C4: a Skills/Rotation/Compare tab is waiting on this payload — re-render it.
                        renderPartyResults();
                    }
                    break;
                }
                case 'pong':
                    break;
            }
        }
        
        // Set username
        // B1: candidate display names from the combat log (F4 get_suggested_names).
        let partySuggestedNames = [];
        function renderNameSuggestions(names) {
            partySuggestedNames = Array.isArray(names) ? names.filter(Boolean) : [];
            const wrap = document.getElementById('partyNameSuggestions');
            const chips = document.getElementById('partyNameChips');
            if (!wrap || !chips) return;
            // Only surface chips while the name FORM is visible (i.e. no name chosen yet).
            const area = document.getElementById('partyNameArea');
            const formVisible = area && area.style.display !== 'none';
            if (!formVisible) { wrap.style.display = 'none'; return; }
            // Fix #13: always show the detect button when the form is visible, even with no names.
            if (!partySuggestedNames.length) {
                wrap.style.display = 'flex';
                ensureDetectNamesButton(wrap);
                return;
            }
            chips.innerHTML = partySuggestedNames.map((n) =>
                `<button type="button" class="party-name-chip" data-name="${escapeHtml(n)}" onclick="pickPartyName(this.dataset.name)" `
                + `style="margin:2px 4px 2px 0; padding:3px 9px; font-size:12px; border-radius:11px; `
                + `border:1px solid rgba(34,211,238,0.4); background:rgba(34,211,238,0.12); color:inherit; cursor:pointer;">`
                + `${escapeHtml(n)}</button>`
            ).join('');
            wrap.style.display = 'flex';
            // Fix #13: inject the "Detect names" button once into the wrap if not already there.
            ensureDetectNamesButton(wrap);
            // One-tap convenience: prefill the box with the top suggestion if it's still empty.
            const input = document.getElementById('partyUsernameInput');
            if (input && !input.value.trim() && !partyState.username) input.value = partySuggestedNames[0];
        }
        // Fix #13: inject the "Detect names" button into the suggestion wrap once.
        function ensureDetectNamesButton(wrap) {
            if (!wrap || wrap.querySelector('.party-detect-names-btn')) return;
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'party-detect-names-btn';
            btn.textContent = '↺ Detect';
            btn.title = 'Re-scan combat log for name suggestions';
            btn.style.cssText = 'margin:2px 0 2px 8px;padding:3px 9px;font-size:11px;border-radius:11px;border:1px solid rgba(100,116,139,0.5);background:rgba(100,116,139,0.15);color:#94a3b8;cursor:pointer;';
            btn.addEventListener('click', requestDetectNames);
            wrap.appendChild(btn);
        }

        // Fix #13: request a fresh name detection from the backend.
        function requestDetectNames() {
            try { sendCommand('get_suggested_names'); } catch (e) {}
            // Surface the wrap while we wait (may be hidden if no prior names)
            const wrap = document.getElementById('partyNameSuggestions');
            if (wrap) wrap.style.display = 'flex';
        }

        function pickPartyName(name) {
            const input = document.getElementById('partyUsernameInput');
            if (input) input.value = name;
            setPartyUsername();   // one tap = pick + save
        }

        function setPartyUsername() {
            const input = document.getElementById('partyUsernameInput');
            const username = input.value.trim();

            if (!username) {
                alert('Please enter a username');
                return;
            }
            
            // Generate a unique user_id if not already set
            if (!partyState.user_id) {
                partyState.user_id = 'user_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
            }
            partyState.username = username;
            
            // Save to localStorage for persistence across refreshes
            try {
                localStorage.setItem('party_username', username);
                localStorage.setItem('party_user_id', partyState.user_id);
            } catch (e) {
                console.warn('[Party] Failed to save to localStorage:', e);
            }
            
            console.log('[Party] Username set:', username, 'user_id:', partyState.user_id);
            
            // Switch to tag view
            showUsernameTag(username);
        }
        
        // Load saved username on page load
        function loadSavedUsername() {
            try {
                const savedUsername = localStorage.getItem('party_username');
                const savedUserId = localStorage.getItem('party_user_id');
                
                if (savedUsername && savedUserId) {
                    partyState.username = savedUsername;
                    partyState.user_id = savedUserId;
                    
                    // Update UI
                    const input = document.getElementById('partyUsernameInput');
                    if (input) input.value = savedUsername;
                    showUsernameTag(savedUsername);
                    
                    console.log('[Party] Loaded saved username:', savedUsername);
                }
            } catch (e) {
                console.warn('[Party] Failed to load from localStorage:', e);
            }
        }
        
        // Call on page load
        setTimeout(loadSavedUsername, 100);
        
        function editPartyUsername() {
            // Switch back to form view
            document.getElementById('partyNameArea').style.display = 'flex';
            document.getElementById('partyNameTag').style.display = 'none';
            document.getElementById('partyUsernameInput').focus();
            renderNameSuggestions(partySuggestedNames);  // re-surface chips in form view
        }

        function showUsernameTag(username) {
            document.getElementById('partyNameArea').style.display = 'none';
            document.getElementById('partyNameTag').style.display = 'flex';
            const sug = document.getElementById('partyNameSuggestions');
            if (sug) sug.style.display = 'none';  // name chosen -> hide chips
            document.getElementById('partyUsernameValue').textContent = username;
            document.getElementById('partyJoinSection').style.display = 'flex';
            document.getElementById('partyPlaceholder').style.display = 'none';
        }
        
        // Generate random 4-letter party code
        function generatePartyCode() {
            const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Avoid confusing chars
            let code = '';
            for (let i = 0; i < 4; i++) {
                code += chars.charAt(Math.floor(Math.random() * chars.length));
            }
            return code;
        }
        
        // Create party — generate a code and open the room as leader.
        async function createParty() {
            if (!partyState.username || !partyState.user_id) {
                alert('Please enter your username first');
                return;
            }

            const code = generatePartyCode();
            console.log('[Party] Creating party:', code);

            partyState.connected = true;
            partyState.party_code = code;
            partyState.is_leader = true;
            partyState.created_at = new Date().toISOString();
            partyState.encounter_active = false;
            partyState.roster = [];
            partyState.scoreboard = null;
            partyState.results = {};
            // Fresh switcher state for the new room (welcome will repopulate).
            partyState.encounters = [];
            partyState.active_encounter_id = null;
            partyState.viewing_encounter_id = null;
            partyState.boards = {};

            connectPartyWS(code, true);

            handlePartyCreated({
                code: code,
                status: {
                    connected: true,
                    party_code: code,
                    is_leader: true,
                    user_id: partyState.user_id,
                    username: partyState.username
                }
            });
        }
        
        // Create party and open overlay
        async function createPartyWithOverlay() {
            await createParty();
            
            // Open overlay after party is created (creator is leader)
            if (partyState.connected && partyState.party_code) {
                setTimeout(() => {
                    openPartyOverlay(partyState.party_code, partyState.username, true);
                }, 500);
            }
        }
        
        // Join party and open overlay  
        async function joinPartyWithOverlay() {
            await joinParty();
            
            // Open overlay after joining (joiner is not leader)
            if (partyState.connected && partyState.party_code) {
                setTimeout(() => {
                    openPartyOverlay(partyState.party_code, partyState.username, partyState.is_leader);
                }, 500);
            }
        }
        
        // Join party — open the room with the entered code as a non-leader.
        async function joinParty() {
            if (!partyState.username || !partyState.user_id) {
                alert('Please enter your username first');
                return;
            }

            const input = document.getElementById('partyJoinCodeInput');
            const code = input.value.trim().toUpperCase();

            if (!/^[A-Z0-9]{4,8}$/.test(code)) {
                alert('Please enter a valid party code (4–8 letters/numbers)');
                return;
            }

            console.log('[Party] Joining party:', code, 'as', partyState.username);

            partyState.connected = true;
            partyState.party_code = code;
            partyState.is_leader = false;  // the room's welcome confirms our role
            partyState.created_at = new Date().toISOString();
            partyState.encounter_active = false;
            partyState.roster = [];
            partyState.scoreboard = null;
            partyState.results = {};
            partyState.encounters = [];
            partyState.active_encounter_id = null;
            partyState.viewing_encounter_id = null;
            partyState.boards = {};

            connectPartyWS(code, false);

            handlePartyJoined({
                code: code,
                status: {
                    connected: true,
                    party_code: code,
                    is_leader: false,
                    user_id: partyState.user_id,
                    username: partyState.username
                }
            });
        }
        
        // Leave party — tell the room, close the socket, reset local state.
        // (Phase 1: leader leaving doesn't kick others — room TTL is an open design point.)
        async function leaveParty() {
            if (!confirm('Leave this party?')) return;

            try {
                if (partyWS && partyWS.readyState === WebSocket.OPEN) {
                    partyWS.send(JSON.stringify({ type: 'leave' }));
                }
            } catch (err) { console.warn('[Party] Error sending leave:', err); }

            disconnectPartyWS();

            partyState.connected = false;
            partyState.party_code = null;
            partyState.is_leader = false;
            partyState.encounter_active = false;
            partyState.results = {};
            partyState.scoreboard = null;
            partyState.roster = [];
            partyState.members = [];
            partyState.encounters = [];
            partyState.active_encounter_id = null;
            partyState.viewing_encounter_id = null;
            partyState.boards = {};
            renderEncounterSwitcher();

            handlePartyLeft({
                status: {
                    connected: false,
                    party_code: null,
                    is_leader: false,
                    user_id: partyState.user_id,
                    username: partyState.username
                }
            });
        }
        
        // === DIAGNOSTICS ===
        let diagnosticsOpen = false;
        let lastLogActivity = null;
        let lastLogFile = null;  // actual detected combat-log file (from log_info), null if none
        
        function toggleDiagnostics() {
            diagnosticsOpen = !diagnosticsOpen;
            const content = document.getElementById('partyDiagnosticsContent');
            const toggle = document.getElementById('partyDiagnosticsToggle');
            
            if (diagnosticsOpen) {
                content.classList.add('open');
                toggle.classList.add('open');
                refreshDiagnostics();
            } else {
                content.classList.remove('open');
                toggle.classList.remove('open');
            }
        }
        
        function refreshDiagnostics() {
            // 1. Server running (WebSocket connected)
            const serverOk = ws && ws.readyState === WebSocket.OPEN;
            updateDiagItem('diagServer', serverOk ? 'ok' : 'error', 'Server running');
            
            // 2. Combat log found (check if we have a log path configured)
            // Base this on the ACTUAL detected log file (from log_info / the sidebar's
            // CURRENT FILE), not the manual log-path input — recording works off auto-detection.
            const logFound = !!lastLogFile;
            updateDiagItem('diagLogFound', logFound ? 'ok' : 'error',
                logFound ? `Combat log: ${lastLogFile}` : 'Combat log found');
            
            // 3. Log file active (based on recent stats)
            const logActiveText = lastLogActivity ? `Active (${formatTimeAgo(lastLogActivity)})` : 'Log file active';
            const logActive = lastLogActivity && (Date.now() - lastLogActivity) < 30000;
            updateDiagItem('diagLogActive', logActive ? 'ok' : (lastLogActivity ? 'warn' : 'waiting'), logActiveText);
            
            // 4. Party room connected (Cloudflare WebSocket)
            updateDiagItem('diagSupabase', partyWSConnected ? 'ok' : 'error', 'Party room connected');

            // 5. Presence tracking (room roster)
            const onlineNow = (partyState.roster || []).filter(m => m.online).length;
            updateDiagItem('diagPresence', partyWSConnected ? 'ok' : 'waiting', partyWSConnected ? `Presence (${onlineNow} online)` : 'Presence tracking');
            
            // 6. Username set
            const hasUsername = partyState.username && partyState.username.length > 0;
            updateDiagItem('diagUsername', hasUsername ? 'ok' : 'waiting', hasUsername ? `Username: ${partyState.username}` : 'Username set');
            
            // 7. In party
            const inParty = partyState.connected && partyState.party_code;
            updateDiagItem('diagParty', inParty ? 'ok' : 'waiting', inParty ? `Party: ${partyState.party_code}` : 'In party');
            
            // 8. Encounter active
            updateDiagItem('diagEncounter', partyState.encounter_active ? 'ok' : 'waiting', 'Encounter active');
            
            // 9. Damage recorded
            const damage = partyState.total_damage || 0;
            const hasDamage = damage > 0;
            updateDiagItem('diagDamage', hasDamage ? 'ok' : 'waiting', hasDamage ? `Damage: ${damage.toLocaleString()}` : 'Damage recorded');
        }
        
        function updateDiagItem(id, status, label) {
            const item = document.getElementById(id);
            if (!item) return;
            
            const iconEl = item.querySelector('.party-diag-icon');
            const labelEl = item.querySelector('.party-diag-label');
            
            // Update class
            item.className = 'party-diag-item ' + status;
            
            // Update icon
            const icons = { ok: '✅', warn: '⚠️', error: '❌', waiting: '⬜' };
            iconEl.textContent = icons[status] || '⬜';
            
            // Update label
            labelEl.textContent = label;
        }
        
        function formatTimeAgo(timestamp) {
            const seconds = Math.floor((Date.now() - timestamp) / 1000);
            if (seconds < 5) return 'just now';
            if (seconds < 60) return `${seconds}s ago`;
            if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
            return `${Math.floor(seconds / 3600)}h ago`;
        }
        
        // Start encounter (leader only) — the room relays encounter_start to everyone
        // (including us), which arms each member's local recording via handleEncounterStart.
        function startEncounter() {
            if (!partyState.is_leader || !partyWS || partyWS.readyState !== WebSocket.OPEN) return;
            try {
                partyWS.send(JSON.stringify({ type: 'encounter_start' }));
                console.log('[Party] Encounter start sent to room');
            } catch (err) {
                console.error('[Party] Error sending encounter start:', err);
            }
        }
        
        // End encounter with 5-second countdown
        let countdownTimer = null;
        let countdownValue = 5;
        
        function endEncounter() {
            if (!partyState.is_leader || !partyWS || partyWS.readyState !== WebSocket.OPEN) return;

            // Show countdown
            const countdownDiv = document.getElementById('partyCountdown');
            const countdownTimerEl = document.getElementById('partyCountdownTimer');
            const endBtn = document.getElementById('partyEndBtn');

            countdownDiv.style.display = 'block';
            endBtn.style.display = 'none';
            countdownValue = 5;
            countdownTimerEl.textContent = countdownValue;

            // Tell the room — it relays encounter_end to everyone (incl. us), which stops
            // each member's local recording and triggers their post_fight.
            try {
                partyWS.send(JSON.stringify({ type: 'encounter_end' }));
                console.log('[Party] Encounter end sent to room');
            } catch (err) {
                console.error('[Party] Error sending encounter end:', err);
            }

            // UI countdown just for visual feedback (results stream in as members post).
            countdownTimer = setInterval(() => {
                countdownValue--;
                countdownTimerEl.textContent = countdownValue;
                if (countdownValue <= 0) {
                    clearInterval(countdownTimer);
                    countdownTimer = null;
                    countdownDiv.style.display = 'none';
                }
            }, 1000);
        }
        
        // Copy party code
        function copyPartyCode() {
            if (partyState.party_code) {
                navigator.clipboard.writeText(partyState.party_code);
                const copyText = document.getElementById('partyCopyText');
                copyText.textContent = '✓ Copied!';
                setTimeout(() => copyText.textContent = '📋 Copy Code', 1500);
            }
        }

        // B2 Cut A: shareable invite link → the gh-pages join page (shows the code + how to get
        // the app). Drop it in Discord/DM; even a non-user lands on download + join instructions.
        const INVITE_BASE = 'https://stoopkid713.github.io/TL-DPS-Meter/join.html';
        function copyInviteLink() {
            if (!partyState.party_code) return;
            const link = `${INVITE_BASE}#${encodeURIComponent(partyState.party_code)}`;
            navigator.clipboard.writeText(link);
            const t = document.getElementById('partyInviteText');
            if (t) { t.textContent = '✓ Link Copied!'; setTimeout(() => t.textContent = '🔗 Copy Invite Link', 1500); }
        }
        
        // The room pushes roster + scoreboard automatically; "refresh" is now just a re-render
        // of the latest state the room has already sent us.
        function refreshPartyMembers() {
            renderPartyMembers();
        }

        function refreshPartyResults() {
            renderPartyResults();
        }
        
        // Cooldown tracking for leader buttons
        let clearResultsCooldown = false;
        let syncPartyCooldown = false;
        
        // Handle broadcast events from leader
        function handleLeaderBroadcast(payload) {
            if (!payload || !payload.action) return;
            
            console.log('[Party] Handling leader broadcast:', payload.action);
            
            switch (payload.action) {
                case 'clear_results':
                    // Clear local results (leader already cleared DB)
                    partyState.results = {};
                    const filterSelect = document.getElementById('partyTargetFilter');
                    if (filterSelect) {
                        filterSelect.innerHTML = '<option value="">All Targets</option>';
                    }
                    renderPartyResults();
                    console.log('[Party] Results cleared by leader broadcast');
                    break;
                    
                case 'sync_all':
                    // Refresh everything
                    refreshPartyMembers();
                    refreshPartyResults();
                    console.log('[Party] Full sync triggered by leader broadcast');
                    break;
            }
        }
        
        // Legacy no-op: leader actions (clear/sync) now go through the room directly
        // (see clearPartyResults → 'clear', syncPartyAll → local re-render).
        function broadcastLeaderAction(action) { /* room is source of truth; nothing to relay */ }
        
        // Sync all party members (leader only)
        function syncPartyAll() {
            if (!partyState.is_leader) {
                alert('Only the party leader can sync the party.');
                return;
            }
            
            if (syncPartyCooldown) {
                console.log('[Party] Sync on cooldown');
                return;
            }
            
            // Set cooldown
            syncPartyCooldown = true;
            const btn = document.getElementById('partySyncBtn');
            if (btn) {
                btn.disabled = true;
                btn.style.opacity = '0.5';
                btn.textContent = '⏳ Sync';
            }
            
            // The room is the source of truth and pushes roster + scoreboard automatically,
            // so "sync" is just a local re-render of the latest state.
            refreshPartyMembers();
            refreshPartyResults();

            // Reset cooldown after 3 seconds
            setTimeout(() => {
                syncPartyCooldown = false;
                if (btn) {
                    btn.disabled = false;
                    btn.style.opacity = '1';
                    btn.textContent = '🔄 Sync';
                }
            }, 3000);
        }
        
        // Clear all results (leader only)
        function clearPartyResults() {
            if (!partyState.is_leader) {
                alert('Only the party leader can clear results.');
                return;
            }
            
            if (clearResultsCooldown) {
                console.log('[Party] Clear on cooldown');
                return;
            }
            
            if (!confirm('Clear all encounter results? This cannot be undone.')) {
                return;
            }
            
            // Set cooldown
            clearResultsCooldown = true;
            const btn = document.querySelector('.party-clear-btn');
            if (btn) {
                btn.disabled = true;
                btn.style.opacity = '0.5';
            }
            
            // Clear local state
            partyState.results = {};
            
            // Reset filter dropdown
            const filterSelect = document.getElementById('partyTargetFilter');
            if (filterSelect) {
                filterSelect.innerHTML = '<option value="">All Targets</option>';
            }
            
            // Reset local server party stats
            sendCommand('party_reset_stats');

            // Tell the room to wipe the shared board (it rebroadcasts an empty scoreboard).
            partyState.scoreboard = null;
            try {
                if (partyWS && partyWS.readyState === WebSocket.OPEN) {
                    partyWS.send(JSON.stringify({ type: 'clear' }));
                }
            } catch (err) { console.warn('[Party] Error sending clear:', err); }

            // Re-render empty state
            renderPartyResults();
            
            // Reset cooldown after 3 seconds
            setTimeout(() => {
                clearResultsCooldown = false;
                if (btn) {
                    btn.disabled = false;
                    btn.style.opacity = '1';
                }
            }, 3000);
        }
        
        // Connect to the owned room (thin wrapper kept for callers that say "subscribe").
        function subscribeToParty(code) {
            connectPartyWS(code, partyState.is_leader);
        }

        // Disconnect from the room.
        function unsubscribeFromParty() {
            disconnectPartyWS();
            partyState.onlineMembers = {};
        }
        
        // Handle encounter start broadcast
        function handleEncounterStart(payload) {
            if (partyState.encounter_active) return; // Already active
            
            console.log('[Party] Encounter started via broadcast');
            partyState.encounter_active = true;
            partyState.results = {};
            
            // Tell Python server to start recording
            sendCommand('party_start_recording', { party_code: partyState.party_code });
            
            updatePartyUI();
        }
        
        // Handle encounter end broadcast
        function handleEncounterEnd(payload) {
            if (!partyState.encounter_active) return; // Not active
            
            console.log('[Party] Encounter ended via broadcast');
            partyState.encounter_active = false;
            
            // Tell Python server to stop recording and get results
            sendCommand('party_stop_recording');
            
            // Flush any pending result renders immediately
            flushPartyResults();
            
            updatePartyUI();
        }
        
        // Auto-record (keystone, 2026-05-31): arm the local backend's party recording session.
        // Replaces the old manual leader "Start" → encounter_start broadcast chain (the room now
        // treats encounter_start as a no-op). Every member arms their OWN local backend on join;
        // the backend then auto-arms each fight on its first combat hit. Idempotent — safe to re-send
        // on every (re)connect.
        function armPartyRecording() {
            if (!partyState.party_code) return;
            partyState.encounter_active = true; // session armed (drives the recording indicator)
            try { sendCommand('party_start_recording', { party_code: partyState.party_code }); }
            catch (err) { console.warn('[Party] Error arming recording:', err); }
            partyDebug('party.auto_arm', { code: partyState.party_code });
            updatePartyUI();
        }

        // Handle clear results broadcast
        function handleClearResults(payload) {
            console.log('[Party] Results cleared via broadcast');
            partyState.results = {};
            const filterSelect = document.getElementById('partyTargetFilter');
            if (filterSelect) {
                filterSelect.innerHTML = '<option value="">All Targets</option>';
            }
            renderPartyResults();
            
            // Also reset server party stats
            sendCommand('party_reset_stats');
        }
        
        // Add a result from realtime subscription (throttled for live updates)
        let partyResultsRenderPending = false;
        let partyResultsRenderTimeout = null;
        
        function addPartyResult(result) {
            const key = `${result.user_id}-${result.target_name}`;
            partyState.results[key] = result;
            
            // Throttle rendering to max once per 200ms during rapid updates
            if (!partyResultsRenderPending) {
                partyResultsRenderPending = true;
                partyResultsRenderTimeout = setTimeout(() => {
                    partyResultsRenderPending = false;
                    renderPartyResults();
                }, 200);
            }
        }
        
        // Force immediate render (for end of encounter)
        function flushPartyResults() {
            if (partyResultsRenderTimeout) {
                clearTimeout(partyResultsRenderTimeout);
                partyResultsRenderTimeout = null;
            }
            partyResultsRenderPending = false;
            renderPartyResults();
        }
        
        // Track last status to avoid spam
        let lastPartyStatusJson = '';
        
        // Update party status from server response
        function updatePartyStatus(status) {
            // Only log if status actually changed
            const statusJson = JSON.stringify(status);
            if (statusJson !== lastPartyStatusJson) {
                console.log('[Party] Status update:', status);
                lastPartyStatusJson = statusJson;
            }
            
            // Subscribe to realtime if we just joined a party (new party code)
            // Track previous code to detect actual party change
            const prevCode = partyState.party_code;
            
            // Preserve local state when server status doesn't have these values.
            // The local Python server only knows recording state, not party membership
            // (that lives in the Cloudflare room). Don't let null values clobber valid state.
            partyState = {
                ...partyState,
                // Only update encounter-related fields from server
                encounter_active: status.encounter_active !== undefined ? status.encounter_active : partyState.encounter_active,
                total_damage: status.total_damage !== undefined ? status.total_damage : partyState.total_damage,
                target_count: status.target_count !== undefined ? status.target_count : partyState.target_count
            };
            
            // Only update party membership fields if explicitly provided with real values
            // (these come from the room / local party ops, not the Python server)
            if (status.connected !== undefined && status.connected !== null) {
                partyState.connected = status.connected;
            }
            if (status.connecting !== undefined) partyState.connecting = status.connecting;
            if (status.party_code) {
                partyState.party_code = status.party_code;
            }
            if (status.is_leader !== undefined && status.is_leader !== null) {
                partyState.is_leader = status.is_leader;
            }
            if (status.username) partyState.username = status.username;
            if (status.user_id) partyState.user_id = status.user_id;
            
            // Update username display if we have one
            if (status.username) {
                const input = document.getElementById('partyUsernameInput');
                if (input) {
                    input.value = status.username;
                }
                // Show the username tag instead of the form
                showUsernameTag(status.username);
                
                // Update username in active view
                const userNameText = document.getElementById('partyUserNameText');
                if (userNameText) {
                    userNameText.textContent = status.username;
                }
            }
            
            // Open the room socket if we just joined a new party and aren't connected yet.
            // (createParty/joinParty already call connectPartyWS; this is a safety net.)
            if (status.connected && status.party_code && !partyWS &&
                (!prevCode || prevCode !== status.party_code)) {
                connectPartyWS(status.party_code, partyState.is_leader);
            }
            
            updatePartyUI();
        }
        
        // Handle party created response
        function handlePartyCreated(data) {
            console.log('[Party] Party created:', data.code, 'is_leader:', data.status?.is_leader);
            updatePartyStatus(data.status);
            refreshPartyMembers();
        }
        
        // Handle party joined response
        function handlePartyJoined(data) {
            console.log('[Party] Joined party:', data.code);
            updatePartyStatus(data.status);
            refreshPartyMembers();
            refreshPartyResults();
        }
        
        // Handle party left response
        function handlePartyLeft(data) {
            console.log('[Party] Left party');
            partyState.results = {};
            updatePartyStatus(data.status);
        }
        
        // Handle members list response
        function handlePartyMembers(data) {
            partyState.members = data.members || [];
            
            // Update leader status and created_at from party_info
            if (data.party_info) {
                partyState.leader_id = data.party_info.leader_id;
                if (data.status) {
                    partyState.is_leader = data.party_info.leader_id === data.status.user_id;
                }
                
                // Store created_at for expiration timer
                if (data.party_info.created_at) {
                    partyState.created_at = data.party_info.created_at;
                    startExpirationTimer();
                }
            }
            
            renderPartyMembers();
            updatePartyUI();  // Make sure UI reflects leader status
        }
        
        // Handle results response
        function handlePartyResults(data) {
            partyState.results = {};
            (data.results || []).forEach(r => {
                const key = `${r.user_id}-${r.target_name}`;
                partyState.results[key] = r;
            });
            renderPartyResults();
        }
        
        // Update party expiration display
        function updatePartyExpiration() {
            const container = document.getElementById('partyExpires');
            const textEl = document.getElementById('partyExpiresText');
            
            if (!container || !textEl || !partyState.created_at) {
                if (textEl) textEl.textContent = 'Expires in --:--';
                return;
            }
            
            const created = new Date(partyState.created_at);
            const expires = new Date(created.getTime() + 12 * 60 * 60 * 1000); // 12 hours
            const now = new Date();
            const remaining = expires - now;
            
            if (remaining <= 0) {
                textEl.textContent = 'Expired';
                container.className = 'party-expires critical';
                return;
            }
            
            const hours = Math.floor(remaining / (1000 * 60 * 60));
            const minutes = Math.floor((remaining % (1000 * 60 * 60)) / (1000 * 60));
            
            textEl.textContent = `Expires in ${hours}h ${minutes}m`;
            
            // Color coding
            if (hours < 1) {
                container.className = 'party-expires critical';
            } else if (hours < 3) {
                container.className = 'party-expires warning';
            } else {
                container.className = 'party-expires';
            }
        }
        
        // Start expiration update interval
        function startExpirationTimer() {
            if (expirationInterval) clearInterval(expirationInterval);
            updatePartyExpiration();
            expirationInterval = setInterval(updatePartyExpiration, 60000); // Every minute
        }
        
        // Stop expiration update interval
        function stopExpirationTimer() {
            if (expirationInterval) {
                clearInterval(expirationInterval);
                expirationInterval = null;
            }
        }
        
        // Update the party UI based on current state
        function updatePartyUI() {
            const setupView = document.getElementById('partySetupView');
            const activeView = document.getElementById('partyActiveView');
            
            if (partyState.connected && partyState.party_code) {
                // Show active party view
                setupView.style.display = 'none';
                activeView.style.display = 'block';
                
                // Update party code display
                document.getElementById('partyCodeDisplay').textContent = partyState.party_code;
                
                // Fix #5 — Remove the obsolete manual Start/End controls box.
                // Recording is automatic (armPartyRecording on join). We keep only the
                // RECORDING indicator (partyEncounterLive) and hide everything else in
                // the encounter section. The waitingMsg is also retired since auto-record
                // means every member is always armed.
                const encounterControls = document.getElementById('partyEncounterControls');
                const waitingMsg = document.getElementById('partyWaitingMsg');
                const startBtn = document.getElementById('partyStartBtn');
                const endBtn = document.getElementById('partyEndBtn');
                const encounterLive = document.getElementById('partyEncounterLive');
                const countdownDiv = document.getElementById('partyCountdown');
                const syncBtn = document.getElementById('partySyncBtn');
                // Always hide the manual Start/End controls; only the live indicator remains.
                if (encounterControls) encounterControls.style.display = 'none';
                if (startBtn) startBtn.style.display = 'none';
                if (endBtn) endBtn.style.display = 'none';
                if (countdownDiv && !countdownTimer) countdownDiv.style.display = 'none';
                if (waitingMsg) waitingMsg.style.display = 'none';
                // Sync button: visible for leader only.
                if (syncBtn) syncBtn.style.display = partyState.is_leader ? 'inline-block' : 'none';
                // Recording indicator always visible while armed.
                if (encounterLive) encounterLive.style.display = partyState.encounter_active ? 'flex' : 'none';
                
                // Leave button (Phase 1: leader leaving doesn't disband the room for others).
                const leaveBtn = document.getElementById('partyLeaveBtn');
                if (leaveBtn) {
                    leaveBtn.innerHTML = '🚪 Leave Party';
                }
                
            } else {
                // Show setup view
                setupView.style.display = 'grid';
                activeView.style.display = 'none';
            }
            
            // Refresh diagnostics if open
            if (diagnosticsOpen) refreshDiagnostics();
        }
        
        // Render party members list
        function renderPartyMembers() {
            const container = document.getElementById('partyMembersList');
            const countEl = document.getElementById('partyMemberCount');

            // Roster comes straight from the room: [{user_id, username, is_leader, online}].
            const roster = partyState.roster || [];
            const onlineCount = roster.filter(m => m.online).length;
            countEl.textContent = `${onlineCount}/${roster.length}`;

            if (roster.length === 0) {
                container.innerHTML = '<div class="party-member-item loading">Waiting for members...</div>';
                return;
            }

            container.innerHTML = roster.map(m => {
                const isLeader = !!m.is_leader;
                const isSelf = m.user_id === partyState.user_id;
                const isOnline = !!m.online;
                const safeName = escapeHtml(m.username);

                let badges = '';
                if (isLeader) badges += '<span class="party-member-badge leader">👑</span>';
                if (isSelf) badges += '<span class="party-member-badge you">YOU</span>';

                // Fix #7: Kick button — leader-only, not shown for self or other leaders.
                const canKick = partyState.is_leader && !isSelf && !isLeader;
                const kickBtn = canKick
                    ? `<button class="party-kick-btn" onclick="kickPartyMember('${escapeHtml(m.user_id)}','${escapeHtml(m.username)}')" `
                      + `title="Kick ${escapeHtml(m.username)}" `
                      + `style="margin-left:auto;padding:1px 7px;font-size:0.7rem;background:rgba(239,68,68,0.25);border:1px solid rgba(239,68,68,0.5);color:#fca5a5;border-radius:4px;cursor:pointer;">✕ Kick</button>`
                    : '';

                return `
                    <div class="party-member-item ${isLeader ? 'leader' : ''} ${isSelf ? 'self' : ''} ${!isOnline ? 'offline' : ''}">
                        <span class="party-member-status ${isOnline ? 'online' : 'offline'}"></span>
                        <span class="party-member-name">${safeName}</span>
                        ${badges}${kickBtn}
                    </div>
                `;
            }).join('');

            // Fix #7: Reset Roster button — appended below the list, leader-only.
            if (partyState.is_leader) {
                container.innerHTML += `<div style="margin-top:8px;text-align:right;">
                    <button onclick="resetPartyRoster()" title="Remove all offline / old members" `
                    + `style="padding:3px 10px;font-size:0.72rem;background:rgba(100,116,139,0.2);border:1px solid rgba(100,116,139,0.4);color:#94a3b8;border-radius:4px;cursor:pointer;">🔄 Reset Roster</button>
                </div>`;
            }
        }

        // Fix #7: Kick a member (leader only) — sends the worker kick command.
        function kickPartyMember(userId, username) {
            if (!partyState.is_leader) return;
            if (!confirm(`Kick ${username} from the party?`)) return;
            if (!partyWS || partyWS.readyState !== WebSocket.OPEN) {
                console.warn('[Party] kick: WS not open');
                return;
            }
            try {
                partyWS.send(JSON.stringify({ type: 'kick', target_uid: userId }));
                partyDebug('party.kick', { target_uid: userId, username: username });
            } catch (err) {
                console.error('[Party] Error sending kick:', err);
            }
        }

        // Fix #8: Reset roster (leader only) — clears stale/offline members server-side.
        function resetPartyRoster() {
            if (!partyState.is_leader) return;
            if (!confirm('Reset the party roster? This removes stale and offline members.')) return;
            if (!partyWS || partyWS.readyState !== WebSocket.OPEN) {
                console.warn('[Party] reset_roster: WS not open');
                return;
            }
            try {
                partyWS.send(JSON.stringify({ type: 'reset_roster' }));
                partyDebug('party.reset_roster', {});
            } catch (err) {
                console.error('[Party] Error sending reset_roster:', err);
            }
        }
        
        // Render party results
        // Player colors for consistent coloring
        const partyPlayerColors = [
            { bg: 'rgba(34, 211, 238, 0.25)', border: 'rgba(34, 211, 238, 0.5)', text: '#22d3ee' },   // Cyan
            { bg: 'rgba(167, 139, 250, 0.25)', border: 'rgba(167, 139, 250, 0.5)', text: '#a78bfa' }, // Purple
            { bg: 'rgba(74, 222, 128, 0.25)', border: 'rgba(74, 222, 128, 0.5)', text: '#4ade80' },   // Green
            { bg: 'rgba(251, 191, 36, 0.25)', border: 'rgba(251, 191, 36, 0.5)', text: '#fbbf24' },   // Yellow
            { bg: 'rgba(244, 114, 182, 0.25)', border: 'rgba(244, 114, 182, 0.5)', text: '#f472b6' }, // Pink
            { bg: 'rgba(251, 146, 60, 0.25)', border: 'rgba(251, 146, 60, 0.5)', text: '#fb923c' },   // Orange
            { bg: 'rgba(96, 165, 250, 0.25)', border: 'rgba(96, 165, 250, 0.5)', text: '#60a5fa' },   // Blue
            { bg: 'rgba(248, 113, 113, 0.25)', border: 'rgba(248, 113, 113, 0.5)', text: '#f87171' }, // Red
        ];
        
        // Map user_id to consistent color
        const partyPlayerColorMap = {};
        let partyColorIndex = 0;
        
        function getPlayerColor(userId) {
            if (!partyPlayerColorMap[userId]) {
                partyPlayerColorMap[userId] = partyPlayerColors[partyColorIndex % partyPlayerColors.length];
                partyColorIndex++;
            }
            return partyPlayerColorMap[userId];
        }
        
        function filterPartyResults() {
            renderPartyResults();
        }
        
        // Shared party scoreboard constants + formatters — SINGLE SOURCE is /party_render.js,
        // inlined here (and into the overlay) by build.py. Base uses PartyRender.CATEGORY_LABELS;
        // the base's own app-wide formatNumber/escapeHtml are intentionally left as-is.
