        async function saveEncounterEdit() {
            const id = document.getElementById('editEncounterId').value;
            const classValue = document.getElementById('editClassSelect').value;
            const buildTag = document.getElementById('editBuildTagInput').value.trim();
            const notes = document.getElementById('editEncounterNotes').value.trim();

            if (!buildTag) {
                await partyAlert('Please enter a build tag');
                return;
            }
            
            // Find class info
            const classInfo = TL_CLASSES.find(c => c.name === classValue);
            
            sendCommand('update_encounter', {
                id: id,
                build_tag: buildTag,
                notes: notes,
                player_class: classValue,
                class_weapons: classInfo ? classInfo.weapons : ''
            });
            
            closeEditEncounterModal();
        }

        function switchTab(tabName) {
            // Find and click the tab
            const tab = document.querySelector(`[data-tab="${tabName}"]`);
            if (tab) tab.click();
        }

        function updateDashboard() {
            // Update test count
            const testCount = savedEncounters ? savedEncounters.length : 0;
            const testCountEl = document.getElementById('dashTestsCount');
            if (testCountEl) testCountEl.textContent = testCount;
            
            // Update run count
            const runCount = runSummaryData ? runSummaryData.length : 0;
            const runCountEl = document.getElementById('dashRunsCount');
            if (runCountEl) runCountEl.textContent = runCount;
            
            // Find highest hit and best DPS
            let highestHit = 0;
            let highestHitSkill = '--';
            let bestDps = 0;
            let bestDpsClass = '--';
            
            if (savedEncounters && savedEncounters.length > 0) {
                savedEncounters.forEach(enc => {
                    // Check for highest hit
                    if (enc.overall && enc.overall.top_hits && enc.overall.top_hits.length > 0) {
                        const topHit = enc.overall.top_hits[0];
                        if (topHit.damage > highestHit) {
                            highestHit = topHit.damage;
                            highestHitSkill = topHit.skill;
                        }
                    }
                    // Check for best DPS
                    if (enc.first_60s && enc.first_60s.dps > bestDps) {
                        bestDps = enc.first_60s.dps;
                        bestDpsClass = enc.player_class || enc.build_tag || '--';
                    }
                });
            }
            
            const highestHitEl = document.getElementById('dashHighestHit');
            const highestHitSkillEl = document.getElementById('dashHighestHitSkill');
            const bestDpsEl = document.getElementById('dashBestDps');
            const bestDpsClassEl = document.getElementById('dashBestDpsClass');
            
            if (highestHitEl) highestHitEl.textContent = highestHit > 0 ? formatNumber(highestHit) : '0';
            if (highestHitSkillEl) highestHitSkillEl.textContent = highestHitSkill;
            if (bestDpsEl) bestDpsEl.textContent = bestDps > 0 ? formatNumber(Math.round(bestDps)) : '0';
            if (bestDpsClassEl) bestDpsClassEl.textContent = bestDpsClass;
            
            // Update class performance grid
            const classGrid = document.getElementById('dashClassGrid');
            if (classGrid && savedEncounters && savedEncounters.length > 0) {
                const classStats = {};
                savedEncounters.forEach(enc => {
                    const className = enc.player_class || 'Unassigned';
                    if (!classStats[className]) {
                        classStats[className] = { count: 0, totalDps: 0, bestDps: 0, weapons: enc.class_weapons || '' };
                    }
                    classStats[className].count++;
                    classStats[className].totalDps += (enc.first_60s?.dps || 0);
                    if ((enc.first_60s?.dps || 0) > classStats[className].bestDps) {
                        classStats[className].bestDps = enc.first_60s?.dps || 0;
                    }
                });
                
                const sortedClasses = Object.entries(classStats).sort((a, b) => b[1].bestDps - a[1].bestDps);
                
                if (sortedClasses.length > 0) {
                    classGrid.innerHTML = sortedClasses.map(([name, stats]) => `
                        <div class="dashboard-class-card">
                            <div class="dashboard-class-name">${name}</div>
                            <div class="dashboard-class-weapons">${stats.weapons || '--'}</div>
                            <div class="dashboard-class-stats">
                                <div class="dashboard-class-stat">
                                    <div class="dashboard-class-stat-value">${stats.count}</div>
                                    <div class="dashboard-class-stat-label">Tests</div>
                                </div>
                                <div class="dashboard-class-stat">
                                    <div class="dashboard-class-stat-value">${formatNumber(Math.round(stats.bestDps))}</div>
                                    <div class="dashboard-class-stat-label">Best DPS</div>
                                </div>
                                <div class="dashboard-class-stat">
                                    <div class="dashboard-class-stat-value">${formatNumber(Math.round(stats.totalDps / stats.count))}</div>
                                    <div class="dashboard-class-stat-label">Avg DPS</div>
                                </div>
                            </div>
                        </div>
                    `).join('');
                }
            }
            
            // Update recent activity
            const activityDiv = document.getElementById('dashRecentActivity');
            if (!activityDiv) return;
            
            const recentItems = [];
            
            if (savedEncounters) {
                savedEncounters.slice(0, 5).forEach(enc => {
                    recentItems.push({
                        type: 'test',
                        name: enc.build_tag || 'Build Test',
                        meta: enc.player_class || '',
                        dps: enc.first_60s?.dps || 0,
                        timestamp: new Date(enc.timestamp)
                    });
                });
            }
            
            if (runSummaryData) {
                runSummaryData.slice(0, 5).forEach(run => {
                    recentItems.push({
                        type: 'run',
                        name: run.run_name || run.dungeon_name || 'Dungeon Run',
                        meta: run.dungeon_category || '',
                        dps: run.stats?.dps || 0,
                        timestamp: new Date(run.created_at)
                    });
                });
            }
            
            recentItems.sort((a, b) => b.timestamp - a.timestamp);
            
            if (recentItems.length > 0) {
                activityDiv.innerHTML = recentItems.slice(0, 8).map(item => {
                    const timeAgo = formatTimeAgo(item.timestamp);
                    const icon = item.type === 'test' ? '🎯' : '🏰';
                    return `
                        <div class="dashboard-activity-item">
                            <div class="dashboard-activity-icon">${icon}</div>
                            <div class="dashboard-activity-info">
                                <div class="dashboard-activity-title">${item.name}</div>
                                <div class="dashboard-activity-meta">${item.meta}</div>
                            </div>
                            <div class="dashboard-activity-value">
                                <div class="dashboard-activity-dps">${formatNumber(Math.round(item.dps))} DPS</div>
                                <div class="dashboard-activity-time">${timeAgo}</div>
                            </div>
                        </div>
                    `;
                }).join('');
            }
        }

        function formatTimeAgo(date) {
            const seconds = Math.floor((new Date() - date) / 1000);
            if (seconds < 60) return 'just now';
            const minutes = Math.floor(seconds / 60);
            if (minutes < 60) return `${minutes}m ago`;
            const hours = Math.floor(minutes / 60);
            if (hours < 24) return `${hours}h ago`;
            const days = Math.floor(hours / 24);
            return `${days}d ago`;
        }

        function openSettings() { document.getElementById('settingsModal').classList.add('active'); }
        function closeSettings() { document.getElementById('settingsModal').classList.remove('active'); }

        function openLogsFolder() {
            sendCommand('open_logs_folder');
        }

        function openDataFolder() {
            sendCommand('open_data_folder');
        }

        async function resetData() {
            const message = `♻️ Reset App Data\n\n` +
                `This permanently clears ALL saved encounters and saved runs.\n\n` +
                `Your settings (skill/weapon/target config) and presets are kept.\n` +
                `Your combat log files are NOT touched.\n\n` +
                `This cannot be undone. Continue?`;
            if (await partyConfirm(message)) {
                sendCommand('reset_data');
            }
        }

        function updateLogInfo(info) {
            if (!info) return;
            
            // Update current log file name
            const fileEl = document.getElementById('currentLogFile');
            if (fileEl && info.current_file) {
                fileEl.textContent = info.current_file;
            } else if (fileEl) {
                fileEl.textContent = 'Not detected';
            }
            
            // Update file size
            const fileSizeEl = document.getElementById('logFileSize');
            if (fileSizeEl) {
                fileSizeEl.textContent = info.file_size || '--';
            }
            
            // Update folder size
            const folderSizeEl = document.getElementById('logFolderSize');
            if (folderSizeEl) {
                folderSizeEl.textContent = info.folder_size || '--';
            }
            
            // Update file count
            const fileCountEl = document.getElementById('logFileCount');
            if (fileCountEl && info.file_count !== undefined) {
                fileCountEl.textContent = `${info.file_count} log file${info.file_count !== 1 ? 's' : ''} in folder`;
            }
            
            // Update welcome modal status
            const detected = !!(info.current_file && info.current_file !== 'Not detected');
            lastLogFile = detected ? info.current_file : null;  // feeds the diagnostics check
            updateWelcomeModalStatus(detected);
        }

        function openGuide() { document.getElementById('guideModal').classList.add('active'); }
        function closeGuide() { document.getElementById('guideModal').classList.remove('active'); }

        // === DATA HEALTH INFO ===
        function showDataHealthInfo(type) {
            const modal = document.getElementById('dataHealthInfoModal');
            const title = document.getElementById('dataHealthInfoTitle');
            const content = document.getElementById('dataHealthInfoContent');
            
            if (type === 'targets') {
                title.innerHTML = '🎯 Unassigned Targets<button onclick="closeDataHealthInfo()">×</button>';
                content.innerHTML = `
                    <p><strong>What are target assignments?</strong></p>
                    <p style="margin: 12px 0; color: #94a3b8;">Each enemy you fight can be assigned to a category: Archboss, Raid Boss, Field Boss, Dungeon Boss, Adds, or Other.</p>
                    
                    <p style="margin-top: 16px;"><strong>Why does this matter?</strong></p>
                    <ul style="margin: 12px 0; padding-left: 20px; color: #94a3b8;">
                        <li style="margin-bottom: 8px;"><strong style="color: #D96444;">Run Builder</strong> — Encounters display with proper boss/adds styling and icons</li>
                        <li style="margin-bottom: 8px;"><strong style="color: #D96444;">Merge Detection</strong> — Boss wipes can be merged (only works for boss categories)</li>
                        <li style="margin-bottom: 8px;"><strong style="color: #D96444;">Run Summary</strong> — Accurate Boss DPS vs Trash DPS breakdowns</li>
                        <li style="margin-bottom: 8px;"><strong style="color: #D96444;">Encounter Detection</strong> — 30s gap rule only applies to bosses</li>
                    </ul>
                    
                    <p style="margin-top: 16px; color: #64748b; font-size: 0.85rem;">Click this card to open Target Assignment settings.</p>
                `;
            } else if (type === 'skills') {
                title.innerHTML = '⚔️ Unassigned Skills<button onclick="closeDataHealthInfo()">×</button>';
                content.innerHTML = `
                    <p><strong>What are skill weapon assignments?</strong></p>
                    <p style="margin: 12px 0; color: #94a3b8;">Each skill can be assigned to a weapon category (Greatsword, Staff, Longbow, etc.) for analysis.</p>
                    
                    <p style="margin-top: 16px;"><strong>Why does this matter?</strong></p>
                    <ul style="margin: 12px 0; padding-left: 20px; color: #94a3b8;">
                        <li style="margin-bottom: 8px;"><strong style="color: #5B92D4;">Weapon Breakdown</strong> — See damage distribution by weapon type</li>
                        <li style="margin-bottom: 8px;"><strong style="color: #5B92D4;">Build Comparison</strong> — Compare weapon performance across builds</li>
                        <li style="margin-bottom: 8px;"><strong style="color: #5B92D4;">Rotation Analysis</strong> — Understand weapon swap patterns</li>
                    </ul>
                    
                    <p style="margin-top: 16px; color: #64748b; font-size: 0.85rem;">Click this card to open Skill Settings.</p>
                `;
            }
            
            modal.style.display = 'flex';
        }
        
        function closeDataHealthInfo() {
            document.getElementById('dataHealthInfoModal').style.display = 'none';
        }
        
        function updateDataHealthCounts() {
            // Count unassigned targets
            let unassignedTargetCount = 0;
            if (typeof allKnownTargets !== 'undefined' && typeof targetAssignments !== 'undefined') {
                allKnownTargets.forEach(target => {
                    if (!targetAssignments[target]) {
                        unassignedTargetCount++;
                    }
                });
            }
            
            // Count unassigned skills (check weapon assignments)
            let unassignedSkillCount = 0;
            if (typeof allKnownSkills !== 'undefined') {
                const skillAssignments = (typeof weaponConfig !== 'undefined' && weaponConfig.skillAssignments) ? weaponConfig.skillAssignments : {};
                allKnownSkills.forEach(skill => {
                    if (!skillAssignments[skill]) {
                        unassignedSkillCount++;
                    }
                });
            }
            
            // Update counts in UI
            const targetCountEl = document.getElementById('unassignedTargetsCount');
            const skillCountEl = document.getElementById('unassignedSkillsCount');
            const targetCard = document.getElementById('unassignedTargetsCard');
            const skillCard = document.getElementById('unassignedSkillsCard');
            
            if (targetCountEl) {
                targetCountEl.textContent = unassignedTargetCount;
                if (targetCard) {
                    if (unassignedTargetCount === 0) {
                        targetCountEl.style.color = '#22c55e';
                        targetCard.style.background = 'rgba(34, 197, 94, 0.08)';
                        targetCard.style.borderColor = 'rgba(34, 197, 94, 0.25)';
                        targetCard.onmouseover = function() { this.style.background = 'rgba(34, 197, 94, 0.15)'; };
                        targetCard.onmouseout = function() { this.style.background = 'rgba(34, 197, 94, 0.08)'; };
                    } else {
                        targetCountEl.style.color = '#fbbf24';
                        targetCard.style.background = 'rgba(251, 191, 36, 0.08)';
                        targetCard.style.borderColor = 'rgba(251, 191, 36, 0.25)';
                        targetCard.onmouseover = function() { this.style.background = 'rgba(251, 191, 36, 0.15)'; };
                        targetCard.onmouseout = function() { this.style.background = 'rgba(251, 191, 36, 0.08)'; };
                    }
                }
            }
            
            if (skillCountEl) {
                skillCountEl.textContent = unassignedSkillCount;
                if (skillCard) {
                    if (unassignedSkillCount === 0) {
                        skillCountEl.style.color = '#22c55e';
                        skillCard.style.background = 'rgba(34, 197, 94, 0.08)';
                        skillCard.style.borderColor = 'rgba(34, 197, 94, 0.25)';
                        skillCard.onmouseover = function() { this.style.background = 'rgba(34, 197, 94, 0.15)'; };
                        skillCard.onmouseout = function() { this.style.background = 'rgba(34, 197, 94, 0.08)'; };
                    } else {
                        skillCountEl.style.color = '#5B92D4';
                        skillCard.style.background = 'rgba(168, 85, 247, 0.08)';
                        skillCard.style.borderColor = 'rgba(168, 85, 247, 0.25)';
                        skillCard.onmouseover = function() { this.style.background = 'rgba(168, 85, 247, 0.15)'; };
                        skillCard.onmouseout = function() { this.style.background = 'rgba(168, 85, 247, 0.08)'; };
                    }
                }
            }
        }

        function toggleAccordion(header) {
            const item = header.parentElement;
            item.classList.toggle('open');
        }

        function saveSettings() {
            sendCommand('set_config', {
                config: {
                    log_path: document.getElementById('logPath').value.trim(),
                    player_name: document.getElementById('playerName').value.trim(),
                    hotkey_enabled: document.getElementById('hotkeyEnabled').checked,
                    hotkey: document.getElementById('hotkeySelect').value,
                    hotkey_sound: document.getElementById('hotkeySound').checked
                }
            });
        }
        
        // === SOUND ===
        // Self-contained WebAudio beep — no asset-path dependency, works in
        // packaged offline build (pywebview/WebView2).  Short 80 ms descending
        // tone: 880 Hz → 440 Hz with a quick fade-out.
        function playBeepSound() {
            try {
                const ctx = new (window.AudioContext || window.webkitAudioContext)();
                if (ctx.state === 'suspended' && ctx.resume) ctx.resume(); // WebView2 often starts the context suspended
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.connect(gain);
                gain.connect(ctx.destination);
                osc.type = 'sine';
                osc.frequency.setValueAtTime(880, ctx.currentTime);
                osc.frequency.linearRampToValueAtTime(440, ctx.currentTime + 0.08);
                gain.gain.setValueAtTime(0.4, ctx.currentTime);
                gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.12);
                osc.start(ctx.currentTime);
                osc.stop(ctx.currentTime + 0.13);
                osc.onended = () => ctx.close();
            } catch (e) {
                console.warn('[Sound] playBeepSound failed:', e);
            }
        }

        function testHotkeySound() {
            // Test Sound button IS a user gesture — play immediately, no backend
            // round-trip required.  Also inform the backend (for logging/ack).
            playBeepSound();
            sendCommand('test_hotkey');
        }

        // === WEBSOCKET ===

        function connect() {
            ws = new WebSocket(WS_URL);
            ws.onopen = () => {
                setConnectionStatus(true);
                hideDisconnectedBanner();  // Hide banner when connected
                if (reconnectInterval) { clearInterval(reconnectInterval); reconnectInterval = null; }
                sendCommand('get_config');
                sendCommand('get_encounters');
                sendCommand('get_saved_runs');
                sendCommand('get_skill_settings');
                sendCommand('get_weapon_config');
                sendCommand('get_target_assignments');
                sendCommand('get_default_targets');
                sendCommand('get_dungeons');
                sendCommand('get_encounter_history');  // Populate Encounters tab
                sendCommand('get_suggested_names');     // B1: default the party display-name box
            };
            ws.onmessage = (event) => {
                const msg = JSON.parse(event.data);
                
                if (msg.type === 'stats') {
                    // Handle reset pending - check for fresh data
                    if (resetPending && msg.data && msg.data.duration < 1) {
                        resetPending = false;
                        console.log('Reset complete - fresh data received');
                    }
                    
                    // Don't update UI with live stats if viewing a loaded encounter
                    if (isViewingLoadedEncounter) {
                        // Still store the live stats so we can restore later
                        lastLiveStats = msg.data;
                        // But still update the Log tab with live data (it's separate from encounter view)
                        updateCombatLog(msg.data.hit_log || msg.data.top_hits);
                        // Debug: log that we're skipping UI update
                        console.log('Skipping UI update - viewing loaded encounter');
                    } else if (resetPending) {
                        // Ignore stale stats while waiting for reset to complete
                        console.log('Skipping UI update - reset pending, duration:', msg.data?.duration);
                    } else {
                        updateStats(msg.data);
                    }
                    // Always update Build Testing tab status
                    updateBuildTestingTab(msg.data);
                    if (msg.license) {
                        updateLicenseInfo(msg.license);
                    }
                    // Update party status from stats broadcast
                    if (msg.party_status) {
                        updatePartyStatus(msg.party_status);
                    }
                    // Update log info from stats broadcast
                    if (msg.log_info) {
                        updateLogInfo(msg.log_info);
                    }
                    // Track last log activity for diagnostics
                    if (msg.data && msg.data.hit_count > 0) {
                        lastLogActivity = Date.now();
                    }
                }
                else if (msg.type === 'party_status') {
                    // Standalone party status update
                    updatePartyStatus(msg.status);
                }
                else if (msg.type === 'party_recording_started') {
                    // Server started recording party stats
                    console.log('[Party] Recording started:', msg.status);
                    if (msg.status) updatePartyStatus(msg.status);
                }
                else if (msg.type === 'party_recording_stopped') {
                    // Server stopped recording — the final post below is authoritative, so cancel
                    // any pending live-hydration post.
                    if (partyLiveHitDebounce) { clearTimeout(partyLiveHitDebounce); partyLiveHitDebounce = null; }
                    console.log('[Party] Recording stopped, final results:', msg.results);
                    if (msg.status) updatePartyStatus(msg.status);
                    
                    // Flush any pending renders
                    flushPartyResults();
                    
                    // Post this member's full per-target breakdown to the room. The room
                    // picks the boss server-side, filters trash, and broadcasts the merged
                    // ranked scoreboard back to everyone (post-combat model).
                    const nTargets = (msg.results && msg.results.targets) ? msg.results.targets.length : 0;
                    const wsOpen = !!(partyWS && partyWS.readyState === WebSocket.OPEN);
                    if (nTargets && wsOpen && partyState.party_code) {
                        try {
                            partyWS.send(JSON.stringify({
                                type: 'post_fight',
                                v: 2,
                                fight_ts: msg.results.fight_ts || Date.now(),
                                // Per-encounter id (Phase 2 / A3) — the room slots the
                                // submission under this encounter. Fall back to fight_ts.
                                encounter_id: msg.results.encounter_id || (msg.results.fight_ts ? String(msg.results.fight_ts) : undefined),
                                targets: msg.results.targets,
                                summary: { total_damage: msg.results.total_damage, duration: msg.results.duration },
                                // C1b: the final post carries the full hit slice (rotation); the
                                // room stores it opaquely (C1a SQLite) for drill-down (C3). `skills`
                                // is derived later — stays null for now.
                                skills: null,
                                rotation: msg.results.rotation || null
                            }));
                            console.log('[Party] Posted fight to room:', nTargets, 'targets');
                            partyDebug('party.post_fight.sent', { targets: nTargets, fight_ts: msg.results.fight_ts });
                        } catch (err) {
                            console.warn('[Party] Error posting fight:', err);
                            partyDebug('party.post_fight.error', { err: String(err) });
                        }
                    } else {
                        // No post — explains an empty board. (no damage, room socket down, or not in a party)
                        partyDebug('party.post_fight.skipped', { targets: nTargets, wsOpen: wsOpen, code: partyState.party_code || null });
                    }
                }
                else if (msg.type === 'party_final') {
                    // Keystone bridge (2026-05-31): the backend auto-closed an encounter (45s idle
                    // timeout or manual stop) and sent the full breakdown. Post the authoritative
                    // board to the room FIRST (so the submission row exists), THEN ship the rich
                    // detail (skills+rotation, incl crit/heavy) via final_detail so drill-down
                    // populates. Order matters — the worker's final_detail only sets has_detail if
                    // the submission row already exists.
                    if (partyLiveHitDebounce) { clearTimeout(partyLiveHitDebounce); partyLiveHitDebounce = null; }
                    flushPartyResults();
                    const d = msg.detail || {};
                    const encId = msg.encounter_id || (msg.fight_ts ? String(msg.fight_ts) : undefined);
                    const wsOpen = !!(partyWS && partyWS.readyState === WebSocket.OPEN);
                    const nTargets = (d.targets || []).length;
                    if (encId && wsOpen && partyState.party_code && nTargets) {
                        try {
                            partyWS.send(JSON.stringify({
                                type: 'post_fight', v: 2,
                                fight_ts: msg.fight_ts || Date.now(),
                                encounter_id: encId,
                                targets: d.targets,
                                summary: { total_damage: d.total_damage, duration: d.duration },
                                skills: d.skills || null,
                                rotation: d.rotation || null
                            }));
                            partyWS.send(JSON.stringify({
                                type: 'final_detail', encounter_id: encId, detail: d
                            }));
                            partyDebug('party.final.sent', { encounter_id: encId, targets: nTargets, skills: (d.skills || []).length });
                        } catch (err) {
                            partyDebug('party.final.error', { err: String(err) });
                        }
                    } else {
                        partyDebug('party.final.skipped', { targets: nTargets, wsOpen: wsOpen, code: partyState.party_code || null });
                    }
                }
                else if (msg.type === 'party_stats') {
                    // Current party stats (without stopping)
                    console.log('[Party] Stats:', msg.results);
                    if (msg.status) updatePartyStatus(msg.status);
                }
                else if (msg.type === 'party_live_hit') {
                    // LIVE HYDRATION (Workstream B): the local server emits the running party
                    // total on every ingested hit. T&L flushes the combat log in BURSTS at each
                    // combat-exit, so these arrive as a burst then go quiet. Trailing-debounce to
                    // coalesce each flush-burst into ONE post_fight of the current running total →
                    // each member's row hydrates per combat-exit during the run. (Stop still sends
                    // the final authoritative post.)
                    lastLogActivity = Date.now();
                    const totals = msg.totals;
                    if (totals && totals.targets && totals.targets.length &&
                        partyWS && partyWS.readyState === WebSocket.OPEN && partyState.party_code) {
                        const postEncounter = (includeRotation = false) => {
                            partyWS.send(JSON.stringify({
                                type: 'post_fight',
                                v: 2,
                                fight_ts: totals.fight_ts || Date.now(),
                                // Per-encounter id (Phase 2 / A3): which encounter this board
                                // belongs to. The backend tags it; fall back to fight_ts.
                                encounter_id: totals.encounter_id || (totals.fight_ts ? String(totals.fight_ts) : undefined),
                                targets: totals.targets,
                                summary: { total_damage: totals.total_damage, duration: totals.duration },
                                skills: null,
                                // C1b: only the FINAL post (boundary close) carries the heavy hit
                                // slice; debounced live ticks stay light (rotation null).
                                rotation: includeRotation ? (totals.rotation || null) : null
                            }));
                        };
                        if (msg.final) {
                            // A boundary just closed this encounter — post its authoritative
                            // board NOW (don't debounce; the next encounter is already arming).
                            if (partyLiveHitDebounce) { clearTimeout(partyLiveHitDebounce); partyLiveHitDebounce = null; }
                            try {
                                postEncounter(true);  // C1b: final post carries the hit slice
                                // Keystone (2026-05-31): if the boundary frame carries the rich
                                // detail (skills incl crit/heavy), ship it so drill-down populates.
                                if (msg.detail) {
                                    const encId = totals.encounter_id || (totals.fight_ts ? String(totals.fight_ts) : undefined);
                                    partyWS.send(JSON.stringify({ type: 'final_detail', encounter_id: encId, detail: msg.detail }));
                                }
                                partyDebug('party.live_post.final', { encounter_id: totals.encounter_id, targets: totals.targets.length, detail: !!msg.detail });
                            } catch (err) {
                                partyDebug('party.live_post.error', { err: String(err) });
                            }
                        } else {
                            // Live hydration: coalesce the flush-burst into ONE post.
                            if (partyLiveHitDebounce) clearTimeout(partyLiveHitDebounce);
                            partyLiveHitDebounce = setTimeout(() => {
                                partyLiveHitDebounce = null;
                                try {
                                    postEncounter();
                                    partyDebug('party.live_post', { encounter_id: totals.encounter_id, targets: totals.targets.length });
                                } catch (err) {
                                    partyDebug('party.live_post.error', { err: String(err) });
                                }
                            }, 1200);
                        }
                    }
                }
                else if (msg.type === 'party_stats_reset') {
                    // Party stats were reset
                    console.log('[Party] Stats reset');
                    if (msg.status) updatePartyStatus(msg.status);
                }
                else if (msg.type === 'party_created') {
                    handlePartyCreated(msg);
                }
                else if (msg.type === 'party_joined') {
                    handlePartyJoined(msg);
                }
                else if (msg.type === 'party_left') {
                    handlePartyLeft(msg);
                }
                else if (msg.type === 'party_members') {
                    handlePartyMembers(msg);
                    if (msg.status) updatePartyStatus(msg.status);
                }
                else if (msg.type === 'party_results') {
                    handlePartyResults(msg);
                    if (msg.status) updatePartyStatus(msg.status);
                }
                else if (msg.type === 'party_encounter_started') {
                    if (msg.status) updatePartyStatus(msg.status);
                }
                else if (msg.type === 'party_encounter_ended') {
                    if (msg.status) updatePartyStatus(msg.status);
                    refreshPartyResults();
                }
                else if (msg.type === 'suggested_names') {
                    renderNameSuggestions(msg.names || []);
                }
                else if (msg.type === 'config') {
                    document.getElementById('logPath').value = msg.data.log_path || '';
                    document.getElementById('playerName').value = msg.data.player_name || '';
                    document.getElementById('hotkeyEnabled').checked = msg.data.hotkey_enabled !== false;
                    document.getElementById('hotkeySelect').value = msg.data.hotkey || 'ctrl+tab';
                    document.getElementById('hotkeySound').checked = msg.data.hotkey_sound !== false;
                }
                else if (msg.type === 'config_saved') {
                    closeSettings();
                }
                else if (msg.type === 'encounters') {
                    savedEncounters = msg.data.encounters || [];
                    buildTags = msg.data.builds || [];
                    updateSavedEncountersList();
                    updateClassFilters();
                    updateBuildFilters();
                    updateBuildDisplay();
                    encounters = savedEncounters; // Keep global reference
                    updateLibraryCountsBanner();
                    updateDashboard();
                }
                else if (msg.type === 'data_reset') {
                    // Backend cleared saved encounters + runs; re-fetch the lists.
                    sendCommand('get_encounters');
                    sendCommand('get_saved_runs');
                    sendCommand('get_encounter_history');
                    partyAlert('✅ App data reset — saved encounters and runs cleared.');
                }
                else if (msg.type === 'encounter_saved') {
                    savedEncounters.unshift(msg.encounter);
                    buildTags = msg.builds || buildTags;
                    if (!buildTags.includes(msg.encounter.build_tag)) {
                        buildTags.push(msg.encounter.build_tag);
                    }
                    updateSavedEncountersList();
                    updateClassFilters();
                    updateBuildFilters();
                    updateBuildDisplay();
                    encounters = savedEncounters;
                    updateDashboard();

                    // Check if this save belongs to a session queue item (placeholder tag)
                    const pendingItem = sessionQueue.find(item => !item.id && item.tempTag === msg.encounter.build_tag);
                    if (pendingItem) {
                        pendingItem.id = msg.encounter.id;
                        renderSessionQueue();
                        // Don't close save modal — we never opened it for queue auto-saves
                    } else {
                        closeSaveModal();
                    }
                }
                else if (msg.type === 'encounter_updated') {
                    // Find and update the encounter in our list
                    const index = savedEncounters.findIndex(e => e.id === msg.encounter.id);
                    if (index !== -1) {
                        savedEncounters[index] = msg.encounter;
                    }
                    buildTags = msg.builds || buildTags;
                    updateSavedEncountersList();
                    updateClassFilters();
                    updateBuildFilters();
                    updateBuildDisplay();
                    updateDashboard();
                    encounters = savedEncounters;

                    // Mark session queue item as saved
                    const queueItem = sessionQueue.find(item => item.id === msg.encounter.id);
                    if (queueItem) {
                        queueItem.saved = true;
                        renderSessionQueue();
                        // If all items are now saved, auto-clear queue after a short delay
                        if (sessionQueue.length > 0 && sessionQueue.every(item => item.saved)) {
                            setTimeout(() => {
                                sessionQueue = [];
                                sessionRunCounter = 0;
                                renderSessionQueue();
                                const panel = document.getElementById('sessionQueuePanel');
                                if (panel) panel.style.display = 'none';
                            }, 2500);
                        }
                    }
                }
                else if (msg.type === 'encounter_deleted') {
                    // Backend returns `encounter_id` (not `id`); reading msg.id left the
                    // row on screen — the "can't delete" bug. Accept either field.
                    const delId = msg.encounter_id || msg.id;
                    savedEncounters = savedEncounters.filter(e => e.id !== delId);
                    // Remove from build assignments
                    ['A', 'B', 'C'].forEach(letter => {
                        buildAssignments[letter] = buildAssignments[letter].filter(id => id !== delId);
                    });
                    updateSavedEncountersList();
                    updateClassFilters();
                    updateBuildFilters();
                    updateBuildDisplay();
                    updateComparison();
                    updateDashboard();
                }
                else if (msg.type === 'log_purged') {
                    partyAlert('✔ Log file purged successfully!\n\nFile: ' + (msg.file || 'Unknown'));
                    clearFullSessionLog();  // Clear the persistent log display
                }
                else if (msg.type === 'skill_settings') {
                    skillSettings = msg.data.settings || {};
                    currentSkills = msg.data.current_skills || [];
                    updateSkillSettingsUI();
                }
                // Weapon config handlers
                else if (msg.type === 'weapon_config') {
                    handleWeaponConfigMessage(msg);
                }
                else if (msg.type === 'skill_assigned' || msg.type === 'skills_bulk_assigned') {
                    weaponConfig.skillAssignments = msg.assignments || weaponConfig.skillAssignments;
                    // Reset hash to force re-render after assignment change
                    lastSkillAssignmentHash = '';
                    recalculateWeaponBreakdown();
                }
                else if (msg.type === 'target_assignments') {
                    console.log('[TargetAssign] Raw message data:', msg.data);
                    console.log('[TargetAssign] msg.data.assignments:', msg.data.assignments);
                    console.log('[TargetAssign] Received from server:', Object.keys(msg.data.assignments || {}).length, 'assignments');
                    lastServerAssignments = msg.data.assignments || {};
                    initializeTargetAssignments(lastServerAssignments);
                }
                else if (msg.type === 'default_targets') {
                    displayDefaultTargets(msg.data || {});
                }
                else if (msg.type === 'target_assignment_saved') {
                    console.log('[TargetAssign] Saved:', msg.target_name, '→', msg.category);
                }
                else if (msg.type === 'encounter_history') {
                    displayEncounterHistory(msg.encounters || []);
                    displayEncounterTimeline(msg.encounters || []); // Also populate timeline for Run Builder
                    updateSessionEncountersList(msg.encounters || []); // Update Encounters tab
                    
                    // Track all target names for Target Assignment tab
                    (msg.encounters || []).forEach(enc => {
                        if (enc.target_name) {
                            addTargetFromLog(enc.target_name);
                        }
                    });
                }
                else if (msg.type === 'encounter_details') {
                    // Full encounter details received
                    if (msg.data) {
                        displayEncounterDetails(msg.data);
                    }
                }
                else if (msg.type === 'run_saved') {
                    partyAlert(msg.message || 'Run saved successfully!');
                    console.log('[RunBuilder] Run saved:', msg.run_id);
                    // Refresh saved runs list if visible
                    if (savedRunsVisible) {
                        loadSavedRuns();
                    }
                }
                else if (msg.type === 'saved_runs_list') {
                    displaySavedRuns(msg.runs || []);
                    // Also update Run Summary tab if it has data
                    renderRunSummary(msg.runs || []);
                }
                else if (msg.type === 'run_deleted') {
                    console.log('[RunBuilder] Run deleted:', msg.run_id);
                    // Refresh the list
                    loadSavedRuns();
                }
                else if (msg.type === 'run_updated') {
                    console.log('[RunSummary] Run updated:', msg.run_id);
                    // Refresh the runs list to show updated data
                    loadSavedRuns();
                    loadRunSummary();
                }
                else if (msg.type === 'dungeons_list') {
                    populateDungeonDropdown(msg.dungeons || {});
                }
                else if (msg.type === 'dungeon_added') {
                    console.log('[Dungeons] Dungeon added:', msg.dungeon_name);
                    populateDungeonDropdown(msg.dungeons || {});
                    // Hide add section and select the new dungeon
                    document.getElementById('addDungeonSection').style.display = 'none';
                    const select = document.getElementById('runDungeonSelect');
                    if (select) {
                        select.value = `${msg.category}|${msg.dungeon_name}`;
                    }
                }
                else if (msg.type === 'encounter_loaded') {
                    // Check if this load was triggered by the encounter save flow
                    if (savingFromEncounterHistory && pendingEncounterSave) {
                        const pending = pendingEncounterSave;
                        pendingEncounterSave      = null;
                        savingFromEncounterHistory = false;

                        // Step 2: backend now has the encounter in its live buffer — save it
                        setTimeout(() => {
                            sendCommand('save_encounter', {
                                build_tag:     pending.buildTag,
                                notes:         pending.notes,
                                player_class:  pending.classValue,
                                class_weapons: pending.class_weapons
                            });
                        }, 80); // brief delay to ensure backend buffer is settled
                        return; // suppress all normal encounter_loaded UI side effects
                    }

                    console.log('[EncounterHistory] Encounter data received:', msg.data);
                    // Update all UI with loaded encounter data
                    if (msg.data) {
                        isViewingLoadedEncounter = true;
                        lastLiveStats = currentStats;  // Save current live stats
                        
                        // Show the "viewing loaded encounter" indicator
                        const indicator = document.getElementById('loadedIndicator');
                        if (indicator) {
                            indicator.classList.add('active');
                        }
                        
                        updateStats(msg.data);
                        
                        // Switch to Full Encounter tab to show the data
                        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
                        document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
                        document.querySelector('[data-tab="fullEncounter"]').classList.add('active');
                        document.getElementById('tab-fullEncounter').classList.add('active');
                    }
                }
                else if (msg.type === 'reset') {
                    // Remote reset triggered (e.g., from hotkey)
                    // Play audio confirmation if "Play sound on reset" is enabled.
                    if (document.getElementById('hotkeySound') &&
                        document.getElementById('hotkeySound').checked) {
                        playBeepSound();
                    }
                    // Clear loaded encounter state if active
                    if (isViewingLoadedEncounter) {
                        isViewingLoadedEncounter = false;
                        document.getElementById('loadedIndicator').classList.remove('active');
                    }
                    lastLiveStats = null;
                    resetPending = true; // Ignore stale stats until fresh data arrives
                    
                    // Initialize build test state (same as clicking Reset Encounter button)
                    buildTestActive = true;
                    buildTestComplete = false;
                    buildTestStartTime = Date.now();
                    lastTestData = null;
                    buildTestDataActive = true;
                    
                    // Show sub-tab content
                    showSubtabContent(true);
                    
                    // Update UI elements
                    const statsPanel = document.getElementById('buildTestStatsPanel');
                    const preTest = document.getElementById('preTestInstructions');
                    const nextActions = document.getElementById('nextActionsCard');
                    const extendedStats = document.getElementById('buildTestExtendedStats');
                    
                    if (statsPanel) statsPanel.style.display = 'block';
                    if (preTest) preTest.style.display = 'none';
                    if (nextActions) nextActions.style.display = 'none';
                    if (extendedStats) extendedStats.style.display = 'none';
                    
                    // Reset stats display
                    const btDps = document.getElementById('btDps');
                    const btHits = document.getElementById('btHits');
                    const btCrit = document.getElementById('btCrit');
                    const btHeavy = document.getElementById('btHeavy');
                    if (btDps) btDps.textContent = '0';
                    if (btHits) btHits.textContent = '0';
                    if (btCrit) btCrit.textContent = '0%';
                    if (btHeavy) btHeavy.textContent = '0%';
                    
                    // Update target card and status
                    updateActiveTargetCard();
                    const statusEl = document.getElementById('buildTestStatus');
                    if (statusEl) {
                        statusEl.textContent = 'Testing...';
                        statusEl.style.color = '#fbbf24';
                    }
                    
                    console.log('[Reset] Remote reset triggered via hotkey - build test initialized');
                }
                else if (msg.type === 'error') {
                    partyAlert(msg.message);
                }
            };
            ws.onclose = () => {
                setConnectionStatus(false);
                showDisconnectedBanner();  // Show banner when disconnected
                if (!reconnectInterval) reconnectInterval = setInterval(connect, 3000);
            };
            ws.onerror = (err) => console.error('WebSocket error:', err);
        }
        
        // Show/hide disconnected banner for Party tab
        function showDisconnectedBanner() {
            const banner = document.getElementById('partyDisconnectedBanner');
            if (banner) banner.classList.add('visible');
        }
        
        function hideDisconnectedBanner() {
            const banner = document.getElementById('partyDisconnectedBanner');
            if (banner) banner.classList.remove('visible');
        }

        function sendCommand(command, data = {}) {
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ command, ...data }));
            }
        }

        function resetEncounter() {
            // Clear loaded encounter state if active
            if (isViewingLoadedEncounter) {
                isViewingLoadedEncounter = false;
                document.getElementById('loadedIndicator').classList.remove('active');
            }
            lastLiveStats = null;
            resetPending = true; // Ignore stale stats until fresh data arrives
            sendCommand('reset');
        }
        
        async function purgeLogFile() {
            const logPath = document.getElementById('logPath').value || 'Unknown location';
            const message = `⚠️ WARNING: This will permanently delete ALL combat log data!\n\n` +
                `Log folder: ${logPath}\n\n` +
                `NOTE: You must first DISABLE combat logging in-game:\n` +
                `  Open Ring Menu and deactivate Combat Log\n\n` +
                `This action CANNOT be undone.\n\n` +
                `Are you sure you want to purge the log file?`;

            if (await partyConfirm(message)) {
                // Double confirmation for destructive action
                if (await partyConfirm('⚠️ FINAL WARNING: Click OK to permanently delete all log data.\n\n(Make sure combat logging is disabled in-game!)')) {
                    sendCommand('purge_log');
                }
            }
        }

        // ============================================
        // PARTY OVERLAY MODE
        // ============================================
        
        // Check if running in overlay mode
        const urlParams = new URLSearchParams(window.location.search);
        const isOverlayMode = urlParams.get('overlay') === 'party';
        const overlayPartyCode = urlParams.get('code');
        const overlayPlayerName = urlParams.get('name') ? decodeURIComponent(urlParams.get('name')) : null;
        
        // Overlay state
        let overlayState = {
            connected: false,
            locked: true,  // Click-through by default
            partyCode: null,
            playerName: null,
            userId: null,
            encounterActive: false,
            scoreboard: null,  // latest room scoreboard (boss + ranked entries)
            results: {}
        };
        
        let overlayWS = null;
        let overlayWSReconnect = null;
        let overlayWSWantOpen = false;
        
        // Initialize overlay mode if detected
        if (isOverlayMode) {
            document.body.classList.add('overlay-mode');
            console.log('[Overlay] Starting in overlay mode, code:', overlayPartyCode, 'name:', overlayPlayerName);
            
            // Generate user ID for this overlay instance
            overlayState.userId = 'overlay_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
            overlayState.playerName = overlayPlayerName || 'Overlay';
            overlayState.partyCode = overlayPartyCode;
            
            // Update UI
            document.getElementById('overlayPartyCode').textContent = overlayPartyCode || '----';
            
            // Connect when page loads
            window.addEventListener('DOMContentLoaded', () => {
                if (overlayPartyCode) {
                    initOverlayConnection(overlayPartyCode);
                }
            });
        }
        
        // Connect the overlay to the owned room as a read-only SPECTATOR (doesn't consume a
        // party slot, never appears in the roster). It just renders the room's scoreboard.
        const OVERLAY_WS_BASE = 'wss://tldps-party.kyle-526.workers.dev';
        function initOverlayConnection(code) {
            console.log('[Overlay] Connecting to party room:', code);
            updateOverlayStatus('connecting');
            overlayWSWantOpen = true;
            if (overlayWSReconnect) { clearTimeout(overlayWSReconnect); overlayWSReconnect = null; }
            if (overlayWS) { try { overlayWS.onclose = null; overlayWS.close(); } catch (e) {} overlayWS = null; }

            const qs = new URLSearchParams({
                user_id: overlayState.userId,
                username: overlayState.playerName || 'Overlay',
                leader: '0',
                spectator: '1',
            });
            let ws;
            try { ws = new WebSocket(`${OVERLAY_WS_BASE}/party/${encodeURIComponent(code)}?${qs.toString()}`); }
            catch (e) { console.error('[Overlay] WS construct failed:', e); updateOverlayStatus('error'); return; }
            overlayWS = ws;

            ws.onopen = () => {
                overlayState.connected = true;
                partyDebug('overlay.open', { code: code });
                updateOverlayStatus(overlayState.encounterActive ? 'recording' : 'connected');
            };
            ws.onmessage = (ev) => {
                let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
                partyDebug('overlay.msg', { type: m.type, entries: m.scoreboard ? (m.scoreboard.entries || []).length : undefined });
                switch (m.type) {
                    case 'welcome':
                        overlayState.scoreboard = m.scoreboard || null;
                        overlayState.encounterActive = !!m.encounter_active;
                        renderOverlayResults();
                        updateOverlayStatus(overlayState.encounterActive ? 'recording' : 'connected');
                        break;
                    case 'scoreboard':
                        overlayState.scoreboard = m;
                        renderOverlayResults();
                        break;
                    case 'encounter_start':
                        overlayState.encounterActive = true;
                        updateOverlayStatus('recording');
                        break;
                    case 'encounter_end':
                        overlayState.encounterActive = false;
                        updateOverlayStatus('connected');
                        break;
                }
            };
            ws.onerror = () => { console.warn('[Overlay] Room socket error'); partyDebug('overlay.error', {}); };
            ws.onclose = (ev) => {
                overlayState.connected = false;
                updateOverlayStatus('disconnected');
                partyDebug('overlay.close', { code: (ev && ev.code), wanted: overlayWSWantOpen });
                if (!overlayWSWantOpen) return;
                overlayWSReconnect = setTimeout(() => {
                    if (overlayWSWantOpen) initOverlayConnection(code);
                }, 2000);
            };
        }
        
        // Update overlay connection status
        function updateOverlayStatus(status) {
            const dot = document.getElementById('overlayStatusDot');
            const text = document.getElementById('overlayStatusText');
            
            dot.className = 'overlay-status-dot';
            
            switch (status) {
                case 'connecting':
                    text.textContent = 'Connecting...';
                    break;
                case 'connected':
                    dot.classList.add('connected');
                    text.textContent = 'Connected';
                    break;
                case 'recording':
                    dot.classList.add('connected', 'recording');
                    text.textContent = '● LIVE';
                    break;
                case 'disconnected':
                    text.textContent = 'Disconnected';
                    break;
                case 'error':
                    text.textContent = 'Error';
                    break;
            }
        }
        
        // Render overlay results — the room already picked the boss, filtered trash, and
        // ranked members; we just paint the entries.
        function renderOverlayResults() {
            const container = document.getElementById('overlayResults');
            const sb = overlayState.scoreboard;
            const entries = (sb && Array.isArray(sb.entries)) ? sb.entries : [];

            if (entries.length === 0) {
                container.innerHTML = `
                    <div class="overlay-empty">
                        <div class="overlay-empty-icon">⏳</div>
                        <div>Waiting for encounter data...</div>
                    </div>
                `;
                document.getElementById('overlayPlayerCount').textContent = '0 players';
                return;
            }

            const maxDamage = entries[0]?.total_damage || 1;

            let html = '';
            entries.forEach((e) => {
                const rank = e.rank || 1;
                const percent = ((e.total_damage / maxDamage) * 100).toFixed(0);
                const isSelf = e.username === overlayState.playerName;

                let rankClass = '';
                if (rank === 1) rankClass = 'gold';
                else if (rank === 2) rankClass = 'silver';
                else if (rank === 3) rankClass = 'bronze';

                html += `
                    <div class="overlay-result-row ${isSelf ? 'self' : ''}">
                        <div class="overlay-rank ${rankClass}">${rank}</div>
                        <div class="overlay-player-info">
                            <div class="overlay-player-name">${escapeHtml(e.username)}</div>
                            <div class="overlay-damage-bar">
                                <div class="overlay-damage-bar-fill" style="width: ${percent}%"></div>
                            </div>
                        </div>
                        <div class="overlay-dps">${formatNumber(Math.round(e.dps || 0))}</div>
                        <div class="overlay-damage">${formatDamage(e.total_damage || 0)}</div>
                    </div>
                `;
            });

            container.innerHTML = html;
            document.getElementById('overlayPlayerCount').textContent = `${entries.length} player${entries.length !== 1 ? 's' : ''}`;
        }
        
        // Format damage for overlay (compact)
        function formatDamage(num) {
            if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
            if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
            return num.toLocaleString();
        }
        
        // Toggle overlay lock (click-through)
        function overlayToggleLock() {
            overlayState.locked = !overlayState.locked;
            const btn = document.getElementById('overlayLockBtn');
            const hint = document.getElementById('overlayLockHint');
            
            if (overlayState.locked) {
                btn.textContent = '🔓';
                hint.textContent = 'Click-through ON (Ctrl+Shift+O)';
            } else {
                btn.textContent = '🔒';
                hint.textContent = 'Click-through OFF (Ctrl+Shift+O)';
            }
            
            // Tell Electron to toggle click-through
            if (window.ckOverlay?.setOverlayLocked) {
                window.ckOverlay.setOverlayLocked(overlayState.locked);
            }
        }
        
        // Close overlay
        function overlayClose() {
            overlayWSWantOpen = false;
            if (overlayWSReconnect) { clearTimeout(overlayWSReconnect); overlayWSReconnect = null; }
            if (overlayWS) { try { overlayWS.onclose = null; overlayWS.close(); } catch (e) {} overlayWS = null; }
            if (window.ckOverlay?.closePartyOverlay) {
                window.ckOverlay.closePartyOverlay();
            } else {
                window.close();
            }
        }
        
        // Listen for lock state changes from Electron
        if (window.ckOverlay?.onLockChanged) {
            window.ckOverlay.onLockChanged((locked) => {
                overlayState.locked = locked;
                const btn = document.getElementById('overlayLockBtn');
                const hint = document.getElementById('overlayLockHint');
                
                if (btn && hint) {
                    if (locked) {
                        btn.textContent = '🔓';
                        hint.textContent = 'Click-through ON (Ctrl+Shift+O)';
                    } else {
                        btn.textContent = '🔒';
                        hint.textContent = 'Click-through OFF (Ctrl+Shift+O)';
                    }
                }
            });
        }
        
        // ============================================
        // ELECTRON IPC BRIDGE (for main app)
        // ============================================
        
        // Open party overlay (called from main app buttons)
