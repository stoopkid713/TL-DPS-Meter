        function openCustomModal(mode) {
            const modal = document.getElementById('customDungeonModal');
            const addTypePanel = document.getElementById('customAddTypePanel');
            const addEntryPanel = document.getElementById('customAddEntryPanel');
            const deletePanel = document.getElementById('customDeletePanel');
            const title = document.getElementById('customModalTitle');
            
            // Hide all panels
            addTypePanel.style.display = 'none';
            addEntryPanel.style.display = 'none';
            deletePanel.style.display = 'none';
            
            if (mode === 'add_type') {
                title.textContent = '➕ Add New Type';
                addTypePanel.style.display = 'block';
            } else if (mode === 'add_entry') {
                title.textContent = '➕ Add Entry';
                addEntryPanel.style.display = 'block';
                populateAddEntryTypeSelect();
            } else if (mode === 'delete') {
                title.textContent = '🗑️ Delete';
                deletePanel.style.display = 'block';
                populateDeleteTypeSelect();
            }
            
            modal.style.display = 'flex';
        }
        
        function closeCustomModal() {
            document.getElementById('customDungeonModal').style.display = 'none';
            // Clear inputs
            document.getElementById('newTypeName').value = '';
            document.getElementById('newEntryName').value = '';
        }
        
        function populateAddEntryTypeSelect() {
            const select = document.getElementById('addEntryTypeSelect');
            let html = '<option value="">-- Select Type --</option>';
            
            Object.keys(dungeonsData).forEach(type => {
                if (type !== 'Dimensional Trial') { // Skip old format
                    html += `<option value="${type}">${type}</option>`;
                }
            });
            
            select.innerHTML = html;
        }
        
        function onAddEntryTypeChange() {
            // Nothing special needed, just for future extension
        }
        
        function populateDeleteTypeSelect() {
            const select = document.getElementById('deleteTypeSelect');
            let html = '<option value="">-- Select Type --</option>';
            
            Object.keys(dungeonsData).forEach(type => {
                if (type !== 'Dimensional Trial') {
                    html += `<option value="${type}">${type}</option>`;
                }
            });
            
            select.innerHTML = html;
            
            document.getElementById('deleteEntryContainer').style.display = 'none';
        }
        
        function onDeleteTypeChange() {
            const type = document.getElementById('deleteTypeSelect').value;
            const entryContainer = document.getElementById('deleteEntryContainer');
            const entrySelect = document.getElementById('deleteEntrySelect');
            
            if (!type) {
                entryContainer.style.display = 'none';
                return;
            }
            
            const entries = dungeonsData[type] || [];
            
            let html = '<option value="">-- Delete Entire Type --</option>';
            entries.forEach(entry => {
                html += `<option value="${entry}">${entry}</option>`;
            });
            
            entrySelect.innerHTML = html;
            entryContainer.style.display = 'block';
        }
        
        function addNewType() {
            const name = document.getElementById('newTypeName').value.trim();
            
            if (!name) {
                alert('Please enter a type name');
                return;
            }
            
            if (dungeonsData[name]) {
                alert('This type already exists');
                return;
            }
            
            if (!ws || ws.readyState !== WebSocket.OPEN) {
                alert('Not connected');
                return;
            }
            
            ws.send(JSON.stringify({
                command: 'add_dungeon_type',
                type_name: name
            }));
            
            // Optimistically update local data
            dungeonsData[name] = [];
            updateTypeDropdown();
            
            alert(`Type "${name}" added successfully!`);
            closeCustomModal();
        }
        
        function addNewEntry() {
            const type = document.getElementById('addEntryTypeSelect').value;
            const name = document.getElementById('newEntryName').value.trim();
            
            if (!type) {
                alert('Please select a type');
                return;
            }
            
            if (!name) {
                alert('Please enter an entry name');
                return;
            }
            
            if (dungeonsData[type] && dungeonsData[type].includes(name)) {
                alert('This entry already exists in this type');
                return;
            }
            
            if (!ws || ws.readyState !== WebSocket.OPEN) {
                alert('Not connected');
                return;
            }
            
            ws.send(JSON.stringify({
                command: 'add_dungeon',
                category: type,
                dungeon_name: name
            }));
            
            // Optimistically update local data
            if (!dungeonsData[type]) dungeonsData[type] = [];
            dungeonsData[type].push(name);
            
            alert(`"${name}" added to ${type}!`);
            document.getElementById('newEntryName').value = '';
        }
        
        function deleteSelected() {
            const type = document.getElementById('deleteTypeSelect').value;
            const entry = document.getElementById('deleteEntrySelect').value;
            
            if (!type) {
                alert('Please select a type');
                return;
            }
            
            if (!ws || ws.readyState !== WebSocket.OPEN) {
                alert('Not connected');
                return;
            }
            
            if (entry) {
                // Delete specific entry
                if (!confirm(`Delete "${entry}" from ${type}?`)) return;
                
                ws.send(JSON.stringify({
                    command: 'delete_dungeon',
                    category: type,
                    dungeon_name: entry
                }));
                
                // Optimistically update
                if (dungeonsData[type]) {
                    dungeonsData[type] = dungeonsData[type].filter(e => e !== entry);
                }
                
                alert(`"${entry}" deleted from ${type}!`);
                onDeleteTypeChange(); // Refresh entry list
            } else {
                // Delete entire type
                if (!confirm(`Delete entire type "${type}" and all its entries? This cannot be undone!`)) return;
                
                ws.send(JSON.stringify({
                    command: 'delete_dungeon_type',
                    type_name: type
                }));
                
                // Optimistically update
                delete dungeonsData[type];
                updateTypeDropdown();
                
                alert(`Type "${type}" deleted!`);
                closeCustomModal();
            }
        }
        
        // Legacy function for compatibility
        function toggleAddDungeon() {
            // Redirect to custom modal
            document.getElementById('runTypeSelect').value = 'Custom';
            onRunTypeChange();
        }
        
        function addCustomDungeon() {
            // Legacy - redirect to modal
            openCustomModal('add_entry');
        }
        
        // === SAVED RUNS MANAGEMENT ===
        let savedRunsVisible = false;
        
        function toggleSavedRuns() {
            const section = document.getElementById('savedRunsSection');
            savedRunsVisible = !savedRunsVisible;
            
            if (savedRunsVisible) {
                section.style.display = 'block';
                loadSavedRuns();
            } else {
                section.style.display = 'none';
            }
        }
        
        function loadSavedRuns() {
            if (!ws || ws.readyState !== WebSocket.OPEN) {
                document.getElementById('savedRunsList').innerHTML = '<div style="color: #ef4444; text-align: center; padding: 20px; font-size: 0.8rem;">Not connected</div>';
                return;
            }
            
            ws.send(JSON.stringify({ command: 'get_saved_runs' }));
        }
        
        let savedRunsData = []; // Store runs for loading
        
        function displaySavedRuns(runs) {
            const container = document.getElementById('savedRunsList');
            savedRunsData = runs || []; // Store for loading
            
            if (!runs || runs.length === 0) {
                container.innerHTML = '<div style="color: #64748b; text-align: center; padding: 20px; font-size: 0.8rem;">No saved runs yet</div>';
                return;
            }
            
            // Sort by created_at descending (newest first)
            runs.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
            
            let html = '';
            runs.forEach((run, index) => {
                const stats = run.stats || {};
                const dpsFormatted = Math.round(stats.dps || 0).toLocaleString();
                const damageFormatted = ((stats.total_damage || 0) / 1000000).toFixed(2) + 'M';
                const durationFormatted = formatDuration(stats.duration || 0);
                const createdDate = new Date(run.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
                const createdTime = new Date(run.created_at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
                const dungeonDisplay = run.dungeon_name ? `<span style="color: #5B92D4;">${run.dungeon_name}</span> · ` : '';
                const attemptCount = stats.attempt_count || 0;
                const attemptBadge = attemptCount > 0 ? `<span class="attempt-badge" style="margin-left: 6px;">${attemptCount} attempt${attemptCount > 1 ? 's' : ''}</span>` : '';
                
                html += `
                    <div style="background: rgba(15, 23, 42, 0.5); border: 1px solid #334155; border-radius: 6px; padding: 10px; margin-bottom: 8px;">
                        <div style="display: flex; justify-content: space-between; align-items: start; margin-bottom: 8px;">
                            <div style="flex: 1;">
                                <div style="font-weight: 600; color: #e2e8f0; font-size: 0.85rem;">${run.run_name}${attemptBadge}</div>
                                <div style="font-size: 0.65rem; color: #64748b;">${dungeonDisplay}${createdDate} ${createdTime} · ${stats.encounter_count || 0} encounters</div>
                            </div>
                            <button onclick="deleteSavedRun('${run.run_id}')" style="padding: 2px 6px; background: rgba(239, 68, 68, 0.2); border: 1px solid rgba(239, 68, 68, 0.3); color: #ef4444; border-radius: 4px; cursor: pointer; font-size: 0.65rem;" title="Delete run">🗑️</button>
                        </div>
                        <div style="display: flex; gap: 12px; font-size: 0.75rem; margin-bottom: 8px;">
                            <span style="color: #D96444;"><strong>${dpsFormatted}</strong> DPS</span>
                            <span style="color: #94a3b8;">${damageFormatted}</span>
                            <span style="color: #5B92D4;">${durationFormatted}</span>
                        </div>
                        <button onclick="viewSavedRunStats(${index})" style="width: 100%; padding: 6px 10px; background: rgba(217, 100, 68, 0.1); border: 1px solid rgba(217, 100, 68, 0.3); color: #D96444; border-radius: 4px; cursor: pointer; font-size: 0.75rem; font-weight: 600;">📊 View Stats</button>
                    </div>
                `;
            });
            
            container.innerHTML = html;
        }
        
        function viewSavedRunStats(index) {
            const run = savedRunsData[index];
            if (!run) return;
            
            const stats = run.stats || {};
            const dpsFormatted = Math.round(stats.dps || 0).toLocaleString();
            const damageFormatted = ((stats.total_damage || 0) / 1000000).toFixed(2) + 'M';
            const durationFormatted = formatDuration(stats.duration || 0);
            const downtimeFormatted = formatDuration(stats.downtime || 0);
            const bossDpsFormatted = Math.round(stats.boss_dps || 0).toLocaleString();
            const trashDpsFormatted = Math.round(stats.trash_dps || 0).toLocaleString();
            const attemptCount = stats.attempt_count || 0;
            const createdDate = new Date(run.created_at).toLocaleString('en-US', { 
                month: 'short', day: 'numeric', year: 'numeric',
                hour: '2-digit', minute: '2-digit', hour12: false 
            });
            const dungeonLine = run.dungeon_name ? `🏰 Dungeon: ${run.dungeon_name} (${run.dungeon_category || 'Unknown'})\n` : '';
            const attemptLine = attemptCount > 0 ? `⚠️ Attempts/Wipes: ${attemptCount}\n` : '';
            
            // Show stats in a modal-style alert (simple for now)
            const statsText = `
📊 ${run.run_name}
━━━━━━━━━━━━━━━━━━━━━━━━
${dungeonLine}📅 Created: ${createdDate}
🎯 Encounters: ${stats.encounter_count || 0}
${attemptLine}
⚔️ Overall DPS: ${dpsFormatted}
💥 Total Damage: ${damageFormatted}
⏱️ Active Time: ${durationFormatted}
⏸️ Downtime: ${downtimeFormatted}

👹 Boss DPS: ${bossDpsFormatted}
💀 Trash DPS: ${trashDpsFormatted}
            `.trim();
            
            alert(statsText);
        }
        
        function deleteSavedRun(runId) {
            if (!confirm('Delete this saved run?')) return;
            
            if (!ws || ws.readyState !== WebSocket.OPEN) {
                alert('Not connected');
                return;
            }
            
            ws.send(JSON.stringify({
                command: 'delete_run',
                run_id: runId
            }));
        }
        
        // === BUILD TESTING TAB ===
        let buildTestActive = false; // Is a 60s test currently running?
        let saveSource = 'buildtest'; // 'buildtest' | 'encounter'
        let saveSourceEncounter = null;
        let savingFromEncounterHistory = false; // two-step save flow flag
        let pendingEncounterSave = null; // { buildTag, classValue, classInfo, notes } stored during load step
        let rotationHiddenSkills    = new Set(); // Skills hidden from stacked chart (build testing)
        let compareHiddenSkillsA   = new Set(); // Compare tab rotation chart hidden skills per build
        let compareHiddenSkillsB   = new Set();
        let compareHiddenSkillsC   = new Set();
        let compareDrilldownSkill  = null;       // Currently drilled skill in compare tab
        let compareDrilldownBuild  = null;       // Which build is being drilled
        let encRotationHiddenSkills = new Set(); // Skills hidden from stacked chart (encounters)
        let lastRotationCache    = null; // { rotation, gapStats } for BT chart re-render on toggle
        let lastEncRotationCache = null; // { rotation, duration } for enc chart re-render on toggle
        let buildTestComplete = false; // Has the current test completed?
        let buildTestStartTime = null; // When did the test start?
        let lastTestData = null; // Data from last completed test
        let buildTestDataActive = false; // Should sub-tabs receive data?
        let resetPending = false; // Ignore stale stats after reset until fresh data arrives

        // === SESSION QUEUE ===
        let sessionQueue = [];     // { runNumber, tempTag, finalTag, playerClass, notes, dps, critRate, heavyRate, target, id, saved, rotation, skills, runLabSlot }
        let sessionRunCounter = 0; // Incrementing counter for placeholder tag uniqueness
        
        // Show/hide placeholder vs content for all sub-tabs
        function showSubtabContent(show) {
            const tabs = ['summary', 'skills', 'weapons', 'topHits', 'rotation', 'timeline'];
            tabs.forEach(tab => {
                const placeholder = document.getElementById(tab + 'Placeholder');
                const content = document.getElementById(tab + 'Content');
                if (placeholder) placeholder.style.display = show ? 'none' : 'flex';
                if (content) content.style.display = show ? 'block' : 'none';
            });
        }
        
        function startBuildTest() {
            // Reset the encounter (same as sidebar button)
            resetEncounter();
            
            // Set flag to ignore stale stats until we get fresh data
            resetPending = true;
            
            // Set up new test state
            buildTestActive = true;
            buildTestComplete = false;
            buildTestStartTime = Date.now();
            lastTestData = null;
            buildTestDataActive = true; // Enable data flow to sub-tabs
            
            // Show sub-tab content (hide placeholders)
            showSubtabContent(true);
            
            // Show stats panel, hide pre-test instructions
            document.getElementById('buildTestStatsPanel').style.display = 'block';
            document.getElementById('preTestInstructions').style.display = 'none';
            document.getElementById('nextActionsCard').style.display = 'none';
            document.getElementById('buildTestExtendedStats').style.display = 'none';
            
            // Reset stats display
            document.getElementById('btDps').textContent = '0';
            document.getElementById('btHits').textContent = '0';
            document.getElementById('btCrit').textContent = '0%';
            document.getElementById('btHeavy').textContent = '0%';
            
            // Update target card
            updateActiveTargetCard();
            
            // Update status
            const statusEl = document.getElementById('buildTestStatus');
            if (statusEl) {
                statusEl.textContent = 'Testing...';
                statusEl.style.color = '#fbbf24';
            }
        }
        
        function updateActiveTargetCard() {
            const card = document.getElementById('activeTargetCard');
            if (!card) return;
            
            if (!buildTestActive && !buildTestComplete) {
                card.style.display = 'none';
                return;
            }
            
            card.style.display = 'block';
            
            if (buildTestActive && !buildTestComplete) {
                // Test is running - show progress
                const elapsed = currentStats?.duration || 0;
                const targets = currentStats?.targets || [];
                const targetName = targets.length > 0 ? targets[0].name : 'Waiting for combat...';
                
                card.style.borderColor = 'rgba(251, 191, 36, 0.3)';
                card.style.background = 'rgba(251, 191, 36, 0.05)';
                card.innerHTML = `
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
                        <div>
                            <div style="font-size: 0.75rem; color: #fbbf24; text-transform: uppercase; letter-spacing: 0.5px; font-weight: 600;">⏱️ Active Test</div>
                            <div style="font-size: 1rem; color: #e2e8f0; font-weight: 500; margin-top: 4px;">${targetName}</div>
                        </div>
                        <div style="text-align: right;">
                            <div style="font-size: 1.3rem; color: #e2e8f0; font-weight: 700;">${Math.floor(elapsed)}s</div>
                            <div style="font-size: 0.7rem; color: #64748b;">/ 60s</div>
                        </div>
                    </div>
                    <div style="height: 6px; background: rgba(251, 191, 36, 0.2); border-radius: 3px; overflow: hidden;">
                        <div style="height: 100%; width: ${Math.min(elapsed / 60 * 100, 100)}%; background: linear-gradient(90deg, #fbbf24, #f59e0b); transition: width 0.3s; border-radius: 3px;"></div>
                    </div>
                `;
            } else if (buildTestComplete && lastTestData) {
                // Test complete
                card.style.borderColor = 'rgba(34, 197, 94, 0.3)';
                card.style.background = 'rgba(34, 197, 94, 0.05)';
                card.innerHTML = `
                    <div style="display: flex; justify-content: space-between; align-items: center;">
                        <div>
                            <div style="font-size: 0.75rem; color: #22c55e; text-transform: uppercase; letter-spacing: 0.5px; font-weight: 600;">✓ Test Complete</div>
                            <div style="font-size: 1rem; color: #e2e8f0; font-weight: 500; margin-top: 4px;">${lastTestData.target}</div>
                        </div>
                        <div style="text-align: right;">
                            <div style="font-size: 0.7rem; color: #64748b;">60 seconds</div>
                        </div>
                    </div>
                `;
            }
        }
        
        // Normalize 60s stats from a stats payload. Loaded encounters carry a
        // first_60s object; live data carries flat *_60s keys. Previously the BT
        // consumers did `data.first_60s || data` and fell through to the whole
        // (lifetime) buffer for live data, mixing lifetime numbers into the
        // build-test display. This reads the flat _60s keys instead — same source
        // the loaded-encounter path (updateSummaryTab) uses. Returns an object
        // with the field names the BT consumers already expect.
        function get60sStats(data) {
            if (!data) return {};
            if (data.first_60s && typeof data.first_60s === 'object') {
                return data.first_60s;
            }
            const damage = data.damage_60s || 0;
            const hits = data.hit_count_60s || 0;
            const critRate = data.crit_rate_60s || 0;
            const heavyRate = data.heavy_rate_60s || 0;
            const critHeavyRate = data.crit_heavy_rate_60s || 0;
            return {
                dps: data.dps_60s || 0,
                total_damage: damage,
                hit_count: hits,
                raw_crit_rate: critRate,
                raw_heavy_rate: heavyRate,
                crit_heavy_rate: critHeavyRate,
                normal_rate: Math.max(0, 100 - critRate - heavyRate + critHeavyRate),
                avg_hit: hits > 0 ? Math.round(damage / hits) : 0,
                skills: data.skills_60s || [],
                rotation: data.rotation_60s || []
            };
        }

        function updateBuildTestStats(data) {
            // Only update if test is active or complete
            if (!buildTestActive && !buildTestComplete) return;

            const first60 = get60sStats(data);
            
            // Update main stats
            document.getElementById('btDps').textContent = Math.round(first60.dps || 0).toLocaleString();
            document.getElementById('btHits').textContent = (first60.hit_count || 0).toLocaleString();
            document.getElementById('btCrit').textContent = (first60.raw_crit_rate || 0).toFixed(1) + '%';
            document.getElementById('btHeavy').textContent = (first60.raw_heavy_rate || 0).toFixed(1) + '%';
            
            // Update extended stats if visible
            const extendedEl = document.getElementById('buildTestExtendedStats');
            if (extendedEl && extendedEl.style.display !== 'none') {
                document.getElementById('btNormal').textContent = (first60.normal_rate || 0).toFixed(1) + '%';
                document.getElementById('btCritHeavy').textContent = (first60.crit_heavy_rate || 0).toFixed(1) + '%';
                document.getElementById('btAvgHit').textContent = Math.round(first60.avg_hit || 0).toLocaleString();
            }
        }
        
        function updateBuildTestingTab(data) {
            // Update connection status
            const logStatusEl = document.getElementById('buildTestLogStatus');
            if (logStatusEl) {
                logStatusEl.textContent = 'Connected';
                logStatusEl.style.color = '#22c55e';
            }
            
            // Handle reset pending - ignore stale stats until fresh data arrives
            if (resetPending) {
                // Only clear pending flag when we get fresh data (duration < 1s)
                if (data && data.duration < 1) {
                    resetPending = false;
                    console.log('Reset complete - fresh data received');
                } else {
                    // Still waiting for reset to take effect, ignore this stale data
                    console.log('Ignoring stale stats while reset pending, duration:', data?.duration);
                    return;
                }
            }
            
            // Only process if we have an active test
            if (!buildTestActive) {
                const statusEl = document.getElementById('buildTestStatus');
                if (statusEl && !buildTestComplete) {
                    statusEl.textContent = 'Ready';
                    statusEl.style.color = '#94a3b8';
                }
                return;
            }
            
            // Store current stats
            currentStats = data;
            
            // Update the active target card with progress
            updateActiveTargetCard();
            
            // Update stats display
            updateBuildTestStats(data);
            
            // Check if test has completed (60 seconds)
            if (data && data.duration >= 60 && !buildTestComplete) {
                // Test complete!
                buildTestActive = false;
                buildTestComplete = true;
                
                // Get target name from the data
                const targets = data.targets || [];
                const targetName = targets.length > 0 ? targets[0].name : 'Unknown Target';
                const first60 = get60sStats(data);
                
                // Capture the test data
                lastTestData = {
                    target: targetName,
                    dps: first60.dps || 0,
                    hits: first60.hit_count || 0,
                    critRate: first60.raw_crit_rate || 0,
                    heavyRate: first60.raw_heavy_rate || 0,
                    normalRate: first60.normal_rate || 0,
                    critHeavyRate: first60.crit_heavy_rate || 0,
                    avgHit: first60.avg_hit || 0,
                    timestamp: Date.now()
                };
                
                // Update status
                const statusEl = document.getElementById('buildTestStatus');
                if (statusEl) {
                    statusEl.textContent = 'Complete';
                    statusEl.style.color = '#22c55e';
                }
                
                // Show completed target card
                updateActiveTargetCard();
                
                // Show extended stats
                document.getElementById('buildTestExtendedStats').style.display = 'grid';
                document.getElementById('btNormal').textContent = lastTestData.normalRate.toFixed(1) + '%';
                document.getElementById('btCritHeavy').textContent = lastTestData.critHeavyRate.toFixed(1) + '%';
                document.getElementById('btAvgHit').textContent = Math.round(lastTestData.avgHit).toLocaleString();
                
                // Show next actions / queue
                queueCompletedRun(data);
                
                // Update button subtext
                const resetSubEl = document.getElementById('resetSubtext');
                if (resetSubEl) resetSubEl.textContent = 'Start next run';
            }
            
            // Update status while testing
            const statusEl = document.getElementById('buildTestStatus');
            if (statusEl && buildTestActive) {
                statusEl.textContent = `${Math.floor(data.duration || 0)}s`;
                statusEl.style.color = '#fbbf24';
            }
        }
        
        function updateBuildTestingStatus(connected) {
            const logStatusEl = document.getElementById('buildTestLogStatus');
            if (logStatusEl) {
                if (connected) {
                    logStatusEl.textContent = '● Connected';
                    logStatusEl.style.color = '#22c55e';
                } else {
                    logStatusEl.textContent = '● Disconnected';
                    logStatusEl.style.color = '#ef4444';
                }
            }
        }

        // === SESSION QUEUE FUNCTIONS ===

        // Auto-detect class from rotation skill usage
        function detectClassFromRotation(rotation) {
            if (!rotation || !rotation.length) return '';

            const assignments = weaponConfig.skillAssignments || {};
            const EXCLUDED = new Set(['mastery', 'other']);

            // Map weapon_config keys → TL_CLASSES weapon name strings
            const WEAPON_MAP = {
                'spear':      'Spear',
                'dagger':     'Daggers',
                'orb':        'Orb',
                'wand':       'Wand',
                'crossbow':   'Crossbow',
                'longbow':    'Longbow',
                'staff':      'Staff',
                'greatsword': 'Greatsword',
                'sword':      'Sword & Shield'
            };

            // Sum damage per weapon type
            const weaponDmg = {};
            rotation.forEach(hit => {
                const wt = assignments[hit.skill || ''];
                if (!wt || EXCLUDED.has(wt)) return;
                weaponDmg[wt] = (weaponDmg[wt] || 0) + (hit.damage || 0);
            });

            if (!Object.keys(weaponDmg).length) return '';

            // Top 2 weapon types by total damage
            const top2 = Object.entries(weaponDmg)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 2)
                .map(([wt]) => WEAPON_MAP[wt])
                .filter(Boolean);

            if (top2.length < 2) return '';

            // Find the class whose weapons string contains both detected types
            const match = TL_CLASSES.find(c => top2.every(w => c.weapons.includes(w)));
            return match ? match.name : '';
        }

        function queueCompletedRun(data) {
            sessionRunCounter++;
            const first60 = get60sStats(data);
            const targets = data.targets || [];
            const targetName = targets.length > 0 ? targets[0].name : 'Unknown';
            const placeholderTag = `__sq_${Date.now()}_${sessionRunCounter}__`;

            const detectedClass = detectClassFromRotation(data.rotation_60s || []);
            const resolvedClass = detectedClass || selectedClass || '';
            if (detectedClass) selectedClass = detectedClass; // update for subsequent saves

            const item = {
                runNumber: sessionRunCounter,
                tempTag: placeholderTag,
                finalTag: '',
                playerClass: resolvedClass,
                notes: '',
                dps: Math.round(first60.dps || 0),
                totalDamage: Math.round(first60.total_damage || 0),
                critRate: parseFloat((first60.raw_crit_rate || 0).toFixed(1)),
                heavyRate: parseFloat((first60.raw_heavy_rate || 0).toFixed(1)),
                critHeavyRate: parseFloat((first60.crit_heavy_rate || 0).toFixed(1)),
                target: targetName,
                id: null,
                saved: false,
                rotation: data.rotation_60s || [],
                skills: first60.skills || [],
                runLabSlot: null
            };

            sessionQueue.push(item);

            // Auto-save to backend immediately with placeholder tag to reserve an ID
            sendCommand('save_encounter', {
                build_tag: placeholderTag,
                notes: '',
                player_class: item.playerClass,
                class_weapons: ''
            });

            renderSessionQueue();
            const panel = document.getElementById('sessionQueuePanel');
            if (panel) panel.style.display = 'block';
            // Keep nextActionsCard hidden; queue replaces it
            const nextCard = document.getElementById('nextActionsCard');
            if (nextCard) nextCard.style.display = 'none';
        }

        function renderSessionQueue() {
            const list = document.getElementById('sessionQueueList');
            const countEl = document.getElementById('sessionQueueCount');
            if (!list) return;

            const total = sessionQueue.length;
            const savedCount = sessionQueue.filter(i => i.saved).length;

            if (countEl) {
                countEl.textContent = savedCount === total && total > 0
                    ? `${total} saved ✓`
                    : `${total} run${total !== 1 ? 's' : ''}`;
                countEl.style.background = savedCount === total && total > 0
                    ? 'rgba(34, 197, 94, 0.2)'
                    : 'rgba(91, 146, 212, 0.2)';
                countEl.style.color = savedCount === total && total > 0
                    ? '#22c55e'
                    : '#5B92D4';
            }

            // Update Run Lab badge
            const badge = document.getElementById('runLabBadge');
            const hasA = sessionQueue.some(i => i.runLabSlot === 'A');
            const hasB = sessionQueue.some(i => i.runLabSlot === 'B');
            if (badge) badge.style.display = (hasA && hasB) ? 'block' : 'none';

            if (total === 0) {
                list.innerHTML = '';
                return;
            }

            // Open Run Lab prompt when both slots filled
            const rlPrompt = (hasA && hasB)
                ? `<div style="margin-bottom:8px; padding:8px 10px; background:rgba(217,100,68,0.08); border:1px solid rgba(217,100,68,0.3); border-radius:6px; display:flex; justify-content:space-between; align-items:center;">
                       <span style="font-size:0.72rem; color:#D96444; font-weight:600;">🔬 Run A &amp; B selected</span>
                       <button onclick="openRunLab()" style="padding:4px 10px; background:rgba(217,100,68,0.2); border:1px solid rgba(217,100,68,0.5); border-radius:5px; color:#D96444; font-size:0.72rem; font-weight:700; cursor:pointer;">Open Run Lab →</button>
                   </div>`
                : (total >= 2 ? `<div style="font-size:0.65rem; color:#64748b; text-align:center; margin-bottom:6px;">Assign A and B to compare runs</div>` : '');

            list.innerHTML = rlPrompt + sessionQueue.map((item, i) => {
                const borderColor = item.saved
                    ? 'rgba(34,197,94,0.4)'
                    : (!item.id ? '#334155' : item.runLabSlot === 'A' ? 'rgba(217,100,68,0.5)' : item.runLabSlot === 'B' ? 'rgba(167,139,250,0.5)' : 'rgba(167,139,250,0.3)');
                const statusBadge = item.saved
                    ? `<span style="font-size:0.62rem; color:#22c55e; background:rgba(34,197,94,0.15); padding:2px 5px; border-radius:4px; font-weight:700;">✓</span>`
                    : (!item.id
                        ? `<span style="font-size:0.62rem; color:#64748b; font-style:italic;">queuing...</span>`
                        : ``);

                const slotBtnA = `<button onclick="setRunLabSlot('A',${i})" title="Assign as Run A"
                    style="padding:2px 7px; font-size:0.62rem; font-weight:700; border-radius:4px; cursor:pointer; transition:all 0.15s;
                    background:${item.runLabSlot==='A' ? 'rgba(217,100,68,0.3)' : 'rgba(15,23,42,0.6)'};
                    border:1px solid ${item.runLabSlot==='A' ? '#D96444' : '#334155'};
                    color:${item.runLabSlot==='A' ? '#D96444' : '#64748b'};">A</button>`;
                const slotBtnB = `<button onclick="setRunLabSlot('B',${i})" title="Assign as Run B"
                    style="padding:2px 7px; font-size:0.62rem; font-weight:700; border-radius:4px; cursor:pointer; transition:all 0.15s;
                    background:${item.runLabSlot==='B' ? 'rgba(167,139,250,0.3)' : 'rgba(15,23,42,0.6)'};
                    border:1px solid ${item.runLabSlot==='B' ? '#5B92D4' : '#334155'};
                    color:${item.runLabSlot==='B' ? '#5B92D4' : '#64748b'};">B</button>`;

                return `
                <div style="padding:9px 10px; background:rgba(15,23,42,0.6); border:1px solid ${borderColor}; border-radius:8px; margin-bottom:7px; transition:border-color 0.3s; box-sizing:border-box;">
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
                        <span style="font-size:0.68rem; color:#64748b; font-weight:700; text-transform:uppercase;">Run #${item.runNumber}</span>
                        <div style="display:flex; align-items:center; gap:5px;">
                            <span style="font-size:0.82rem; font-weight:700; color:#5B92D4;">${formatNumber(item.dps)} DPS</span>
                            <span style="font-size:0.72rem; color:#64748b;" title="60s total damage">${formatNumber(item.totalDamage || 0)}</span>
                        </div>
                    </div>
                    <div style="display:flex; justify-content:flex-end; align-items:center; gap:5px; margin-bottom:7px;">
                        ${slotBtnA}${slotBtnB}
                        ${statusBadge}
                        ${!item.saved ? `<button onclick="removeQueueItem(${i})" title="Remove this run"
                            style="padding:1px 6px; font-size:0.7rem; background:rgba(239,68,68,0.1); border:1px solid rgba(239,68,68,0.3);
                                   color:#ef4444; border-radius:4px; cursor:pointer; line-height:1.4; flex-shrink:0;"
                            onmouseover="this.style.background='rgba(239,68,68,0.25)'"
                            onmouseout="this.style.background='rgba(239,68,68,0.1)'">✕</button>` : ''}
                    </div>
                    <input type="text"
                           value="${escapeHtml(item.finalTag)}"
                           placeholder="Build tag..."
                           oninput="updateQueueItem(${i},'finalTag',this.value)"
                           style="width:100%; padding:6px 9px; background:rgba(15,23,42,0.8); border:1px solid ${item.saved?'rgba(34,197,94,0.3)':'#475569'}; border-radius:5px; color:#e2e8f0; font-size:0.77rem; margin-bottom:5px; box-sizing:border-box; outline:none;"
                           ${item.saved ? 'disabled' : ''}>
                    <select onchange="updateQueueItem(${i},'playerClass',this.value)"
                            style="width:100%; padding:6px 9px; background:rgba(15,23,42,0.8); border:1px solid ${item.saved?'rgba(34,197,94,0.3)':'#475569'}; border-radius:5px; color:${item.playerClass?'#e2e8f0':'#64748b'}; font-size:0.75rem;"
                            ${item.saved ? 'disabled' : ''}>
                        <option value="">-- Class (optional) --</option>
                        ${TL_CLASSES.map(c => `<option value="${c.name}" ${item.playerClass===c.name?'selected':''}>${c.name}: ${c.weapons}</option>`).join('')}
                    </select>
                </div>`;
            }).join('');
        }

        function updateQueueItem(index, field, value) {
            if (sessionQueue[index] !== undefined) {
                sessionQueue[index][field] = value;
            }
        }

        function removeQueueItem(index) {
            const item = sessionQueue[index];
            if (!item) return;
            if (!confirm(`Remove Run #${item.runNumber} from the session queue?`)) return;

            // Delete placeholder save from backend if it hasn't been properly tagged
            if (item.id && !item.saved) {
                sendCommand('delete_encounter', { id: item.id });
            }

            // If this run was assigned to a Run Lab slot, clear it
            sessionQueue.splice(index, 1);

            // Renumber remaining runs' display isn't affected (runNumber is fixed at creation)
            renderSessionQueue();

            // If queue is now empty, hide panel
            if (sessionQueue.length === 0) {
                sessionRunCounter = 0;
                const panel = document.getElementById('sessionQueuePanel');
                if (panel) panel.style.display = 'none';
            }
        }

        function saveAllSessionRuns() {
            const unsaved = sessionQueue.filter(item => !item.saved);
            if (unsaved.length === 0) return;

            // Validate all have tags
            const untagged = unsaved.filter(item => !item.finalTag.trim());
            if (untagged.length > 0) {
                alert(`Please add a build tag to all ${untagged.length} run${untagged.length > 1 ? 's' : ''} before saving.`);
                return;
            }

            // Make sure backend has confirmed IDs for all
            const notReady = unsaved.filter(item => !item.id);
            if (notReady.length > 0) {
                alert('Still writing run data — please wait a moment and try again.');
                return;
            }

            unsaved.forEach(item => {
                const classInfo = TL_CLASSES.find(c => c.name === item.playerClass);
                sendCommand('update_encounter', {
                    id: item.id,
                    build_tag: item.finalTag.trim(),
                    notes: item.notes || '',
                    player_class: item.playerClass,
                    class_weapons: classInfo ? classInfo.weapons : ''
                });
            });

            renderSessionQueue();
        }

        function discardSessionQueue() {
            if (sessionQueue.length === 0) return;
            const unsaved = sessionQueue.filter(item => !item.saved);
            const confirmMsg = unsaved.length > 0
                ? `Discard ${unsaved.length} untagged run${unsaved.length > 1 ? 's' : ''}? Their placeholder saves will be deleted.`
                : 'Clear the completed session queue?';
            if (!confirm(confirmMsg)) return;

            unsaved.forEach(item => {
                if (item.id) sendCommand('delete_encounter', { id: item.id });
            });

            sessionQueue = [];
            sessionRunCounter = 0;
            renderSessionQueue();
            const panel = document.getElementById('sessionQueuePanel');
            if (panel) panel.style.display = 'none';
        }

        // === RUN LAB ===

