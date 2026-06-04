        // === IN-APP CONFIRM MODAL ===
        // Native confirm()/alert() return falsy in pywebview/WebView2 — never use them.
        // partyConfirm(message) returns a Promise<boolean> resolved by user action.
        function partyConfirm(message) {
            return new Promise(function(resolve) {
                // Build overlay
                const overlay = document.createElement('div');
                overlay.style.cssText = [
                    'position:fixed', 'inset:0', 'z-index:99999',
                    'display:flex', 'align-items:center', 'justify-content:center',
                    'background:rgba(0,0,0,0.65)', 'backdrop-filter:blur(2px)'
                ].join(';');

                const box = document.createElement('div');
                box.style.cssText = [
                    'background:#1e293b', 'border:1px solid rgba(100,116,139,0.5)',
                    'border-radius:10px', 'padding:24px 28px', 'max-width:360px',
                    'width:90%', 'box-shadow:0 8px 32px rgba(0,0,0,0.6)',
                    'color:#e2e8f0', 'font-family:inherit', 'font-size:0.95rem',
                    'line-height:1.5', 'text-align:center'
                ].join(';');

                const msg = document.createElement('div');
                msg.style.cssText = 'margin-bottom:20px;white-space:pre-wrap;';
                msg.textContent = message;

                const btnRow = document.createElement('div');
                btnRow.style.cssText = 'display:flex;gap:10px;justify-content:center;';

                const cancelBtn = document.createElement('button');
                cancelBtn.textContent = 'Cancel';
                cancelBtn.style.cssText = [
                    'padding:7px 20px', 'border-radius:6px', 'border:1px solid rgba(100,116,139,0.5)',
                    'background:rgba(100,116,139,0.15)', 'color:#94a3b8',
                    'cursor:pointer', 'font-size:0.9rem', 'font-family:inherit'
                ].join(';');

                const confirmBtn = document.createElement('button');
                confirmBtn.textContent = 'Confirm';
                confirmBtn.style.cssText = [
                    'padding:7px 20px', 'border-radius:6px', 'border:1px solid rgba(239,68,68,0.5)',
                    'background:rgba(239,68,68,0.2)', 'color:#fca5a5',
                    'cursor:pointer', 'font-size:0.9rem', 'font-family:inherit', 'font-weight:600'
                ].join(';');

                function close(result) {
                    document.body.removeChild(overlay);
                    resolve(result);
                }
                cancelBtn.addEventListener('click', function() { close(false); });
                confirmBtn.addEventListener('click', function() { close(true); });
                overlay.addEventListener('click', function(e) { if (e.target === overlay) close(false); });

                btnRow.appendChild(cancelBtn);
                btnRow.appendChild(confirmBtn);
                box.appendChild(msg);
                box.appendChild(btnRow);
                overlay.appendChild(box);
                document.body.appendChild(overlay);
                confirmBtn.focus();
            });
        }

        // partyAlert(message) — in-app replacement for alert() in WebView2.
        function partyAlert(message) {
            return new Promise(function(resolve) {
                const overlay = document.createElement('div');
                overlay.style.cssText = [
                    'position:fixed', 'inset:0', 'z-index:99999',
                    'display:flex', 'align-items:center', 'justify-content:center',
                    'background:rgba(0,0,0,0.65)', 'backdrop-filter:blur(2px)'
                ].join(';');

                const box = document.createElement('div');
                box.style.cssText = [
                    'background:#1e293b', 'border:1px solid rgba(100,116,139,0.5)',
                    'border-radius:10px', 'padding:24px 28px', 'max-width:360px',
                    'width:90%', 'box-shadow:0 8px 32px rgba(0,0,0,0.6)',
                    'color:#e2e8f0', 'font-family:inherit', 'font-size:0.95rem',
                    'line-height:1.5', 'text-align:center'
                ].join(';');

                const msg = document.createElement('div');
                msg.style.cssText = 'margin-bottom:20px;white-space:pre-wrap;';
                msg.textContent = message;

                const okBtn = document.createElement('button');
                okBtn.textContent = 'OK';
                okBtn.style.cssText = [
                    'padding:7px 24px', 'border-radius:6px', 'border:1px solid rgba(217,100,68,0.4)',
                    'background:rgba(217,100,68,0.15)', 'color:#D96444',
                    'cursor:pointer', 'font-size:0.9rem', 'font-family:inherit', 'font-weight:600'
                ].join(';');

                function close() {
                    document.body.removeChild(overlay);
                    resolve();
                }
                okBtn.addEventListener('click', close);
                overlay.addEventListener('click', function(e) { if (e.target === overlay) close(); });

                box.appendChild(msg);
                box.appendChild(okBtn);
                overlay.appendChild(box);
                document.body.appendChild(overlay);
                okBtn.focus();
            });
        }
        // === END IN-APP CONFIRM MODAL ===

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

        // === Obs #3 — live debug handle ===
        // TLDPS_DEBUG=1 is a Python server-side env var; there is no client-side flag exposed to
        // the WebView. We expose window.__tldps unconditionally so the debugger can always reach
        // live state without DOM-scraping. In production this is a harmless read-only handle on
        // the same closure that drives the UI; it does not expose anything not already in the DOM.
        // NOTE: V-RUNTIME confirmation (CDP read of window.__tldps.state) is deferred to integration.
        try {
            Object.defineProperty(window, '__tldps', {
                configurable: true,
                enumerable: false,
                get: function() {
                    return {
                        get state() { return partyState; },
                        get ws()    { return partyWS; },
                        get code()  { return partyState.party_code; }
                    };
                }
            });
        } catch (e) { /* already defined — ignore on re-injection */ }
        // === End Obs #3 ===

        let partyWS = null;
        let partyWSConnected = false;
        let partyWSWantOpen = false;   // we intend to stay connected (drives reconnect)
        let partyWelcomed = false;     // got a welcome since the last (re)connect
        let partyWSReconnect = null;   // reconnect timer
        let partyPingInterval = null;  // keepalive
        let expirationInterval = null; // expiration display timer
        let partyLiveHitDebounce = null; // trailing-debounce timer for live hydration posts
        let bannerRefreshInterval = null; // #14 banner periodic refresh (3 s, active-party only)

        // === AUTHORITATIVE-CODE GUARD ===
        // After createParty() or joinParty() sets a local party_code, the periodic
        // status-sync (updatePartyStatus) must NOT clobber it with a stale code the
        // Python backend still remembers from a previous session.
        //
        // _authCode      — the code we set locally via create/join (null when not in a party)
        // _authCodeTs    — timestamp (ms) when we set it; guard expires after AUTH_CODE_TTL_MS
        //                  in case the backend legitimately picks up the new code faster than
        //                  the guard window — after expiry the backend is considered in sync.
        //
        // A status_sync update is IGNORED (for party_code only) when ALL of:
        //   1. _authCode is non-null
        //   2. the incoming status.party_code differs from _authCode
        //   3. the guard is still within its TTL
        //
        // On leave: _authCode is cleared so a fresh session never inherits a stale guard.
        let _authCode = null;
        let _authCodeTs = 0;
        const AUTH_CODE_TTL_MS = 8000; // 8 s — enough for 4–8 status-poll cycles

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

        // #14 banner auto-refresh — keeps the own-client log-status banner live while in a party
        // even when the diagnostics panel is closed (the only other refresh path).
        // Cadence: every 3 s. Only runs while the party socket is open; cleared on disconnect.
        function startBannerRefresh() {
            if (bannerRefreshInterval) { clearInterval(bannerRefreshInterval); bannerRefreshInterval = null; }
            bannerRefreshInterval = setInterval(function() {
                renderLogStatusBanner();
            }, 3000);
        }
        function stopBannerRefresh() {
            if (bannerRefreshInterval) { clearInterval(bannerRefreshInterval); bannerRefreshInterval = null; }
        }

        // #14 LOGGING STATE MACHINE — intercept updateLogInfo (defined in encounter-edit.js,
        // which is inlined before this module) to capture last_combat_age_s from every
        // stats broadcast. Wrapping rather than replacing preserves the existing log-info
        // UI updates (current file, size display, welcome modal).  Build order:
        // encounter-edit.js (alpha first) → party.js (alpha second) → wrapper wins.
        (function _wrapUpdateLogInfo() {
            const _orig = typeof updateLogInfo === 'function' ? updateLogInfo : null;
            updateLogInfo = function(info) {
                if (_orig) _orig(info);
                // Capture the new deterministic signal emitted by the backend.
                // last_combat_age_s: float|null — age of last combat line in seconds.
                if (info && typeof info.last_combat_age_s === 'number') {
                    lastCombatAgeS = info.last_combat_age_s;
                } else if (info && info.last_combat_age_s === null) {
                    lastCombatAgeS = null;
                }
                // Re-render the banner immediately on every log-info update so the
                // state machine transitions without waiting for the 3 s tick.
                if (partyState.connected && partyState.party_code) {
                    renderLogStatusBanner();
                }
            };
        })();

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
                startBannerRefresh();
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
                    partyState.connected = false;
                    { const _prev = partyState.party_code; partyState.party_code = null; if (_prev !== null) partyDebug('party_code_change', { from: _prev, to: null, reason: 'disconnect' }); }
                    partyState.is_leader = false; partyState.encounter_active = false;
                    updatePartyUI();
                    partyAlert('Could not join party. It may be full, the code may be invalid, or the server is unreachable.');
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
            stopBannerRefresh();
            stopExpirationTimer();
            if (partyWS) { try { partyWS.onclose = null; partyWS.close(); } catch (e) {} partyWS = null; }
            partyWSConnected = false;
            partyWelcomed = false;
        }

        // Dispatch a frame from the room (see workers/party/README.md wire protocol).
        async function handlePartyRoomMessage(m) {
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
                        partyWSWantOpen = false;
                        disconnectPartyWS();
                        partyState.connected = false;
                        { const _prev = partyState.party_code; partyState.party_code = null; if (_prev !== null) partyDebug('party_code_change', { from: _prev, to: null, reason: 'kicked' }); }
                        partyState.is_leader = false;
                        partyState.roster = [];
                        updatePartyUI();
                        await partyAlert('You have been kicked from the party.');
                    } else {
                        // The roster broadcast that follows will refresh, but remove immediately
                        // so the row disappears before the next roster broadcast arrives.
                        partyState.roster = partyState.roster.filter((r) => r.user_id !== m.user_id);
                        renderPartyMembers();
                    }
                    partyDebug('party.member_kicked', { user_id: m && m.user_id });
                    break;
                case 'leader_changed':
                    // Worker broadcasts this on make_leader, leader-leave succession, and heal.
                    // Update local is_leader and re-render so leader-only controls follow the crown.
                    partyState.is_leader = (m.user_id === partyState.user_id);
                    // Roster broadcast always accompanies this; re-render now so the crown moves
                    // immediately even before the roster frame arrives.
                    renderPartyMembers();
                    updatePartyUI();
                    partyDebug('party.leader_changed', { new_leader: m && m.user_id, is_me: partyState.is_leader });
                    break;
                case 'roster_reset':
                    // Worker evicted offline members; roster broadcast follows. Nothing extra needed
                    // on the frontend — the roster frame re-renders the list.
                    partyDebug('party.roster_reset', { by: m && m.by });
                    break;
                case 'party_disbanded': {
                    // The room is gone (all members left / empty). Show a message and return to join.
                    partyWSWantOpen = false;
                    disconnectPartyWS();
                    partyState.connected = false;
                    { const _prev = partyState.party_code; partyState.party_code = null; if (_prev !== null) partyDebug('party_code_change', { from: _prev, to: null, reason: 'disbanded' }); }
                    partyState.is_leader = false;
                    partyState.roster = [];
                    partyState.scoreboard = null;
                    partyState.encounters = [];
                    partyState.active_encounter_id = null;
                    partyState.viewing_encounter_id = null;
                    updatePartyUI();
                    await partyAlert('The party has been closed: ' + (m.reason || 'all members left'));
                    partyDebug('party.disbanded', { reason: m && m.reason });
                    break;
                }
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
                + `border:1px solid rgba(217,100,68,0.4); background:rgba(217,100,68,0.12); color:inherit; cursor:pointer;">`
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

        async function setPartyUsername() {
            const input = document.getElementById('partyUsernameInput');
            const username = input.value.trim();

            if (!username) {
                await partyAlert('Please enter a username');
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
                await partyAlert('Please enter your username first');
                return;
            }

            const code = generatePartyCode();
            console.log('[Party] Creating party:', code);

            // Mark this code as locally authoritative so status-sync cannot clobber it.
            _authCode = code;
            _authCodeTs = Date.now();

            partyState.connected = true;
            { const _prev = partyState.party_code; partyState.party_code = code; if (_prev !== code) partyDebug('party_code_change', { from: _prev, to: code, reason: 'createParty' }); }
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
                await partyAlert('Please enter your username first');
                return;
            }

            const input = document.getElementById('partyJoinCodeInput');
            const code = input.value.trim().toUpperCase();

            if (!/^[A-Z0-9]{4,8}$/.test(code)) {
                await partyAlert('Please enter a valid party code (4–8 letters/numbers)');
                return;
            }

            console.log('[Party] Joining party:', code, 'as', partyState.username);

            // Mark this code as locally authoritative so status-sync cannot clobber it.
            _authCode = code;
            _authCodeTs = Date.now();

            partyState.connected = true;
            { const _prev = partyState.party_code; partyState.party_code = code; if (_prev !== code) partyDebug('party_code_change', { from: _prev, to: code, reason: 'joinParty' }); }
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
        //
        // BUG 2 FIX: persist in-session encounters + boards to localStorage BEFORE clearing
        // transport state so history survives a leave/re-enter. The data is keyed by the
        // party code so multiple sessions don't clobber each other. A rolling cap of 3 sessions
        // (merge with any existing persisted history, newest wins) keeps storage bounded.
        function persistPartyHistory() {
            try {
                const code = partyState.party_code;
                if (!code) return;
                const encs = partyState.encounters || [];
                if (!encs.length) return;
                const entry = {
                    party_code: code,
                    saved_at: new Date().toISOString(),
                    encounters: encs,
                    boards: partyState.boards || {}
                };
                let history = [];
                try { history = JSON.parse(localStorage.getItem('party_history') || '[]'); } catch (e) {}
                if (!Array.isArray(history)) history = [];
                // Remove any prior entry for this same party code, then prepend new.
                history = history.filter((h) => h.party_code !== code);
                history.unshift(entry);
                // Keep at most 3 recent sessions.
                if (history.length > 3) history = history.slice(0, 3);
                localStorage.setItem('party_history', JSON.stringify(history));
                console.log('[Party] Persisted history for', code, '—', encs.length, 'encounters');
            } catch (e) {
                console.warn('[Party] Failed to persist party history:', e);
            }
        }

        // Reload persisted party history into partyState for off-session viewing.
        // Called by renderPartyHistoryTab when encounters is empty (user not in a party).
        function loadPersistedPartyHistory() {
            try {
                const raw = localStorage.getItem('party_history');
                if (!raw) return;
                const history = JSON.parse(raw);
                if (!Array.isArray(history) || !history.length) return;
                // Flatten all sessions into partyState.encounters + boards (dedup by encounter_id).
                const seenIds = new Set((partyState.encounters || []).map((e) => e.encounter_id));
                const merged = [...(partyState.encounters || [])];
                const boards = Object.assign({}, partyState.boards || {});
                for (const session of history) {
                    for (const enc of (session.encounters || [])) {
                        if (!seenIds.has(enc.encounter_id)) {
                            seenIds.add(enc.encounter_id);
                            merged.push(enc);
                        }
                    }
                    Object.assign(boards, session.boards || {});
                }
                partyState.encounters = merged;
                partyState.boards = boards;
                console.log('[Party] Loaded persisted history — total encounters:', merged.length);
            } catch (e) {
                console.warn('[Party] Failed to load persisted party history:', e);
            }
        }

        async function leaveParty() {
            if (!await partyConfirm('Leave this party?')) return;

            // BUG 2 FIX: persist before clearing so session history survives the leave.
            persistPartyHistory();

            try {
                if (partyWS && partyWS.readyState === WebSocket.OPEN) {
                    partyWS.send(JSON.stringify({ type: 'leave' }));
                }
            } catch (err) { console.warn('[Party] Error sending leave:', err); }

            // Tell the Python backend to clear its stored party_code so future status-sync
            // broadcasts don't re-emit a stale code. The backend 'clear_party' handler sets
            // party_code = null (and resets party session state) — name matches dps_meter_server HANDLERS.
            try { sendCommand('clear_party'); } catch (err) { console.warn('[Party] Error sending clear_party to backend:', err); }

            // Clear the authoritative-code guard so the next create/join starts clean.
            _authCode = null;
            _authCodeTs = 0;

            disconnectPartyWS();

            partyState.connected = false;
            { const _prev = partyState.party_code; partyState.party_code = null; if (_prev !== null) partyDebug('party_code_change', { from: _prev, to: null, reason: 'leave' }); }
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
        // #14 LOGGING STATE MACHINE: age (seconds) of the last parsed combat line as of
        // the last stats broadcast. null = no combat ingested yet (or no log file).
        // Set by the updateLogInfo wrapper below; read by _logBannerState().
        let lastCombatAgeS = null;
        
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
            // Always refresh the log-status banner on every diagnostics tick (every
            // stats broadcast, ~0.5 s) so the own-client warning stays live.
            renderLogStatusBanner();

            // 1. Server running (WebSocket connected)
            const serverOk = ws && ws.readyState === WebSocket.OPEN;
            updateDiagItem('diagServer', serverOk ? 'ok' : 'error', 'Server running');
            
            // 2. Combat log found (check if we have a log path configured)
            // Base this on the ACTUAL detected log file (from log_info / the sidebar's
            // CURRENT FILE), not the manual log-path input — recording works off auto-detection.
            const logFound = !!lastLogFile;
            updateDiagItem('diagLogFound', logFound ? 'ok' : 'error',
                logFound ? `Combat log: ${lastLogFile}` : 'Combat log found');
            
            // 3. Log file active — #14 state machine: use lastCombatAgeS (deterministic)
            // with lastLogActivity as a legacy fallback for the text display.
            const logBannerSt = _logBannerState();
            const logActiveText = lastCombatAgeS !== null
                ? `Active (${lastCombatAgeS.toFixed(0)}s ago)`
                : (lastLogActivity ? `Active (${formatTimeAgo(lastLogActivity)})` : 'Log file active');
            const logActive = logBannerSt === 'ok';
            const logWaiting = logBannerSt === 'waiting';
            updateDiagItem('diagLogActive', logActive ? 'ok' : (logWaiting ? 'warn' : 'waiting'), logActiveText);
            
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

        // === HALF A — OWN-CLIENT LOGGING STATUS BANNER (#14) ===
        // Renders an unmissable banner inside the party active view so the local user
        // knows immediately if their combat log is missing or silent.
        //
        // DETERMINISTIC STATE MACHINE (three states, matches oracle doc):
        //   "off"     — NO_LOG_FILE: no *.txt present in the log dir (lastLogFile is null).
        //               Big amber warning + how-to-enable hint.
        //   "waiting" — LOG_PRESENT_NO_RECENT_COMBAT: log file found but last combat line
        //               is stale (lastCombatAgeS > COMBAT_STALE_S) OR null (no combat seen
        //               yet). Covers the game-off false-positive: a stale log file no
        //               longer reads as GREEN. Calm grey pill "Logging on — waiting…".
        //   "ok"      — LOGGING_ACTIVE: log file present AND last combat line age <=
        //               COMBAT_STALE_S (fresh combat flowing). No banner (silent green).
        //
        // Signal source: lastCombatAgeS — set by the updateLogInfo wrapper above from
        // log_info.last_combat_age_s on every stats broadcast (~0.5 s tick).
        // lastLogActivity / party_live_hit is RETAINED as a fallback for the diagnostics
        // panel only (not the banner state) to preserve existing diag behaviour.
        //
        // The banner is refreshed:
        //   • on every stats broadcast (via updateLogInfo wrapper above)
        //   • each time updatePartyUI() runs (covers join/leave/reconnect)
        //   • each time refreshDiagnostics() runs
        //   • from the 3 s bannerRefreshInterval
        //
        // The banner only appears while the party active view is visible (connected to a room).
        const COMBAT_STALE_S = 300;           // 5 min of silence = stale (game-off threshold)

        function _logBannerState() {
            // Layer 1: log file must exist (NO_LOG_FILE guard).
            const logFound = !!lastLogFile;
            if (!logFound) return 'off';
            // Layer 2: last combat line must be recent (LOGGING_ACTIVE guard).
            // lastCombatAgeS is null when no combat lines have been ingested yet,
            // or when the backend hasn't received the new field yet (old build
            // fallback: treat as waiting, not as an error).
            if (lastCombatAgeS === null || lastCombatAgeS > COMBAT_STALE_S) return 'waiting';
            return 'ok';
        }

        function renderLogStatusBanner() {
            // Only show while in an active party session (connected view visible).
            if (!partyState.connected || !partyState.party_code) return;

            // Find or create the banner element inside the active view.
            let banner = document.getElementById('partyLogStatusBanner');
            if (!banner) {
                const activeView = document.getElementById('partyActiveView');
                if (!activeView) return;
                banner = document.createElement('div');
                banner.id = 'partyLogStatusBanner';
                // Insert at the very top of the active view so it can't be missed.
                activeView.insertBefore(banner, activeView.firstChild);
            }

            const state = _logBannerState();

            if (state === 'off') {
                // Big unmissable amber warning.
                banner.style.cssText = [
                    'display:flex', 'align-items:center', 'gap:10px',
                    'margin:0 0 10px 0', 'padding:10px 14px',
                    'background:rgba(251,191,36,0.18)', 'border:1.5px solid rgba(251,191,36,0.6)',
                    'border-radius:8px', 'color:#fbbf24', 'font-size:0.88rem', 'line-height:1.4',
                ].join(';');
                banner.innerHTML = '<span style="font-size:1.3rem;flex-shrink:0;">⚠️</span>'
                    + '<span><strong>Combat logging is OFF — you will not appear on the board.</strong>'
                    + '<br><span style="color:#fde68a;font-size:0.82rem;">Enable it in T&L: Settings → Gameplay → Combat Log → turn ON, then re-launch the game.</span></span>';
            } else if (state === 'waiting') {
                // Calm informational pill — log is on, just no combat yet.
                banner.style.cssText = [
                    'display:flex', 'align-items:center', 'gap:8px',
                    'margin:0 0 10px 0', 'padding:7px 12px',
                    'background:rgba(100,116,139,0.15)', 'border:1px solid rgba(100,116,139,0.35)',
                    'border-radius:8px', 'color:#94a3b8', 'font-size:0.83rem',
                ].join(';');
                banner.innerHTML = '<span style="font-size:1.1rem;">🟢</span>'
                    + '<span>Logging on — waiting for combat…</span>';
            } else {
                // ok — hide the banner entirely.
                banner.style.display = 'none';
                return;
            }
        }
        // === END HALF A BANNER ===
        
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
        async function syncPartyAll() {
            if (!partyState.is_leader) {
                await partyAlert('Only the party leader can sync the party.');
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
        async function clearPartyResults() {
            if (!partyState.is_leader) {
                await partyAlert('Only the party leader can clear results.');
                return;
            }

            if (clearResultsCooldown) {
                console.log('[Party] Clear on cooldown');
                return;
            }

            if (!await partyConfirm('Clear all encounter results? This cannot be undone.')) {
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
                // Authoritative-code guard: if the local create/join established a code
                // recently, and the backend is sending back a DIFFERENT (stale) code,
                // ignore the backend value until the guard TTL expires.  After TTL the
                // backend is considered in sync and normal assignment resumes.
                const guardActive = _authCode !== null
                    && status.party_code !== _authCode
                    && (Date.now() - _authCodeTs) < AUTH_CODE_TTL_MS;
                if (guardActive) {
                    partyDebug('party_code_guard_blocked', {
                        local: _authCode,
                        backend: status.party_code,
                        age_ms: Date.now() - _authCodeTs
                    });
                } else {
                    const _prev = partyState.party_code; partyState.party_code = status.party_code; if (_prev !== status.party_code) partyDebug('party_code_change', { from: _prev, to: status.party_code, reason: 'status_sync', wsUrl: partyWS ? partyWS.url : undefined });
                }
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
                // Fix #9 — Hide the entire ⚔️ Encounter section wrapper when no controls are visible.
                // All manual Start/End controls are hidden; the only remaining child is the RECORDING
                // indicator. Hide the whole section (title + wrapper) so no empty labeled box appears.
                const encounterSection = encounterControls ? encounterControls.closest('.party-encounter-section') : null;
                if (encounterSection) {
                    // Show the section only when the live indicator is active (gives it content).
                    encounterSection.style.display = partyState.encounter_active ? '' : 'none';
                }
                
                // Leave button (Phase 1: leader leaving doesn't disband the room for others).
                const leaveBtn = document.getElementById('partyLeaveBtn');
                if (leaveBtn) {
                    leaveBtn.innerHTML = '🚪 Leave Party';
                }

                // Half A (#14): always refresh the own-client log-status banner when the
                // active view is shown (join, reconnect, every updatePartyUI call).
                renderLogStatusBanner();

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

            // Roster from the room: [{user_id, username, is_leader, online, has_posted, joined_age_s}].
            // has_posted / joined_age_s are added by Half B (#14); older workers omit them safely.
            const roster = partyState.roster || [];
            const onlineCount = roster.filter(m => m.online).length;
            countEl.textContent = `${onlineCount}/${roster.length}`;

            if (roster.length === 0) {
                container.innerHTML = '<div class="party-member-item loading">Waiting for members...</div>';
                return;
            }

            // HALF B (#14) — grace period for brand-new members before showing "⚠ not logging".
            // T&L flushes the combat log in batches (not per-hit), so the FIRST post_fight arrives
            // only after the first combat segment ends + idle timeout fires (~45–60 s). A member
            // who just joined needs at least that long before we can fairly flag them as dark.
            // We use a TWO-TIER threshold:
            //   joined_age_s < GRACE_S  → show "joining…" (neutral, no alarm)
            //   joined_age_s >= GRACE_S AND !has_posted → show "⚠ not logging" (alarm)
            //   has_posted              → no transmit indicator (normal)
            // The worker sends `joined_age_s`; if absent (old worker), treat as 0 (grace).
            const TRANSMIT_GRACE_S = 90; // 90 s before flagging as "not logging"

            container.innerHTML = roster.map(m => {
                const isLeader = !!m.is_leader;
                const isSelf = m.user_id === partyState.user_id;
                const isOnline = !!m.online;
                const safeName = escapeHtml(m.username);

                let badges = '';
                if (isLeader) badges += '<span class="party-member-badge leader">👑</span>';
                if (isSelf) badges += '<span class="party-member-badge you">YOU</span>';

                // Half B (#14): per-member transmit indicator on the ROSTER row.
                // Only shown for online members (offline members can't be transmitting).
                // Self is excluded — your own log status is the Half A banner above.
                let transmitBadge = '';
                if (isOnline && !isSelf && m.has_posted === false) {
                    // has_posted is explicitly false (not just absent — old worker = undefined).
                    const ageS = typeof m.joined_age_s === 'number' ? m.joined_age_s : 0;
                    if (ageS >= TRANSMIT_GRACE_S) {
                        // Been in the room long enough — definitely not posting.
                        transmitBadge = '<span title="This player has not sent any combat data — their logging may be OFF" '
                            + 'style="margin-left:4px;padding:1px 6px;font-size:0.68rem;'
                            + 'background:rgba(251,191,36,0.2);border:1px solid rgba(251,191,36,0.55);'
                            + 'color:#fbbf24;border-radius:4px;white-space:nowrap;">⚠ not logging</span>';
                    } else {
                        // Still within grace — just joined, waiting for first combat flush.
                        transmitBadge = '<span title="Waiting for first combat data from this player" '
                            + 'style="margin-left:4px;padding:1px 6px;font-size:0.68rem;'
                            + 'background:rgba(100,116,139,0.15);border:1px solid rgba(100,116,139,0.4);'
                            + 'color:#94a3b8;border-radius:4px;white-space:nowrap;">joining…</span>';
                    }
                }

                // Kick button — leader-only, not shown for self (can kick ANY non-self member
                // regardless of joining/posting state — the leader needs to be able to remove
                // stuck/offline members even if they never posted a fight).
                const canKick = partyState.is_leader && !isSelf;
                const kickBtn = canKick
                    ? `<button class="party-kick-btn" onclick="kickPartyMember('${escapeHtml(m.user_id)}','${escapeHtml(m.username)}')" `
                      + `title="Kick ${escapeHtml(m.username)}" `
                      + `style="margin-left:4px;padding:1px 7px;font-size:0.7rem;background:rgba(239,68,68,0.25);border:1px solid rgba(239,68,68,0.5);color:#fca5a5;border-radius:4px;cursor:pointer;">✕ Kick</button>`
                    : '';

                // Make Leader button — visible only when local client is leader AND this is not
                // the leader's own row (can't transfer crown to yourself).
                const canMakeLeader = partyState.is_leader && !isSelf && !isLeader;
                const makeLeaderBtn = canMakeLeader
                    ? `<button class="party-make-leader-btn" onclick="makePartyLeader('${escapeHtml(m.user_id)}','${escapeHtml(m.username)}')" `
                      + `title="Transfer leader to ${escapeHtml(m.username)}" `
                      + `style="margin-left:4px;padding:1px 7px;font-size:0.7rem;background:rgba(250,204,21,0.2);border:1px solid rgba(250,204,21,0.45);color:#fbbf24;border-radius:4px;cursor:pointer;">👑 Lead</button>`
                    : '';

                return `
                    <div class="party-member-item ${isLeader ? 'leader' : ''} ${isSelf ? 'self' : ''} ${!isOnline ? 'offline' : ''}">
                        <span class="party-member-status ${isOnline ? 'online' : 'offline'}"></span>
                        <span class="party-member-name">${safeName}</span>
                        ${badges}${transmitBadge}${makeLeaderBtn}${kickBtn}
                    </div>
                `;
            }).join('');

            // Reset Roster button — appended below the list, leader-only.
            // Semantics (v2): removes only OFFLINE members; online members are kept.
            if (partyState.is_leader) {
                container.innerHTML += `<div style="margin-top:8px;text-align:right;">
                    <button onclick="resetPartyRoster()" title="Remove offline / disconnected members (online members are kept)" `
                    + `style="padding:3px 10px;font-size:0.72rem;background:rgba(100,116,139,0.2);border:1px solid rgba(100,116,139,0.4);color:#94a3b8;border-radius:4px;cursor:pointer;">🔄 Clear Offline</button>
                </div>`;
            }
        }

        // Kick a member (leader only) — sends the worker kick command.
        // Bug fix: worker expects `user_id` (not `target_uid`) in the kick message.
        async function kickPartyMember(userId, username) {
            if (!partyState.is_leader) return;
            if (!await partyConfirm(`Kick ${username} from the party?`)) return;
            if (!partyWS || partyWS.readyState !== WebSocket.OPEN) {
                console.warn('[Party] kick: WS not open');
                return;
            }
            try {
                partyWS.send(JSON.stringify({ type: 'kick', user_id: userId }));
                partyDebug('party.kick', { user_id: userId, username: username });
            } catch (err) {
                console.error('[Party] Error sending kick:', err);
            }
        }

        // Make Leader (leader only) — transfers the crown to another party member.
        async function makePartyLeader(userId, username) {
            if (!partyState.is_leader) return;
            if (!await partyConfirm(`Transfer party leader to ${username}?\nYou will no longer be the leader.`)) return;
            if (!partyWS || partyWS.readyState !== WebSocket.OPEN) {
                console.warn('[Party] make_leader: WS not open');
                return;
            }
            try {
                partyWS.send(JSON.stringify({ type: 'make_leader', user_id: userId }));
                partyDebug('party.make_leader', { user_id: userId, username: username });
            } catch (err) {
                console.error('[Party] Error sending make_leader:', err);
            }
        }

        // Reset roster (leader only) — evicts OFFLINE members server-side.
        // Online (connected) members are kept; only disconnected/stale slots are removed.
        async function resetPartyRoster() {
            if (!partyState.is_leader) return;
            if (!await partyConfirm('Clear offline members from the roster?\nOnline members will NOT be removed.')) return;
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
            { bg: 'rgba(217, 100, 68, 0.25)', border: 'rgba(217, 100, 68, 0.5)', text: '#D96444' },   // Cyan
            { bg: 'rgba(91, 146, 212, 0.25)', border: 'rgba(91, 146, 212, 0.5)', text: '#5B92D4' }, // Purple
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
