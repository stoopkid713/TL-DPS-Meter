        function onEditRunTypeChange() {
            const type = document.getElementById('editRunType').value;
            const modeContainer = document.getElementById('editRunModeContainer');
            const tierContainer = document.getElementById('editRunTierContainer');
            const dungeonContainer = document.getElementById('editRunDungeonContainer');
            const modeSelect = document.getElementById('editRunMode');
            const modeLabel = document.getElementById('editRunModeLabel');
            const dungeonLabel = document.getElementById('editRunDungeonLabel');
            
            // Reset all
            modeContainer.style.display = 'none';
            tierContainer.style.display = 'none';
            dungeonContainer.style.display = 'none';
            
            if (!type || type === 'Custom') return;
            
            if (type === 'Co-op Dungeon') {
                modeLabel.textContent = 'Mode';
                modeSelect.innerHTML = `
                    <option value="">-- Select Mode --</option>
                    <option value="Dimensional Circle">Dimensional Circle</option>
                    <option value="Dimensional Trial">Dimensional Trial</option>
                `;
                modeContainer.style.display = 'block';
                dungeonLabel.textContent = 'Dungeon';
                populateEditRunDungeonDropdown('Co-op Dungeon');
                dungeonContainer.style.display = 'block';
            } else if (type === 'Raid') {
                modeLabel.textContent = 'Difficulty';
                modeSelect.innerHTML = `
                    <option value="">-- Select Difficulty --</option>
                    <option value="Normal">Normal</option>
                    <option value="Difficult">Difficult</option>
                    <option value="Nightmare">Nightmare</option>
                `;
                modeContainer.style.display = 'block';
                dungeonLabel.textContent = 'Raid';
                populateEditRunDungeonDropdown('Raid');
                dungeonContainer.style.display = 'block';
            } else if (type === 'Field Boss' || type === 'Archboss') {
                modeLabel.textContent = 'Mode';
                modeSelect.innerHTML = `
                    <option value="">-- Select Mode --</option>
                    <option value="Normal">Normal</option>
                    <option value="Ascended">Ascended</option>
                `;
                modeContainer.style.display = 'block';
                dungeonLabel.textContent = 'Boss';
                populateEditRunDungeonDropdown(type);
                dungeonContainer.style.display = 'block';
            }
        }
        
        function onEditRunModeChange() {
            const type = document.getElementById('editRunType').value;
            const mode = document.getElementById('editRunMode').value;
            const tierContainer = document.getElementById('editRunTierContainer');
            
            tierContainer.style.display = 'none';
            
            if (type === 'Co-op Dungeon' && mode === 'Dimensional Trial') {
                tierContainer.style.display = 'block';
            }
        }
        
        function populateEditRunDungeonDropdown(type) {
            const select = document.getElementById('editRunDungeon');
            const entries = dungeonsData[type] || defaultDungeonsData[type] || [];
            
            let html = '<option value="">-- Select --</option>';
            entries.forEach(entry => {
                html += `<option value="${entry}">${entry}</option>`;
            });
            select.innerHTML = html;
        }
        
        function saveRunEdit() {
            const runId = document.getElementById('editRunId').value;
            if (!runId) return;
            
            const runName = document.getElementById('editRunName').value.trim() || 'Untitled Run';
            const type = document.getElementById('editRunType').value || 'Custom';
            const mode = document.getElementById('editRunMode').value || '';
            const tier = document.getElementById('editRunTier').value || '';
            const dungeon = document.getElementById('editRunDungeon').value || '';
            const playerClass = document.getElementById('editRunClass').value || '';
            const buildTag = document.getElementById('editRunBuildTag').value.trim() || '';
            
            // Build dungeon_category display string
            let dungeonCategory = type;
            if (mode) dungeonCategory += ` - ${mode}`;
            if (tier) dungeonCategory += ` T${tier}`;
            
            // Build dungeon_info object
            const dungeonInfo = {
                type: type,
                mode: mode || null,
                tier: tier || null,
                name: dungeon || null
            };
            
            // Get contribution and loot info
            const contributionInput = document.getElementById('editContribution');
            const contributionValue = contributionInput ? parseFloat(contributionInput.value) : null;
            const contributionPercent = (!isNaN(contributionValue) && contributionValue >= 0 && contributionValue <= 100) ? contributionValue : null;
            
            const gotLoot = document.querySelector('input[name="editGotLoot"]:checked')?.value === 'yes';
            const lootItem = gotLoot ? (document.getElementById('editLootItem')?.value.trim() || null) : null;
            
            if (!ws || ws.readyState !== WebSocket.OPEN) {
                alert('Not connected to server');
                return;
            }
            
            ws.send(JSON.stringify({
                command: 'update_run',
                run_id: runId,
                run_name: runName,
                dungeon_category: dungeonCategory,
                dungeon_name: dungeon || dungeonCategory,
                dungeon_info: dungeonInfo,
                player_class: playerClass,
                build_tag: buildTag,
                contribution_percent: contributionPercent,
                got_loot: gotLoot,
                loot_item: lootItem
            }));
            
            closeEditRunModal();
        }
        
        // Track expanded adds groups in run summary (keyed by runId + groupIndex)
        let expandedRunSummaryAddsGroups = new Set();
        
        function renderRunTimeline(run) {
            const encounters = run.encounters || [];
            const stats = run.stats || {};
            const runId = run.id || 'unknown';
            
            if (encounters.length === 0) {
                // Fallback for old runs without encounter data
                if (stats.encounter_count > 0) {
                    return `<div style="color: #7A8CB8; font-size: 0.75rem; font-style: italic;">⚠️ This run was saved before encounter timeline was added. Re-save to enable timeline.</div>`;
                }
                return `<div style="color: #7A8CB8; font-size: 0.75rem; font-style: italic;">No encounter data available</div>`;
            }
            
            // Category styling
            const categoryStyles = {
                'archboss': { icon: '👑', color: '#fbbf24', label: 'Archboss' },
                'raid_boss': { icon: '🏰', color: '#ec4899', label: 'Raid Boss' },
                'field_boss': { icon: '🐉', color: '#5B92D4', label: 'Field Boss' },
                'dungeon_boss': { icon: '⚔️', color: '#3b82f6', label: 'Boss' },
                'adds': { icon: '💀', color: '#ef4444', label: 'Adds' },
                'other': { icon: '📦', color: '#7A8CB8', label: 'Other' }
            };
            
            // Group consecutive adds together
            const groupedItems = [];
            let currentAddsGroup = null;
            
            encounters.forEach((enc, idx) => {
                if (enc.category === 'adds') {
                    if (!currentAddsGroup) {
                        currentAddsGroup = {
                            type: 'adds_group',
                            encounters: [],
                            startIdx: idx
                        };
                    }
                    currentAddsGroup.encounters.push({ enc, originalIdx: idx });
                } else {
                    if (currentAddsGroup) {
                        groupedItems.push(currentAddsGroup);
                        currentAddsGroup = null;
                    }
                    groupedItems.push({ type: 'single', enc, originalIdx: idx });
                }
            });
            
            if (currentAddsGroup) {
                groupedItems.push(currentAddsGroup);
            }
            
            let html = '';
            
            // Vertical timeline
            html += `<div style="position: relative; padding-left: 20px;">`;
            
            // Timeline line
            html += `<div style="position: absolute; left: 6px; top: 0; bottom: 0; width: 2px; background: linear-gradient(to bottom, #263956, #1D2F50);"></div>`;
            
            // Calculate run start time for relative timestamps
            const runStart = encounters.length > 0 ? new Date(encounters[0].start_time) : null;
            
            let groupCounter = 0;
            
            groupedItems.forEach((item) => {
                if (item.type === 'adds_group') {
                    // Render collapsed adds group
                    const groupId = `run_${runId}_adds_${groupCounter}`;
                    const isExpanded = expandedRunSummaryAddsGroups.has(groupId);
                    const addsCount = item.encounters.length;
                    const totalDamage = item.encounters.reduce((sum, e) => sum + (e.enc.total_damage || 0), 0);
                    const avgDps = item.encounters.reduce((sum, e) => sum + (e.enc.dps || 0), 0) / addsCount;
                    const style = categoryStyles['adds'];
                    
                    // Calculate relative time from run start (use first add's time)
                    let relativeTime = '';
                    if (runStart && item.encounters[0]?.enc?.start_time) {
                        const encStart = new Date(item.encounters[0].enc.start_time);
                        const seconds = Math.floor((encStart - runStart) / 1000);
                        const mins = Math.floor(seconds / 60);
                        const secs = seconds % 60;
                        relativeTime = `${mins}:${secs.toString().padStart(2, '0')}`;
                    }
                    
                    html += `
                        <div style="position: relative; margin-bottom: 8px;">
                            <!-- Timeline dot -->
                            <div style="position: absolute; left: -3px; top: 14px; transform: translate(-100%, -50%); width: 10px; height: 10px; background: ${style.color}; border-radius: 50%; box-shadow: 0 0 4px ${style.color}40;"></div>
                            
                            <!-- Collapsible header -->
                            <div onclick="toggleRunSummaryAddsGroup('${groupId}')" style="padding: 8px 10px; background: rgba(239, 68, 68, 0.1); border-radius: 4px; border-left: 2px solid ${style.color}; cursor: pointer; transition: background 0.2s;" onmouseover="this.style.background='rgba(239, 68, 68, 0.15)'" onmouseout="this.style.background='rgba(239, 68, 68, 0.1)'">
                                <div style="display: flex; align-items: center; gap: 8px;">
                                    <span style="font-size: 0.75rem; transition: transform 0.2s; transform: rotate(${isExpanded ? '90deg' : '0deg'});">▶</span>
                                    <span style="font-size: 0.85rem;">${style.icon}</span>
                                    <div style="flex: 1; min-width: 0;">
                                        <div style="font-weight: 600; color: #F0EBE0; font-size: 0.8rem;">Adds <span style="color: ${style.color}; font-weight: 400;">(${addsCount})</span></div>
                                    </div>
                                    <div style="text-align: right;">
                                        <div style="font-size: 0.65rem; color: #7A8CB8;">${relativeTime}</div>
                                        <div style="font-size: 0.75rem; font-weight: 600; color: ${style.color};">${formatCompactNumber(totalDamage)} dmg</div>
                                    </div>
                                </div>
                            </div>
                            
                            <!-- Expanded content -->
                            <div id="${groupId}" style="display: ${isExpanded ? 'block' : 'none'}; margin-left: 16px; margin-top: 4px; border-left: 1px solid rgba(239, 68, 68, 0.3); padding-left: 8px;">
                    `;
                    
                    // Render each add in the group
                    item.encounters.forEach(({ enc }) => {
                        let addRelativeTime = '';
                        if (runStart && enc.start_time) {
                            const encStart = new Date(enc.start_time);
                            const seconds = Math.floor((encStart - runStart) / 1000);
                            const mins = Math.floor(seconds / 60);
                            const secs = seconds % 60;
                            addRelativeTime = `${mins}:${secs.toString().padStart(2, '0')}`;
                        }
                        
                        html += `
                            <div style="padding: 4px 8px; margin-bottom: 4px; background: rgba(21, 32, 53, 0.3); border-radius: 3px;">
                                <div style="display: flex; align-items: center; gap: 6px;">
                                    <span style="color: #405A85; font-size: 0.65rem;">└</span>
                                    <span style="font-size: 0.7rem;">${style.icon}</span>
                                    <div style="flex: 1; min-width: 0;">
                                        <div style="font-weight: 500; color: #7A8CB8; font-size: 0.7rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${enc.target_name}</div>
                                    </div>
                                    <div style="text-align: right;">
                                        <div style="font-size: 0.6rem; color: #7A8CB8;">${addRelativeTime}</div>
                                        <div style="font-size: 0.7rem; font-weight: 600; color: ${style.color};">${formatCompactNumber(enc.total_damage || 0)} dmg</div>
                                    </div>
                                </div>
                            </div>
                        `;
                    });
                    
                    html += `
                            </div>
                        </div>
                    `;
                    
                    groupCounter++;
                } else {
                    // Render single encounter (boss, other)
                    const enc = item.enc;
                    const style = categoryStyles[enc.category] || categoryStyles['other'];
                    const isBoss = ['archboss', 'raid_boss', 'field_boss', 'dungeon_boss'].includes(enc.category);
                    
                    // Calculate relative time from run start
                    let relativeTime = '';
                    if (runStart && enc.start_time) {
                        const encStart = new Date(enc.start_time);
                        const seconds = Math.floor((encStart - runStart) / 1000);
                        const mins = Math.floor(seconds / 60);
                        const secs = seconds % 60;
                        relativeTime = `${mins}:${secs.toString().padStart(2, '0')}`;
                    }
                    
                    // Timeline dot
                    const dotSize = isBoss ? '14px' : '8px';
                    const dotOffset = isBoss ? '-6px' : '-3px';
                    
                    if (isBoss) {
                        // BOSS - Prominent card with color highlight
                        html += `
                            <div style="position: relative; margin-bottom: 14px; padding: 12px 14px; background: linear-gradient(135deg, rgba(21, 32, 53, 0.9) 0%, rgba(29, 47, 80, 0.8) 100%); border-radius: 8px; border: 1px solid ${style.color}; border-left: 4px solid ${style.color}; box-shadow: 0 2px 12px rgba(0,0,0,0.3), 0 0 20px ${style.color}20;">
                                <!-- Timeline dot -->
                                <div style="position: absolute; left: ${dotOffset}; top: 50%; transform: translate(-100%, -50%); width: ${dotSize}; height: ${dotSize}; background: ${style.color}; border: 2px solid #152035; border-radius: 50%; box-shadow: 0 0 8px ${style.color}60, 0 0 0 3px ${style.color}30;"></div>
                                
                                <div style="display: flex; align-items: center; gap: 10px;">
                                    <span style="font-size: 1.3rem; filter: drop-shadow(0 2px 4px rgba(0,0,0,0.4));">${style.icon}</span>
                                    <div style="flex: 1; min-width: 0;">
                                        <div style="font-weight: 700; color: #F0EBE0; font-size: 0.9rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; text-shadow: 0 1px 2px rgba(0,0,0,0.3);">${enc.target_name}</div>
                                        <div style="font-size: 0.65rem; color: ${style.color}; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;">${style.label}</div>
                                    </div>
                                    <div style="text-align: right; padding: 6px 10px; background: rgba(0,0,0,0.2); border-radius: 6px;">
                                        <div style="font-size: 0.6rem; color: #7A8CB8; margin-bottom: 2px;">${relativeTime}</div>
                                        <div style="font-size: 0.95rem; font-weight: 700; color: ${style.color}; text-shadow: 0 0 10px ${style.color}40;">${formatCompactNumber(enc.dps || 0)} DPS</div>
                                        <div style="font-size: 0.7rem; color: #7A8CB8; margin-top: 2px;">${formatCompactNumber(enc.total_damage || 0)} dmg</div>
                                    </div>
                                </div>
                            </div>
                        `;
                    } else {
                        // OTHER - minimal styling
                        html += `
                            <div style="position: relative; margin-bottom: 8px; padding: 6px 10px; background: rgba(21, 32, 53, 0.3); border-radius: 4px; border-left: 2px solid ${style.color};">
                                <!-- Timeline dot -->
                                <div style="position: absolute; left: ${dotOffset}; top: 50%; transform: translate(-100%, -50%); width: ${dotSize}; height: ${dotSize}; background: ${style.color}; border-radius: 50%; box-shadow: 0 0 3px ${style.color}40;"></div>
                                
                                <div style="display: flex; align-items: center; gap: 8px;">
                                    <span style="font-size: 0.8rem;">${style.icon}</span>
                                    <div style="flex: 1; min-width: 0;">
                                        <div style="font-weight: 500; color: #7A8CB8; font-size: 0.75rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${enc.target_name}</div>
                                    </div>
                                    <div style="text-align: right;">
                                        <div style="font-size: 0.7rem; color: #7A8CB8;">${relativeTime}</div>
                                        <div style="font-size: 0.75rem; font-weight: 600; color: ${style.color};">${formatCompactNumber(enc.total_damage || 0)} dmg</div>
                                    </div>
                                </div>
                            </div>
                        `;
                    }
                }
            });
            
            html += `</div>`;
            
            // Summary stats row below timeline - show damage totals, not DPS
            // Calculate from encounters if not in stats
            const bossCategories = ['archboss', 'raid_boss', 'field_boss', 'dungeon_boss'];
            const totalDamage = stats.total_damage || encounters.reduce((sum, e) => sum + (e.total_damage || 0), 0);
            const bossDamage = stats.boss_damage || encounters.filter(e => bossCategories.includes(e.category)).reduce((sum, e) => sum + (e.total_damage || 0), 0);
            const trashDamage = stats.trash_damage || encounters.filter(e => e.category === 'adds').reduce((sum, e) => sum + (e.total_damage || 0), 0);
            
            html += `
                <div style="display: flex; gap: 16px; margin-top: 12px; padding-top: 12px; border-top: 1px solid #263956; font-size: 0.75rem;">
                    <span style="color: #7A8CB8;">Total: <strong style="color: #D96444;">${formatCompactNumber(totalDamage)} dmg</strong></span>
                    <span style="color: #7A8CB8;">Boss: <strong style="color: #22c55e;">${formatCompactNumber(bossDamage)} dmg</strong></span>
                    <span style="color: #7A8CB8;">Trash: <strong style="color: #ef4444;">${formatCompactNumber(trashDamage)} dmg</strong></span>
                    <span style="color: #7A8CB8;">Time: <strong style="color: #5B92D4;">${formatDuration(stats.duration || 0)}</strong></span>
                </div>
            `;
            
            return html;
        }
        
        function toggleRunSummaryAddsGroup(groupId) {
            if (expandedRunSummaryAddsGroups.has(groupId)) {
                expandedRunSummaryAddsGroups.delete(groupId);
            } else {
                expandedRunSummaryAddsGroups.add(groupId);
            }
            // Re-render
            filterRunSummary();
        }
        
        function formatCompactNumber(num) {
            if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
            if (num >= 1000) return (num / 1000).toFixed(1) + 'k';
            return Math.round(num).toString();
        }
        
        // === TARGET ASSIGNMENT ===

        let targetAssignments = {}; // Will store: { "Tevent": "archboss", "Practice Dummy": "other", etc. }
        let allKnownTargets = new Set(); // All targets we've seen in logs
        let allKnownSkills = new Set(); // All skills we've seen in logs
        let currentModalCategory = null; // Track which category modal is showing
        let targetAssignmentsLoaded = false; // Track if we've loaded from server

        function initializeTargetAssignments(assignments = {}) {
            // Server sends all assignments from default_target_assignments.json
            targetAssignments = {...assignments};
            targetAssignmentsLoaded = true;
            console.log('[TargetAssign] Loaded', Object.keys(targetAssignments).length, 'assignments from server');
            updateTargetAssignmentDisplay();
        }

        function updateTargetAssignmentDisplay() {
            // Count targets per category from ALL assignments
            const counts = { archboss: 0, raid_boss: 0, field_boss: 0, dungeon_boss: 0, dungeon_adds: 0, adds: 0, other: 0 };
            
            Object.values(targetAssignments).forEach(assignment => {
                // Parse category from assignment (could be "dungeon_boss:Dungeon Name" or just "archboss")
                const category = assignment.includes(':') ? assignment.split(':')[0] : assignment;
                if (counts[category] !== undefined) {
                    counts[category]++;
                }
            });
            
            // Update count displays
            Object.keys(counts).forEach(category => {
                const countEl = document.getElementById(`count-${category}`);
                if (countEl) countEl.textContent = counts[category];
            });
            
            // Handle unassigned targets (seen in logs but not in assignments)
            const unassigned = [];
            allKnownTargets.forEach(target => {
                if (!targetAssignments[target]) {
                    unassigned.push(target);
                }
            });
            
            const unassignedContainer = document.getElementById('unassignedTargetsList');
            const unassignedCount = document.getElementById('unassignedTargetCount');
            
            if (unassignedCount) unassignedCount.textContent = unassigned.length;
            
            if (unassignedContainer) {
                if (unassigned.length === 0) {
                    unassignedContainer.innerHTML = '<div class="no-targets-message">No unassigned targets</div>';
                } else {
                    unassignedContainer.innerHTML = unassigned.sort().map(target => `
                        <div class="target-chip" draggable="true" ondragstart="dragStartTarget(event, '${escapeHtml(target)}')" data-target="${escapeHtml(target)}">
                            ${escapeHtml(target)}
                        </div>
                    `).join('');
                }
            }
            
            // Update data health counts in sidebar
            updateDataHealthCounts();
        }

        // Helper to get base category from assignment value
        function getBaseCategory(assignment) {
            return assignment.includes(':') ? assignment.split(':')[0] : assignment;
        }

        // Helper to get dungeon from assignment value
        function getDungeonFromAssignment(assignment) {
            return assignment.includes(':') ? assignment.split(':').slice(1).join(':') : null;
        }

        function showAssignedTargets(category) {
            currentModalCategory = category;
            const categoryNames = {
                archboss: '👹 Archboss',
                raid_boss: '🏰 Raid Boss',
                field_boss: '🐉 Field Boss',
                dungeon_boss: '⚔️ Dungeon Boss',
                dungeon_adds: '💀 Dungeon Adds',
                adds: '💀 Adds',
                other: '📦 Other'
            };
            
            document.getElementById('modalCategoryTitle').textContent = categoryNames[category] || category;
            document.getElementById('assignedTargetsSearch').value = '';
            
            renderAssignedTargetsList(category);
            
            document.getElementById('assignedTargetsModal').style.display = 'flex';
        }

        function renderAssignedTargetsList(category, searchFilter = '') {
            const container = document.getElementById('assignedTargetsList');
            
            // Check if this is a dungeon category that supports editing
            const isDungeonCategory = category === 'dungeon_boss' || category === 'dungeon_adds';
            
            // Get targets for this category (match on base category for dungeon assignments)
            const targets = Object.entries(targetAssignments)
                .filter(([target, assignment]) => {
                    const baseCategory = getBaseCategory(assignment);
                    return baseCategory === category;
                })
                .map(([target, assignment]) => ({
                    target,
                    dungeon: getDungeonFromAssignment(assignment)
                }))
                .filter(item => searchFilter === '' || item.target.toLowerCase().includes(searchFilter.toLowerCase()))
                .sort((a, b) => a.target.localeCompare(b.target));
            
            if (targets.length === 0) {
                container.innerHTML = '<div style="text-align: center; color: #7A8CB8; padding: 40px;">No targets assigned to this category</div>';
                return;
            }
            
            container.innerHTML = targets.map(item => `
                <div style="display: flex; justify-content: space-between; align-items: center; padding: 10px 12px; background: #152035; border: 1px solid #263956; border-radius: 6px; margin-bottom: 8px;">
                    <div style="flex: 1;">
                        <span style="color: #F0EBE0; font-size: 0.9rem;">${escapeHtml(item.target)}</span>
                        ${item.dungeon ? `<span style="display: block; color: #3b82f6; font-size: 0.75rem; margin-top: 2px;">📍 ${escapeHtml(item.dungeon)}</span>` : 
                          (isDungeonCategory ? `<span style="display: block; color: #f59e0b; font-size: 0.75rem; margin-top: 2px;">⚠️ No dungeon assigned</span>` : '')}
                    </div>
                    <div style="display: flex; gap: 6px;">
                        ${isDungeonCategory ? `<button onclick="editDungeonAssignment('${escapeHtml(item.target)}', '${category}', '${escapeHtml(item.dungeon || '')}')" style="padding: 4px 10px; background: #3b82f6; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 0.75rem; font-weight: 600;">Edit</button>` : ''}
                        <button onclick="unassignTarget('${escapeHtml(item.target)}')" style="padding: 4px 10px; background: #ef4444; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 0.75rem; font-weight: 600;">Unassign</button>
                    </div>
                </div>
            `).join('');
        }

        function filterAssignedTargetsModal() {
            const search = document.getElementById('assignedTargetsSearch').value;
            renderAssignedTargetsList(currentModalCategory, search);
        }

        function unassignTarget(targetName) {
            // Remove from assignments
            delete targetAssignments[targetName];
            
            // Save to server (this will update the defaults file)
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                    command: 'set_target_assignment',
                    target_name: targetName,
                    category: null // null means unassign/delete
                }));
            }
            
            // Update modal list
            renderAssignedTargetsList(currentModalCategory, document.getElementById('assignedTargetsSearch').value);
            
            // Update main display counts
            updateTargetAssignmentDisplay();
        }

        function closeAssignedTargetsModal() {
            document.getElementById('assignedTargetsModal').style.display = 'none';
            currentModalCategory = null;
        }

        function dragStartTarget(event, targetName) {
            event.dataTransfer.setData('text/plain', targetName);
            event.target.classList.add('dragging');
        }

        function allowTargetDrop(event) {
            event.preventDefault();
            event.currentTarget.classList.add('drag-over');
        }

        function dragLeaveTarget(event) {
            if (event.currentTarget === event.target || !event.currentTarget.contains(event.relatedTarget)) {
                event.currentTarget.classList.remove('drag-over');
            }
        }

        function dropTarget(event, category) {
            event.preventDefault();
            event.stopPropagation();
            event.currentTarget.classList.remove('drag-over');

            const targetName = event.dataTransfer.getData('text/plain');
            if (!targetName) return;

            // Remove dragging class from all chips
            document.querySelectorAll('.target-chip.dragging').forEach(el => {
                el.classList.remove('dragging');
            });

            // For dungeon_boss and dungeon_adds, show dungeon selection modal
            if (category === 'dungeon_boss' || category === 'dungeon_adds') {
                showDungeonSelectModal(targetName, category);
                return;
            }

            // Update assignment
            targetAssignments[targetName] = category;

            // Save to server (updates default_target_assignments.json)
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                    command: 'set_target_assignment',
                    target_name: targetName,
                    category: category
                }));
            }

            // Update display
            updateTargetAssignmentDisplay();
        }

        // === DUNGEON SELECTION MODAL ===
        let pendingDungeonTarget = null;
        let pendingDungeonCategory = null;
        let dungeonEditMode = false; // Track if we're editing from assigned targets modal

        function showDungeonSelectModal(targetName, category, currentDungeon = '') {
            pendingDungeonTarget = targetName;
            pendingDungeonCategory = category;
            dungeonEditMode = currentDungeon !== '';
            
            // Set modal title based on category
            const title = dungeonEditMode 
                ? (category === 'dungeon_boss' ? 'Edit Boss Dungeon' : 'Edit Add Dungeon')
                : (category === 'dungeon_boss' ? 'Assign Boss to Dungeon' : 'Assign Add to Dungeon');
            document.getElementById('dungeonSelectTitle').textContent = title;
            document.getElementById('dungeonSelectTarget').textContent = targetName;
            
            // Populate dropdown with Co-op Dungeon entries (use defaultDungeonsData as fallback)
            const dropdown = document.getElementById('dungeonSelectDropdown');
            const dungeons = dungeonsData['Co-op Dungeon'] || defaultDungeonsData['Co-op Dungeon'] || [];
            
            let html = '<option value="">-- Select Dungeon --</option>';
            dungeons.sort().forEach(dungeon => {
                const selected = dungeon === currentDungeon ? 'selected' : '';
                html += `<option value="${dungeon}" ${selected}>${dungeon}</option>`;
            });
            dropdown.innerHTML = html;
            
            // Show modal
            document.getElementById('dungeonSelectModal').classList.add('active');
        }

        function editDungeonAssignment(targetName, category, currentDungeon) {
            // Close the assigned targets modal first
            closeAssignedTargetsModal();
            
            // Open the dungeon selection modal with current dungeon pre-selected
            showDungeonSelectModal(targetName, category, currentDungeon);
        }

        function closeDungeonSelectModal() {
            document.getElementById('dungeonSelectModal').classList.remove('active');
            
            // If we were editing, re-open the assigned targets modal
            const wasEditMode = dungeonEditMode;
            const category = pendingDungeonCategory;
            
            pendingDungeonTarget = null;
            pendingDungeonCategory = null;
            dungeonEditMode = false;
            
            // Re-open the assigned targets modal if we were editing
            if (wasEditMode && category) {
                setTimeout(() => showAssignedTargets(category), 100);
            }
        }

        function confirmDungeonSelection() {
            const dungeon = document.getElementById('dungeonSelectDropdown').value;
            
            if (!dungeon) {
                alert('Please select a dungeon');
                return;
            }
            
            if (!pendingDungeonTarget || !pendingDungeonCategory) return;
            
            // Create assignment value with dungeon info: "dungeon_boss:Dungeon Name"
            const assignmentValue = `${pendingDungeonCategory}:${dungeon}`;
            
            // Track if we need to re-open assigned targets modal
            const wasEditMode = dungeonEditMode;
            const category = pendingDungeonCategory;
            
            // Update local assignment
            targetAssignments[pendingDungeonTarget] = assignmentValue;
            
            // Save to server
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                    command: 'set_target_assignment',
                    target_name: pendingDungeonTarget,
                    category: assignmentValue
                }));
            }
            
            // Update display
            updateTargetAssignmentDisplay();
            
            // Clear pending state
            pendingDungeonTarget = null;
            pendingDungeonCategory = null;
            dungeonEditMode = false;
            
            // Close modal
            document.getElementById('dungeonSelectModal').classList.remove('active');
            
            // Re-open the assigned targets modal if we were editing
            if (wasEditMode && category) {
                setTimeout(() => showAssignedTargets(category), 100);
            }
        }

        // Add targets from combat log
        function addTargetFromLog(targetName) {
            if (!targetName || targetName === 'Unknown') return;
            if (allKnownTargets.has(targetName)) return;

            allKnownTargets.add(targetName);
            updateTargetAssignmentDisplay();
        }

        // Add skills from combat log
        function addSkillFromLog(skillName) {
            if (!skillName || skillName === 'Unknown') return;
            if (allKnownSkills.has(skillName)) return;

            allKnownSkills.add(skillName);
            updateDataHealthCounts();
        }

        // === SKILL SETTINGS ===

        function updateSkillSettingsUI() {
            updateCurrentSkillsList();
            updateSavedSkillsList();
        }

        function updateCurrentSkillsList() {
            const container = document.getElementById('currentSkillsList');
            
            if (!currentStats || !currentStats.skills || currentStats.skills.length === 0) {
                container.innerHTML = '<div class="skill-settings-empty"><div class="skill-settings-empty-icon">📊</div><div>No skills detected yet. Start combat to see skills here.</div></div>';
                return;
            }
            
            // Get skills from current stats
            const skills = currentStats.skills;
            
            // Auto-cleanup: Remove incorrect settings if a skill crits/heavies
            skills.forEach(skill => {
                const settings = skillSettings[skill.name];
                if (settings) {
                    let needsUpdate = false;
                    let newCannotCrit = settings.cannot_crit || false;
                    let newCannotHeavy = settings.cannot_heavy || false;
                    
                    // If skill crit but was marked as cannot_crit, remove that setting
                    if (skill.crits > 0 && settings.cannot_crit) {
                        newCannotCrit = false;
                        needsUpdate = true;
                        console.log(`[SkillSettings] Auto-removing "cannot_crit" for "${skill.name}" - it crit!`);
                    }
                    
                    // If skill heavied but was marked as cannot_heavy, remove that setting
                    if (skill.heavies > 0 && settings.cannot_heavy) {
                        newCannotHeavy = false;
                        needsUpdate = true;
                        console.log(`[SkillSettings] Auto-removing "cannot_heavy" for "${skill.name}" - it heavied!`);
                    }
                    
                    if (needsUpdate) {
                        updateSkillSetting(skill.name, newCannotCrit, newCannotHeavy);
                    }
                }
            });
            
            // Split into two groups
            const noCritNoHeavy = skills.filter(s => s.crits === 0 && s.heavies === 0);
            const hasCritOrHeavy = skills.filter(s => s.crits > 0 || s.heavies > 0);
            
            let html = '';
            
            // Group 1: Skills with no crits and no heavies (potential candidates)
            if (noCritNoHeavy.length > 0) {
                html += `
                    <div class="skill-group-header warning">
                        <span class="skill-group-icon">🔍</span>
                        <span class="skill-group-title">Potential Non-Crit/Heavy Skills</span>
                        <span class="skill-group-count">${noCritNoHeavy.length} skill${noCritNoHeavy.length !== 1 ? 's' : ''}</span>
                    </div>
                    <p class="skill-group-description">These skills had zero crits and zero heavies this encounter. They may be unable to crit/heavy, or you may have had unlucky rolls.</p>
                `;
                
                html += noCritNoHeavy.map(skill => {
                    const settings = skillSettings[skill.name] || {};
                    const cannotCrit = settings.cannot_crit || false;
                    const cannotHeavy = settings.cannot_heavy || false;
                    const hasSettings = cannotCrit || cannotHeavy;
                    
                    return `
                        <div class="skill-setting-row ${hasSettings ? 'has-settings' : ''}">
                            <div class="skill-setting-name">${skill.name}</div>
                            <div class="skill-setting-stats">
                                <span>${skill.hits}</span> hits, 
                                <span class="zero">0</span> crits, 
                                <span class="zero">0</span> heavy
                            </div>
                            <div class="skill-setting-checkboxes">
                                <label class="skill-setting-checkbox ${cannotCrit ? 'crit-checked' : ''}">
                                    <input type="checkbox" 
                                        ${cannotCrit ? 'checked' : ''} 
                                        onchange="updateSkillSetting('${escapeHtml(skill.name)}', this.checked, ${cannotHeavy})">
                                    Cannot Crit
                                </label>
                                <label class="skill-setting-checkbox ${cannotHeavy ? 'heavy-checked' : ''}">
                                    <input type="checkbox" 
                                        ${cannotHeavy ? 'checked' : ''} 
                                        onchange="updateSkillSetting('${escapeHtml(skill.name)}', ${cannotCrit}, this.checked)">
                                    Cannot Heavy
                                </label>
                            </div>
                        </div>
                    `;
                }).join('');
            }
            
            // Group 2: Skills that have crit or heavied (confirmed capabilities)
            if (hasCritOrHeavy.length > 0) {
                html += `
                    <div class="skill-group-header success" style="${noCritNoHeavy.length > 0 ? 'margin-top: 24px;' : ''}">
                        <span class="skill-group-icon">✔</span>
                        <span class="skill-group-title">Confirmed Crit/Heavy Skills</span>
                        <span class="skill-group-count">${hasCritOrHeavy.length} skill${hasCritOrHeavy.length !== 1 ? 's' : ''}</span>
                    </div>
                    <p class="skill-group-description">These skills have crit or heavied this encounter. Options are disabled based on observed behavior.</p>
                `;
                
                html += hasCritOrHeavy.map(skill => {
                    const settings = skillSettings[skill.name] || {};
                    const cannotCrit = settings.cannot_crit || false;
                    const cannotHeavy = settings.cannot_heavy || false;
                    const hasSettings = cannotCrit || cannotHeavy;
                    
                    // Disable checkboxes based on observed behavior
                    const hasCrit = skill.crits > 0;
                    const hasHeavy = skill.heavies > 0;
                    
                    // If skill has crit, it CAN crit, so disable and uncheck "Cannot Crit"
                    // If skill has heavy, it CAN heavy, so disable and uncheck "Cannot Heavy"
                    const effectiveCannotCrit = hasCrit ? false : cannotCrit;
                    const effectiveCannotHeavy = hasHeavy ? false : cannotHeavy;
                    
                    return `
                        <div class="skill-setting-row ${hasSettings && !hasCrit && !hasHeavy ? 'has-settings' : ''}">
                            <div class="skill-setting-name">${skill.name}</div>
                            <div class="skill-setting-stats">
                                <span>${skill.hits}</span> hits, 
                                <span class="${hasCrit ? 'has-value' : 'zero'}">${skill.crits}</span> crits, 
                                <span class="${hasHeavy ? 'has-value' : 'zero'}">${skill.heavies}</span> heavy
                            </div>
                            <div class="skill-setting-checkboxes">
                                <label class="skill-setting-checkbox ${hasCrit ? 'disabled confirmed' : (effectiveCannotCrit ? 'crit-checked' : '')}">
                                    <input type="checkbox" 
                                        ${effectiveCannotCrit ? 'checked' : ''} 
                                        ${hasCrit ? 'disabled' : ''}
                                        onchange="updateSkillSetting('${escapeHtml(skill.name)}', this.checked, ${effectiveCannotHeavy})">
                                    ${hasCrit ? '✔ Can Crit' : 'Cannot Crit'}
                                </label>
                                <label class="skill-setting-checkbox ${hasHeavy ? 'disabled confirmed' : (effectiveCannotHeavy ? 'heavy-checked' : '')}">
                                    <input type="checkbox" 
                                        ${effectiveCannotHeavy ? 'checked' : ''} 
                                        ${hasHeavy ? 'disabled' : ''}
                                        onchange="updateSkillSetting('${escapeHtml(skill.name)}', ${effectiveCannotCrit}, this.checked)">
                                    ${hasHeavy ? '✔ Can Heavy' : 'Cannot Heavy'}
                                </label>
                            </div>
                        </div>
                    `;
                }).join('');
            }
            
            if (html === '') {
                html = '<div class="skill-settings-empty"><div class="skill-settings-empty-icon">📊</div><div>No skills detected yet. Start combat to see skills here.</div></div>';
            }
            
            container.innerHTML = html;
        }

        function updateSavedSkillsList() {
            const container = document.getElementById('savedSkillsList');
            
            const savedSkillNames = Object.keys(skillSettings).filter(name => {
                const s = skillSettings[name];
                return s.cannot_crit || s.cannot_heavy;
            });
            
            if (savedSkillNames.length === 0) {
                container.innerHTML = '<div class="skill-settings-empty"><div class="skill-settings-empty-icon">💾</div><div>No skill settings saved yet. Configure skills above to save them.</div></div>';
                return;
            }
            
            container.innerHTML = savedSkillNames.sort().map(name => {
                const settings = skillSettings[name];
                const cannotCrit = settings.cannot_crit || false;
                const cannotHeavy = settings.cannot_heavy || false;
                
                return `
                    <div class="skill-setting-row has-settings">
                        <div class="skill-setting-name">${name}</div>
                        <div class="skill-setting-stats">
                            ${cannotCrit ? '🚫 Cannot Crit' : ''}
                            ${cannotCrit && cannotHeavy ? ' • ' : ''}
                            ${cannotHeavy ? '🚫 Cannot Heavy' : ''}
                        </div>
                        <div class="skill-setting-checkboxes">
                            <label class="skill-setting-checkbox ${cannotCrit ? 'crit-checked' : ''}">
                                <input type="checkbox" 
                                    ${cannotCrit ? 'checked' : ''} 
                                    onchange="updateSkillSetting('${escapeHtml(name)}', this.checked, ${cannotHeavy})">
                                Cannot Crit
                            </label>
                            <label class="skill-setting-checkbox ${cannotHeavy ? 'heavy-checked' : ''}">
                                <input type="checkbox" 
                                    ${cannotHeavy ? 'checked' : ''} 
                                    onchange="updateSkillSetting('${escapeHtml(name)}', ${cannotCrit}, this.checked)">
                                Cannot Heavy
                            </label>
                        </div>
                        <button class="skill-setting-delete" onclick="deleteSkillSetting('${escapeHtml(name)}')" title="Remove setting">🗑️</button>
                    </div>
                `;
            }).join('');
        }

        function escapeHtml(str) {
            return str.replace(/'/g, "\\'").replace(/"/g, '\\"');
        }

        function updateSkillSetting(skillName, cannotCrit, cannotHeavy) {
            sendCommand('set_skill_setting', {
                skill_name: skillName,
                cannot_crit: cannotCrit,
                cannot_heavy: cannotHeavy
            });
        }

        function deleteSkillSetting(skillName) {
            if (confirm(`Remove settings for "${skillName}"?`)) {
                sendCommand('delete_skill_setting', { skill_name: skillName });
            }
        }

        function requestSkillSettings() {
            sendCommand('get_skill_settings');
        }

        // === WEAPON ANALYSIS ===

        function handleWeaponConfigMessage(data) {
            // Store config but DON'T use server-side weaponBreakdown
            // We calculate breakdown client-side to support both live and loaded encounters
            weaponConfig = {
                skillAssignments: data.skillAssignments || {},
                currentSkills: weaponConfig.currentSkills || [],
                weaponBreakdown: weaponConfig.weaponBreakdown || {}
            };
            
            // Reset hash to force re-render with new assignments
            lastSkillAssignmentHash = '';
            
            // Recalculate breakdown from current stats (client-side)
            recalculateWeaponBreakdown();

            // recalculateWeaponBreakdown() bails before rendering when there are
            // no live stats yet (fresh launch / between fights). The weapon-card
            // counts + assignment list derive only from skillAssignments, not from
            // stats — so render them now regardless, else a fresh launch shows
            // empty weapon cards even though the preset assigns 67 skills.
            if (!currentStats) {
                updateSkillAssignments(true);
            }

            // Update data health counts
            updateDataHealthCounts();
        }

        function updateWeaponsUI() {
            updateWeaponBreakdown();
            updatePieChart();
            updateSkillAssignments();
        }

        function updateWeaponBreakdown() {
            const container = document.getElementById('weaponBreakdownGrid');
            const breakdown = weaponConfig.weaponBreakdown || {};
            
            if (Object.keys(breakdown).length === 0) {
                container.innerHTML = `
                    <div class="no-data" style="grid-column: 1/-1;">
                        <div class="no-data-icon">⚔️</div>
                        <div>Assign skills in the <strong>Skill Assign</strong> tab to see breakdown</div>
                    </div>
                `;
                return;
            }
            
            const categoryOrder = ['greatsword', 'sns', 'dagger', 'spear', 'crossbow', 'longbow', 'staff', 'wand', 'orb', 'mastery', 'other', 'unassigned'];
            const categoryNames = {
                greatsword: 'Greatsword',
                sns: 'Sword & Shield',
                dagger: 'Dagger',
                spear: 'Spear',
                crossbow: 'Crossbow',
                longbow: 'Longbow',
                staff: 'Staff',
                wand: 'Wand',
                orb: 'Orb',
                mastery: 'Weapon Mastery',
                other: 'Other',
                unassigned: 'Unassigned'
            };
            const categoryIcons = {
                greatsword: '⚔️',
                sns: '🛡️',
                dagger: '🗡️',
                spear: '🔱',
                crossbow: '🏹',
                longbow: '🎯',
                staff: '🪄',
                wand: '✨',
                orb: '🔮',
                mastery: '💠',
                other: '📦',
                unassigned: '❓'
            };
            
            let html = '';
            
            categoryOrder.forEach(cat => {
                const data = breakdown[cat];
                if (!data || data.damage === 0) return;
                
                // Use the category as the card class for CSS styling
                const cardClass = cat;
                
                const categoryName = categoryNames[cat];
                const icon = categoryIcons[cat];
                
                const skills = data.skills || [];
                const topSkills = skills.slice(0, 5);
                
                html += `
                    <div class="weapon-breakdown-card ${cardClass}">
                        <div class="breakdown-header">
                            <div class="breakdown-title">
                                <span class="breakdown-icon">${icon}</span>
                                <div>
                                    <div class="breakdown-name">${categoryName}</div>
                                </div>
                            </div>
                            <div class="breakdown-percent">${(data.percent || 0).toFixed(1)}%</div>
                        </div>
                        
                        <div class="breakdown-damage">${formatNumber(data.damage || 0)}</div>
                        
                        <div class="breakdown-bar">
                            <div class="breakdown-bar-fill" style="width: ${data.percent || 0}%"></div>
                        </div>
                        
                        <div class="breakdown-stats">
                            <div class="breakdown-stat">
                                <span class="breakdown-stat-label">Hits</span>
                                <span class="breakdown-stat-value">${data.hits || 0}</span>
                            </div>
                            <div class="breakdown-stat">
                                <span class="breakdown-stat-label">Avg Hit</span>
                                <span class="breakdown-stat-value">${formatNumber(Math.round(data.avg_hit || 0))}</span>
                            </div>
                            <div class="breakdown-stat">
                                <span class="breakdown-stat-label">Crit %</span>
                                <span class="breakdown-stat-value">${(data.crit_rate || 0).toFixed(1)}%</span>
                            </div>
                            <div class="breakdown-stat">
                                <span class="breakdown-stat-label">Heavy %</span>
                                <span class="breakdown-stat-value">${(data.heavy_rate || 0).toFixed(1)}%</span>
                            </div>
                        </div>
                        
                        ${topSkills.length > 0 ? `
                            <div class="breakdown-skills">
                                <div class="breakdown-skills-title">Top Skills</div>
                                ${topSkills.map(s => `
                                    <div class="breakdown-skill-row">
                                        <span class="breakdown-skill-name">${s.name}</span>
                                        <span class="breakdown-skill-damage">${formatNumber(s.damage)}</span>
                                    </div>
                                `).join('')}
                            </div>
                        ` : ''}
                    </div>
                `;
            });
            
            if (!html) {
                html = `
                    <div class="no-data" style="grid-column: 1/-1;">
                        <div class="no-data-icon">📊</div>
                        <div>No damage data yet. Start combat to see breakdown!</div>
                    </div>
                `;
            }
            
            container.innerHTML = html;
        }

        function updatePieChart() {
            const canvas = document.getElementById('categoryPieChart');
            const legendContainer = document.getElementById('pieChartLegend');
            const breakdown = weaponConfig.weaponBreakdown || {};
            
            if (!canvas || !legendContainer) return;
            
            const categoryOrder = ['greatsword', 'sns', 'dagger', 'spear', 'crossbow', 'longbow', 'staff', 'wand', 'orb', 'mastery', 'other', 'unassigned'];
            const categoryNames = {
                greatsword: 'Greatsword',
                sns: 'Sword & Shield',
                dagger: 'Dagger',
                spear: 'Spear',
                crossbow: 'Crossbow',
                longbow: 'Longbow',
                staff: 'Staff',
                wand: 'Wand',
                orb: 'Orb',
                mastery: 'Weapon Mastery',
                other: 'Other',
                unassigned: 'Unassigned'
            };
            const categoryColors = {
                greatsword: '#ef4444',  // Red
                sns: '#f97316',         // Orange
                dagger: '#5B92D4',      // Purple
                spear: '#ec4899',       // Pink
                crossbow: '#22c55e',    // Green
                longbow: '#84cc16',     // Lime
                staff: '#3b82f6',       // Blue
                wand: '#D96444',        // Cyan
                orb: '#8b5cf6',         // Violet
                mastery: '#fbbf24',     // Yellow
                other: '#7A8CB8',       // Gray
                unassigned: '#405A85'   // Dark gray
            };
            
            // Collect data for pie chart
            const pieData = [];
            let totalDamage = 0;
            
            categoryOrder.forEach(cat => {
                const data = breakdown[cat];
                if (!data || data.damage === 0) return;
                
                pieData.push({
                    category: cat,
                    name: categoryNames[cat],
                    damage: data.damage,
                    percent: data.percent,
                    color: categoryColors[cat]
                });
                totalDamage += data.damage;
            });
            
            // Draw pie chart
            const ctx = canvas.getContext('2d');
            const centerX = canvas.width / 2;
            const centerY = canvas.height / 2;
            const radius = Math.min(centerX, centerY) - 10;
            
            // Clear canvas
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            
            if (pieData.length === 0 || totalDamage === 0) {
                // Draw empty state
                ctx.beginPath();
                ctx.arc(centerX, centerY, radius, 0, 2 * Math.PI);
                ctx.fillStyle = '#263956';
                ctx.fill();
                
                ctx.fillStyle = '#7A8CB8';
                ctx.font = '14px system-ui';
                ctx.textAlign = 'center';
                ctx.fillText('No data', centerX, centerY);
                
                legendContainer.innerHTML = '<div class="pie-chart-empty">Assign skills in the Skill Assign tab</div>';
                return;
            }
            
            // Draw pie slices
            let startAngle = -Math.PI / 2; // Start from top
            
            pieData.forEach(item => {
                const sliceAngle = (item.damage / totalDamage) * 2 * Math.PI;
                
                ctx.beginPath();
                ctx.moveTo(centerX, centerY);
                ctx.arc(centerX, centerY, radius, startAngle, startAngle + sliceAngle);
                ctx.closePath();
                ctx.fillStyle = item.color;
                ctx.fill();
                
                // Add subtle border between slices
                ctx.strokeStyle = '#1D2F50';
                ctx.lineWidth = 2;
                ctx.stroke();
                
                startAngle += sliceAngle;
            });
            
            // Draw center hole (donut effect)
            ctx.beginPath();
            ctx.arc(centerX, centerY, radius * 0.5, 0, 2 * Math.PI);
            ctx.fillStyle = '#1D2F50';
            ctx.fill();
            
            // Draw total damage in center
            ctx.fillStyle = '#F0EBE0';
            ctx.font = 'bold 18px system-ui';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(formatNumber(totalDamage), centerX, centerY - 8);
            
            ctx.fillStyle = '#7A8CB8';
            ctx.font = '11px system-ui';
            ctx.fillText('60s Damage', centerX, centerY + 12);
            
            // Render legend
            legendContainer.innerHTML = pieData.map(item => `
                <div class="pie-legend-item">
                    <div class="pie-legend-color" style="background: ${item.color}"></div>
                    <span class="pie-legend-label">${item.name}</span>
                    <span class="pie-legend-value">${formatNumber(item.damage)}</span>
                    <span class="pie-legend-percent">${item.percent.toFixed(1)}%</span>
                </div>
            `).join('');
        }

        function updateSkillAssignments(forceRender = false) {
            // Don't re-render during drag operations - it destroys the dragged element
            if (isDragging) {
                return;
            }
            
            const unassignedList = document.getElementById('unassignedSkillsList');
            const unassignedCountEl = document.getElementById('unassignedCount');
            
            // Check if elements exist (tab might not be active)
            if (!unassignedList || !unassignedCountEl) {
                return;
            }
            
            const skills = weaponConfig.currentSkills || [];
            const assignments = weaponConfig.skillAssignments || {};
            
            // Create a hash of current state to detect changes
            const skillNames = skills.map(s => s.name).sort().join(',');
            const assignmentStr = Object.entries(assignments).sort().map(([k,v]) => `${k}:${v}`).join(',');
            const currentHash = `${skillNames}|${assignmentStr}`;
            
            // Skip re-render if nothing changed (unless forced)
            if (!forceRender && currentHash === lastSkillAssignmentHash) {
                return;
            }
            lastSkillAssignmentHash = currentHash;
            
            // Update weapon card counts
            updateWeaponCardCounts();
            
            if (skills.length === 0) {
                unassignedList.innerHTML = '<div class="no-skills-message">No skills detected. Start combat to see skills.</div>';
                unassignedCountEl.textContent = '0';
                return;
            }
            
            // Split skills into unassigned and assigned
            const unassigned = skills.filter(s => !assignments[s.name] || assignments[s.name] === 'unassigned');
            
            // Render unassigned as chips
            if (unassigned.length === 0) {
                unassignedList.innerHTML = '<div class="no-skills-message">All skills assigned! 🎉</div>';
            } else {
                unassignedList.innerHTML = unassigned
                    .sort((a, b) => a.name.localeCompare(b.name))
                    .map(skill => renderSkillChip(skill.name, 'unassigned'))
                    .join('');
            }
            
            // Update count
            unassignedCountEl.textContent = unassigned.length;
        }
        
        // Alias for compatibility
        function updateSkillAssignmentDisplay() {
            updateSkillAssignments(true);
        }

        function renderSkillChip(skillName, weapon, icon = null) {
            const isAssigned = weapon && weapon !== 'unassigned';
            return `
                <div class="skill-chip ${isAssigned ? '' : 'unassigned'}" 
                     data-skill="${skillName}" 
                     data-weapon="${weapon}"
                     draggable="true"
                     ondragstart="dragStart(event)"
                     ondragend="dragEnd(event)">
                    ${isAssigned && icon ? `<span class="chip-weapon">${icon}</span>` : ''}
                    <span class="chip-name">${skillName}</span>
                    ${isAssigned ? `<span class="chip-remove" onclick="unassignSkill('${escapeHtml(skillName)}')" title="Unassign">✕</span>` : ''}
                </div>
            `;
        }

        function updateWeaponCardCounts() {
            const assignments = weaponConfig.skillAssignments || {};
            const counts = {};
            
            // Count all assignments (not just current encounter)
            Object.values(assignments).forEach(weapon => {
                if (weapon && weapon !== 'unassigned') {
                    counts[weapon] = (counts[weapon] || 0) + 1;
                }
            });
            
            // Update each card's count display
            const weapons = ['greatsword', 'sns', 'dagger', 'spear', 'crossbow', 'longbow', 'staff', 'wand', 'orb', 'mastery', 'other'];
            weapons.forEach(weapon => {
                // Handle special case for 'other' which uses 'count-other-skill' to avoid conflict with target assign
                const elementId = weapon === 'other' ? 'count-other-skill' : `count-${weapon}`;
                const countEl = document.getElementById(elementId);
                if (countEl) {
                    const count = counts[weapon] || 0;
                    countEl.textContent = count;
                }
            });
        }

        let currentAssignedWeapon = null;
        
        let currentSkillModalWeapon = null;
        
        function showAssignedSkillsModal(weapon) {
            currentSkillModalWeapon = weapon;
            const weaponNames = {
                greatsword: '⚔️ Greatsword', sns: '🛡️ Sword & Shield', dagger: '🗡️ Dagger', spear: '🔱 Spear',
                crossbow: '🏹 Crossbow', longbow: '🎯 Longbow', staff: '🪄 Staff', wand: '✨ Wand',
                orb: '🔮 Orb', mastery: '💠 Mastery', other: '📦 Other'
            };
            
            document.getElementById('skillModalTitle').textContent = weaponNames[weapon] || weapon;
            document.getElementById('assignedSkillsSearch').value = '';
            
            renderAssignedSkillsList(weapon);
            
            document.getElementById('assignedSkillsModal').style.display = 'flex';
        }
        
        function renderAssignedSkillsList(weapon, searchFilter = '') {
            const container = document.getElementById('assignedSkillsModalList');
            const assignments = weaponConfig.skillAssignments || {};
            
            // Get skills for this weapon
            const skills = Object.entries(assignments)
                .filter(([skill, w]) => w === weapon)
                .map(([skill]) => skill)
                .filter(skill => searchFilter === '' || skill.toLowerCase().includes(searchFilter.toLowerCase()))
                .sort();
            
            if (skills.length === 0) {
                container.innerHTML = '<div style="text-align: center; color: #7A8CB8; padding: 40px;">No skills assigned to this weapon</div>';
                return;
            }
            
            const weaponIcons = {
                greatsword: '⚔️', sns: '🛡️', dagger: '🗡️', spear: '🔱',
                crossbow: '🏹', longbow: '🎯', staff: '🪄', wand: '✨',
                orb: '🔮', mastery: '💠', other: '📦'
            };
            const icon = weaponIcons[weapon] || '📦';
            
            container.innerHTML = skills.map(skill => `
                <div style="display: flex; justify-content: space-between; align-items: center; padding: 10px 12px; background: #152035; border: 1px solid #263956; border-radius: 6px; margin-bottom: 8px;">
                    <div style="display: flex; align-items: center; gap: 8px;">
                        <span style="font-size: 1rem;">${icon}</span>
                        <span style="color: #F0EBE0; font-size: 0.9rem;">${escapeHtml(skill)}</span>
                    </div>
                    <button onclick="unassignSkillFromModal('${escapeHtml(skill)}')" style="padding: 4px 10px; background: #ef4444; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 0.75rem; font-weight: 600;">Unassign</button>
                </div>
            `).join('');
        }
        
        function filterAssignedSkillsModal() {
            const search = document.getElementById('assignedSkillsSearch').value;
            renderAssignedSkillsList(currentSkillModalWeapon, search);
        }
        
        function unassignSkillFromModal(skillName) {
            // Remove from assignments
            if (weaponConfig.skillAssignments) {
                delete weaponConfig.skillAssignments[skillName];
            }
            
            // Save to server
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                    command: 'set_skill_weapon',
                    skill_name: skillName,
                    weapon: null // null means unassign
                }));
            }
            
            // Update modal list
            renderAssignedSkillsList(currentSkillModalWeapon, document.getElementById('assignedSkillsSearch').value);
            
            // Update counts and unassigned list
            updateSkillAssignmentDisplay();
        }
        
        function closeAssignedSkillsModal() {
            document.getElementById('assignedSkillsModal').style.display = 'none';
            currentSkillModalWeapon = null;
        }
        
        function toggleUnassignedSkills() {
            const content = document.getElementById('unassignedSkillsContent');
            const toggle = document.getElementById('unassignedSkillsToggle');
            if (content.style.display === 'none') {
                content.style.display = 'block';
                toggle.textContent = '▲';
            } else {
                content.style.display = 'none';
                toggle.textContent = '▼';
            }
        }
        
        function filterUnassignedSkills() {
            const search = document.getElementById('skillSearchFilter').value.toLowerCase();
            const chips = document.querySelectorAll('#unassignedSkillsList .skill-chip');
            chips.forEach(chip => {
                const skillName = chip.dataset.skill?.toLowerCase() || '';
                chip.style.display = skillName.includes(search) ? '' : 'none';
            });
        }
        
        // Legacy function - redirect to modal
        function showAssignedSkills(weapon) {
            showAssignedSkillsModal(weapon);
        }
        
        function hideAssignedSkills() {
            closeAssignedSkillsModal();
        }

        // Drag and Drop handlers
        function dragStart(event) {
            const chip = event.target.closest('.skill-chip');
            if (!chip) return;
            
            isDragging = true;  // Set flag to prevent UI updates
            chip.classList.add('dragging');
            event.dataTransfer.setData('text/plain', chip.dataset.skill);
            event.dataTransfer.effectAllowed = 'move';
        }

        function dragEnd(event) {
            isDragging = false;  // Clear flag
            
            const chip = event.target.closest('.skill-chip');
            if (chip) {
                chip.classList.remove('dragging');
            }
            
            // Remove drag-over from all cards
            document.querySelectorAll('.weapon-drop-card').forEach(card => {
                card.classList.remove('drag-over');
            });
        }

        function allowDrop(event) {
            event.preventDefault();
            event.stopPropagation();
            event.dataTransfer.dropEffect = 'move';
            
            // Add visual feedback - support both old and new class names
            const card = event.target.closest('.target-category, .weapon-drop-card');
            if (card) {
                card.classList.add('drag-over');
            }
        }

        function dragLeave(event) {
            const card = event.target.closest('.target-category, .weapon-drop-card');
            if (card && !card.contains(event.relatedTarget)) {
                card.classList.remove('drag-over');
            }
        }

        function dropSkill(event, weapon) {
            event.preventDefault();
            event.stopPropagation();  // Prevent bubbling to parent drop handlers
            
            const card = event.target.closest('.target-category, .weapon-drop-card');
            if (card) {
                card.classList.remove('drag-over');
            }
            
            const skillName = event.dataTransfer.getData('text/plain');
            if (!skillName) return;
            
            // If dropping on assigned section, unassign the skill
            if (weapon === 'unassigned') {
                unassignSkill(skillName);
            } else {
                assignSkill(skillName, weapon);
            }
        }

        function assignSkill(skillName, category) {
            sendCommand('assign_skill', {
                skill_name: skillName,
                category: category
            });
        }

        function unassignSkill(skillName) {
            sendCommand('assign_skill', {
                skill_name: skillName,
                category: 'unassigned'
            });
        }

        // === CLOUD SKILL UPDATE ===
        // Fetches the canonical skill->weapon map from the party worker and MERGES
        // it into the local assignments. Merge is purely additive/refresh: every
        // mapping in the cloud payload is applied via the app's existing
        // 'assign_skill' command (which the backend persists to weapon_config.json
        // and echoes back as a 'weapon_config' message, re-rendering the UI). Local
        // assignments NOT present in the cloud payload are left untouched, so any
        // user-custom assignments survive. We skip cloud entries that already match
        // the local value to avoid redundant round-trips.
        const SKILLS_CLOUD_URL = 'https://tldps-party.kyle-526.workers.dev/skills';
        const VALID_WEAPON_SLUGS = new Set([
            'greatsword','sns','dagger','spear','crossbow','longbow',
            'staff','wand','orb','mastery','other'
        ]);

        async function updateSkillAssignmentsFromCloud() {
            const btn = document.getElementById('updateSkillsBtn');
            const statusEl = document.getElementById('updateSkillsStatus');
            const setStatus = (msg, color) => {
                if (statusEl) {
                    statusEl.textContent = msg;
                    statusEl.style.color = color || '#7A8CB8';
                }
            };

            if (btn) btn.disabled = true;
            setStatus('Updating…', '#fbbf24');

            try {
                const resp = await fetch(SKILLS_CLOUD_URL, {
                    method: 'GET',
                    cache: 'no-store',
                    headers: { 'Accept': 'application/json' }
                });
                if (!resp.ok) {
                    throw new Error('HTTP ' + resp.status);
                }
                const payload = await resp.json();
                const cloudAssignments = (payload && payload.assignments) || {};
                const patch = (payload && payload.patch) != null ? payload.patch : '?';

                const local = (weaponConfig && weaponConfig.skillAssignments) || {};
                let applied = 0;
                let skippedInvalid = 0;

                Object.keys(cloudAssignments).forEach(skillName => {
                    const slug = cloudAssignments[skillName];
                    if (!VALID_WEAPON_SLUGS.has(slug)) { skippedInvalid++; return; }
                    // Skip if local already matches — additive/refresh only.
                    if (local[skillName] === slug) return;
                    // Reuse the app's existing persist+render path.
                    assignSkill(skillName, slug);
                    applied++;
                });

                let msg = `Updated ${applied} skill${applied === 1 ? '' : 's'} (patch ${patch})`;
                if (skippedInvalid > 0) msg += ` · ${skippedInvalid} skipped`;
                setStatus(msg, '#22c55e');
            } catch (err) {
                console.error('[CloudSkills] update failed:', err);
                setStatus('Update failed — ' + (err && err.message ? err.message : 'network error'), '#ef4444');
            } finally {
                if (btn) btn.disabled = false;
            }
        }

        // === MODALS ===

        function openSaveModal() {
            // Check if viewing a loaded encounter (can't re-save it this way)
            if (isViewingLoadedEncounter) {
                alert('You are viewing a loaded encounter. Reset to start a new test before saving.');
                return;
            }
            
            // Check if a build test has been completed
            if (!buildTestComplete || !lastTestData) {
                alert('No test data to save!\n\nClick "Reset Encounter" and complete a 60-second build test first.');
                return;
            }

            saveSource = 'buildtest';
            saveSourceEncounter = null;

            // Show BT context, hide encounter context
            document.getElementById('saveBuildTestContext').style.display = 'block';
            document.getElementById('saveEncounterContext').style.display = 'none';
            
            document.getElementById('savePreviewDps').textContent = formatNumber(Math.round(currentStats.dps_60s || 0));
            document.getElementById('savePreviewTotal').textContent = formatNumber(currentStats.total_damage);
            document.getElementById('savePreviewDuration').textContent = formatDuration(currentStats.duration);
            
            // Populate class dropdown
            const classSelect = document.getElementById('saveClassSelect');
            classSelect.innerHTML = '<option value="">-- Select Your Class --</option>' + 
                TL_CLASSES.map(c => `<option value="${c.name}">${c.name}: ${c.weapons}</option>`).join('');
            classSelect.onchange = function() { updateClassPreview(this.value); };
            
            if (selectedClass) {
                classSelect.value = selectedClass;
                updateClassPreview(selectedClass);
            } else {
                document.getElementById('classPreviewCard').style.display = 'none';
            }
            
            updateRecentBuildTags();
            document.getElementById('buildTagInput').value = '';
            document.getElementById('encounterNotes').value = '';
            document.getElementById('saveModal').classList.add('active');
        }

        function openEncounterSaveModal() {
            if (!selectedEncounterData) {
                alert('No encounter selected.');
                return;
            }

            saveSource = 'encounter';
            saveSourceEncounter = selectedEncounterData;

            const enc = selectedEncounterData;
            const totalDmg = enc.total_damage || 0;
            const dps      = enc.dps || (totalDmg / (enc.duration || 1));
            const cat      = (enc.category || '').replace(/_/g,' ').replace(/\b\w/g,c=>c.toUpperCase());

            // Show encounter context, hide BT preview
            document.getElementById('saveBuildTestContext').style.display = 'none';
            document.getElementById('saveEncounterContext').style.display = 'block';
            document.getElementById('saveEncTarget').textContent   = enc.target_name || 'Unknown';
            document.getElementById('saveEncDuration').textContent = formatDuration(enc.duration || 0);
            document.getElementById('saveEncDps').textContent      = formatNumber(Math.round(dps)) + ' DPS';
            document.getElementById('saveEncCrit').textContent     = (enc.crit_rate || 0).toFixed(1) + '% crit';
            document.getElementById('saveEncBadge').textContent    = cat || 'Encounter';
            document.getElementById('contributionPct').value       = '';
            document.getElementById('bossHpCalc').textContent      = '';

            // Populate class dropdown
            const classSelect = document.getElementById('saveClassSelect');
            classSelect.innerHTML = '<option value="">-- Select Your Class --</option>' +
                TL_CLASSES.map(c => `<option value="${c.name}">${c.name}: ${c.weapons}</option>`).join('');
            classSelect.onchange = function() { updateClassPreview(this.value); };

            const detectedClass = detectClassFromRotation(enc.hit_log || []) || selectedClass || '';
            if (detectedClass) {
                classSelect.value = detectedClass;
                updateClassPreview(detectedClass);
            } else {
                document.getElementById('classPreviewCard').style.display = 'none';
            }

            updateRecentBuildTags();
            document.getElementById('buildTagInput').value  = enc.build_tag || '';
            document.getElementById('encounterNotes').value = enc.notes    || '';
            document.getElementById('saveModal').classList.add('active');
        }

        function updateBossHpCalc() {
            const pct    = parseFloat(document.getElementById('contributionPct').value);
            const enc    = saveSourceEncounter;
            const calc   = document.getElementById('bossHpCalc');
            if (!calc) return;
            if (!enc || !pct || pct <= 0 || pct > 100) { calc.textContent = ''; return; }
            const bossHp = Math.round(enc.total_damage / (pct / 100));
            calc.textContent = `→ Boss HP ≈ ${formatNumber(bossHp)}`;
        }
        
