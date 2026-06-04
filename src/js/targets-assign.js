        function filterUnassignedTargets() {
            const searchInput = document.getElementById('unassignedSearch');
            const query = searchInput.value.toLowerCase();
            const chips = document.querySelectorAll('#unassignedTargetsList .target-chip');
            
            let visibleCount = 0;
            chips.forEach(chip => {
                const targetName = chip.dataset.target || chip.textContent;
                const matches = targetName.toLowerCase().includes(query);
                chip.style.display = matches ? 'block' : 'none';
                if (matches) visibleCount++;
            });
            
            // Update count
            document.getElementById('unassignedTargetCount').textContent = visibleCount;
        }
        
        function bulkAssignToOther() {
            const chips = document.querySelectorAll('#unassignedTargetsList .target-chip');
            const targets = Array.from(chips).map(chip => chip.dataset.target).filter(Boolean);
            
            if (targets.length === 0) {
                alert('No unassigned targets to assign');
                return;
            }
            
            if (!confirm(`Assign all ${targets.length} unassigned targets to "Other" category?`)) {
                return;
            }
            
            // Assign all to other
            targets.forEach(targetName => {
                targetAssignments[targetName] = 'other';
                
                // Save to server
                if (ws && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({
                        command: 'set_target_assignment',
                        target_name: targetName,
                        category: 'other'
                    }));
                }
            });
            
            // Update display
            updateTargetAssignmentDisplay();
            
            console.log(`[TargetAssign] Bulk assigned ${targets.length} targets to Other`);
        }
        
        function toggleDefaultTargets() {
            const containerEl = document.getElementById('defaultTargetsContainer');
            const noteEl = document.getElementById('defaultTargetsNote');
            const toggleEl = document.getElementById('defaultTargetsToggle');
            
            const isCollapsed = containerEl.style.display === 'none';
            
            containerEl.style.display = isCollapsed ? 'block' : 'none';
            noteEl.style.display = isCollapsed ? 'block' : 'none';
            toggleEl.textContent = isCollapsed ? '▼' : '▶';
            toggleEl.classList.toggle('collapsed', !isCollapsed);
            
            // Populate on first open
            if (isCollapsed && containerEl.innerHTML === '') {
                populateDefaultTargets();
            }
        }
        
        function populateDefaultTargets() {
            // Request defaults from server
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ command: 'get_default_targets' }));
            }
        }
        
        function displayDefaultTargets(defaults) {
            const container = document.getElementById('defaultTargetsContainer');
            const countEl = document.getElementById('defaultTargetsCount');
            
            if (!container) return; // Element doesn't exist, skip
            
            if (!defaults || Object.keys(defaults).length === 0) {
                container.innerHTML = '<div style="color: #64748b; text-align: center; padding: 20px;">No defaults loaded</div>';
                if (countEl) countEl.textContent = '0';
                return;
            }
            
            // Count total
            const totalCount = Object.values(defaults).reduce((sum, arr) => sum + arr.length, 0);
            if (countEl) countEl.textContent = totalCount;
            
            // Store defaults for lookup (defaults are NEVER editable)
            defaultTargetsByCategory = { ...defaults };
            defaultTargetSet = new Set();
            Object.values(defaults).forEach(list => (list || []).forEach(t => defaultTargetSet.add(t)));
            defaultTargetsLoaded = true;
            
            // If we already have server assignments, strip defaults out of the editable assignment map
            if (lastServerAssignments && Object.keys(lastServerAssignments).length > 0) {
                initializeTargetAssignments(lastServerAssignments);
            }

            
            // Build categorized display
            const categoryInfo = {
                'archboss': { icon: '👹', name: 'Archbosses', color: '#fbbf24' },
                'field_boss': { icon: '🐉', name: 'Field Bosses', color: '#5B92D4' },
                'dungeon_boss': { icon: '⚔️', name: 'Dungeon Bosses', color: '#3b82f6' },
                'adds': { icon: '💀', name: 'Adds/Trash', color: '#ef4444' },
                'other': { icon: '📦', name: 'Other', color: '#94a3b8' }
            };
            
            let html = '';
            Object.keys(defaults).forEach(category => {
                const targets = defaults[category];
                if (targets.length === 0) return;
                
                const info = categoryInfo[category] || { icon: '❓', name: category, color: '#94a3b8' };
                
                html += `
                    <div style="margin-bottom: 16px; background: rgba(15, 23, 42, 0.5); border-radius: 8px; padding: 12px;">
                        <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px; padding-bottom: 8px; border-bottom: 1px solid #334155;">
                            <span style="font-size: 1.2rem;">${info.icon}</span>
                            <span style="font-weight: 600; color: ${info.color};">${info.name}</span>
                            <span style="margin-left: auto; background: rgba(100, 116, 139, 0.3); color: #94a3b8; font-size: 0.7rem; padding: 2px 8px; border-radius: 10px;">${targets.length}</span>
                        </div>
                        <div style="display: flex; flex-wrap: wrap; gap: 6px;">
                            ${targets.map(target => `
                                <span style="background: rgba(30, 41, 59, 0.5); border: 1px solid #475569; border-radius: 4px; padding: 3px 8px; font-size: 0.75rem; color: #e2e8f0;">${target}</span>
                            `).join('')}
                        </div>
                    </div>
                `;
            });
            
            container.innerHTML = html;
        }

        // === ENCOUNTER HISTORY ===
        
        let encounterHistory = [];
        
        function refreshEncounterHistory() {
            if (!ws || ws.readyState !== WebSocket.OPEN) {
                console.log('[EncounterHistory] WebSocket not connected');
                return;
            }
            
            console.log('[EncounterHistory] Requesting encounter history');
            ws.send(JSON.stringify({ command: 'get_encounter_history' }));
        }
        
        function displayEncounterHistory(encounters) {
            encounterHistory = encounters;
            const container = document.getElementById('encounterHistoryList');
            const filter = document.getElementById('encounterTargetFilter')?.value || '';
            
            if (!container) return;
            
            console.log('[EncounterHistory] Displaying', encounters.length, 'encounters');
            
            if (encounters.length === 0) {
                container.innerHTML = '<div class="no-data-small">No encounters found in combat log</div>';
                return;
            }
            
            // Filter encounters
            let filtered = encounters;
            if (filter) {
                filtered = encounters.filter(e => e.target_name === filter);
            }
            
            // Update filter dropdown
            updateEncounterFilter(encounters);
            
            // Render encounters
            container.innerHTML = filtered.map(enc => {
                const categoryIcon = getCategoryIcon(enc.category);
                const categoryLabel = enc.category.toUpperCase().replace('_', ' ');
                const durationLabel = enc.duration < 60 ? `${Math.round(enc.duration)}s` : `${Math.floor(enc.duration / 60)}m ${Math.round(enc.duration % 60)}s`;
                const durationClass = enc.duration >= 60 ? 'valid' : 'warning';
                const gapWarning = enc.gap_before >= 60 && enc.gap_before <= 90 ? `<span style="color: #fbbf24; font-size: 0.75rem;">⚠️ ${Math.round(enc.gap_before)}s gap</span>` : '';
                
                return `
                    <div class="encounter-item" style="background: #1e293b; border: 1px solid #334155; border-radius: 6px; padding: 12px; margin-bottom: 8px;">
                        <div style="display: flex; justify-content: space-between; align-items: start; margin-bottom: 8px;">
                            <div>
                                <div style="font-weight: 600; color: #e2e8f0; font-size: 0.95rem;">${enc.target_name}</div>
                                <div style="font-size: 0.75rem; color: #64748b; margin-top: 2px;">${categoryIcon} ${categoryLabel}</div>
                            </div>
                            <div style="text-align: right;">
                                <div style="font-size: 0.8rem; color: #94a3b8;">${enc.date_label || enc.time_label}</div>
                                <div style="font-size: 0.75rem; color: #64748b;">${durationLabel} <span class="duration-${durationClass}">${enc.duration >= 60 ? '✓' : '⚠️'}</span></div>
                            </div>
                        </div>
                        <div style="display: flex; gap: 16px; margin-bottom: 8px; font-size: 0.8rem;">
                            <div><span style="color: #D96444; font-weight: 600;">${Math.round(enc.dps).toLocaleString()}</span> <span style="color: #64748b;">DPS</span></div>
                            <div><span style="color: #e2e8f0; font-weight: 600;">${(enc.total_damage / 1000).toFixed(0)}K</span> <span style="color: #64748b;">dmg</span></div>
                        </div>
                        ${gapWarning}
                        <button onclick="loadEncounterFromHistory('${enc.target_name}', '${enc.start_time}')" style="width: 100%; padding: 8px; background: #0ea5e9; color: white; border: none; border-radius: 4px; cursor: pointer; font-weight: 600; font-size: 0.85rem; margin-top: 8px;">
                            Load Encounter
                        </button>
                    </div>
                `;
            }).join('');
        }
        
        function updateEncounterFilter(encounters) {
            const filterEl = document.getElementById('encounterTargetFilter');
            if (!filterEl) return;
            
            const currentValue = filterEl.value;
            const uniqueTargets = [...new Set(encounters.map(e => e.target_name))].sort();
            
            filterEl.innerHTML = '<option value="">All Targets</option>' + 
                uniqueTargets.map(t => `<option value="${t}">${t}</option>`).join('');
            
            filterEl.value = currentValue;
            
            // Add change listener
            filterEl.onchange = () => displayEncounterHistory(encounterHistory);
        }
        
        function getCategoryIcon(category) {
            const icons = {
                'archboss': '👹',
                'raid_boss': '🏰',
                'field_boss': '🐉',
                'dungeon_boss': '⚔️',
                'adds': '💀',
                'other': '📦'
            };
            return icons[category] || '❓';
        }
        
        function loadEncounterFromHistory(targetName, startTime) {
            console.log('[EncounterHistory] Loading encounter:', targetName, startTime);
            
            if (!ws || ws.readyState !== WebSocket.OPEN) {
                alert('WebSocket not connected');
                return;
            }
            
            // Send command to server to load encounter details
            ws.send(JSON.stringify({
                command: 'load_encounter_data',
                target_name: targetName,
                start_time: startTime
            }));
            
            console.log('[EncounterHistory] Request sent to server');
        }
        
        // === RUN BUILDER ===
        
        let runEncounters = []; // Encounters in the current run being built
        let timelineEncounters = []; // Source encounters from timeline (read-only)
        let selectedTimelineIndices = new Set(); // Indices of selected encounters for multi-drag
        let showAddsInTimeline = true; // Whether to show adds in the timeline
        
        function refreshEncounterTimeline() {
            if (!ws || ws.readyState !== WebSocket.OPEN) {
                console.log('[RunBuilder] WebSocket not connected');
                return;
            }
            
            // Clear selection when refreshing
            selectedTimelineIndices.clear();
            
            console.log('[RunBuilder] Requesting encounter timeline');
            ws.send(JSON.stringify({ command: 'get_encounter_history' }));
        }
        
        function displayEncounterTimeline(encounters) {
            timelineEncounters = encounters.sort((a, b) => new Date(a.start_time) - new Date(b.start_time));
            const container = document.getElementById('encounterTimelineList');
            
            if (!container) return;
            
            if (timelineEncounters.length === 0) {
                container.innerHTML = '<div style="color: #64748b; text-align: center; padding: 40px 20px; font-size: 0.85rem;">No encounters in current session</div>';
                // Hide selection bar
                const selectionBar = document.getElementById('timelineSelectionBar');
                if (selectionBar) selectionBar.style.display = 'none';
                return;
            }
            
            // Create set of encounter IDs already in run for quick lookup
            const usedEncounterIds = new Set(
                runEncounters.map(e => `${e.target_name}|${e.start_time}`)
            );
            
            // Category colors
            const categoryColors = {
                'archboss': '#fbbf24',
                'raid_boss': '#ec4899',
                'field_boss': '#5B92D4',
                'dungeon_boss': '#3b82f6',
                'adds': '#ef4444',
                'other': '#64748b'
            };
            
            // Category labels
            const categoryLabels = {
                'archboss': 'Archboss',
                'raid_boss': 'Raid Boss',
                'field_boss': 'Field Boss',
                'dungeon_boss': 'Dungeon Boss',
                'adds': 'Adds',
                'other': 'Other'
            };
            
            // Get first and last timestamps for timeline
            const firstTime = new Date(timelineEncounters[0].start_time);
            const lastTime = new Date(timelineEncounters[timelineEncounters.length - 1].end_time);
            
            let html = '<div style="position: relative; padding-left: 24px;">';
            
            // Vertical line
            html += '<div style="position: absolute; left: 10px; top: 30px; bottom: 30px; width: 3px; background: linear-gradient(to bottom, #D96444, #5B92D4, #ef4444); border-radius: 2px; box-shadow: 0 0 8px rgba(217, 100, 68, 0.3);"></div>';
            
            // Start time marker
            html += `<div style="margin-bottom: 12px; padding-left: 8px; color: #64748b; font-size: 0.75rem; font-weight: 600;">▶ START: ${firstTime.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}</div>`;
            
            timelineEncounters.forEach((enc, idx) => {
                // Skip adds if toggle is off
                if (!showAddsInTimeline && (enc.category === 'adds' || enc.category === 'other')) {
                    return;
                }
                
                const categoryIcon = getCategoryIcon(enc.category);
                const color = categoryColors[enc.category] || '#64748b';
                const categoryLabel = categoryLabels[enc.category] || 'Other';
                const startTime = new Date(enc.start_time).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
                const durationLabel = enc.duration < 60 ? `${Math.round(enc.duration)}s` : `${Math.floor(enc.duration / 60)}m ${Math.round(enc.duration % 60)}s`;
                
                // Check if this encounter is already in the run
                const encounterId = `${enc.target_name}|${enc.start_time}`;
                const isUsed = usedEncounterIds.has(encounterId);
                
                // Calculate gap before this encounter
                if (idx > 0) {
                    const prevEnc = timelineEncounters[idx - 1];
                    const prevEnd = new Date(prevEnc.end_time);
                    const currStart = new Date(enc.start_time);
                    const gap = (currStart - prevEnd) / 1000;
                    
                    // Check if current encounter is a boss - look back for same boss to merge
                    let mergeCandidate = null;
                    let mergeGap = 0;
                    let mergeCandidateIdx = -1;
                    
                    if (isBossCategory(enc.category)) {
                        // Look back through previous encounters to find same boss
                        for (let lookBack = idx - 1; lookBack >= 0; lookBack--) {
                            const prevBoss = timelineEncounters[lookBack];
                            
                            // Skip adds/trash
                            if (prevBoss.category === 'adds' || prevBoss.category === 'other') {
                                continue;
                            }
                            
                            // Found a boss - check if same name
                            if (isBossCategory(prevBoss.category) && prevBoss.target_name === enc.target_name) {
                                const bossEnd = new Date(prevBoss.end_time);
                                const totalGap = (currStart - bossEnd) / 1000;
                                
                                // Check if within mergeable range (31-90s)
                                if (totalGap >= 31 && totalGap <= 90) {
                                    mergeCandidate = prevBoss;
                                    mergeGap = totalGap;
                                    mergeCandidateIdx = lookBack;
                                }
                            }
                            // Stop looking once we hit any boss (whether match or not)
                            break;
                        }
                    }
                    
                    if (mergeCandidate && mergeCandidateIdx >= 0) {
                        // Show merge indicator for same boss with adds in between
                        html += `
                            <div style="margin: 8px 0; padding-left: 8px;">
                                <div class="timeline-merge-indicator">
                                    <div class="merge-line"></div>
                                    <div class="merge-content">
                                        <span class="merge-gap">⏱️ ${Math.round(mergeGap)}s gap</span>
                                        <button class="merge-btn" onclick="event.stopPropagation(); mergeTimelineEncounters(${mergeCandidateIdx}, ${idx})">
                                            🔗 Merge
                                        </button>
                                    </div>
                                    <div class="merge-line"></div>
                                </div>
                            </div>
                        `;
                    } else if (gap > 3) { // Show regular gaps > 3 seconds
                        html += `
                            <div style="margin: 8px 0; padding-left: 8px; display: flex; align-items: center; gap: 8px;">
                                <div style="flex: 1; height: 1px; background: repeating-linear-gradient(to right, #64748b 0px, #64748b 4px, transparent 4px, transparent 8px);"></div>
                                <span style="color: #64748b; font-size: 0.7rem; white-space: nowrap;">⏱️ ${Math.round(gap)}s gap</span>
                                <div style="flex: 1; height: 1px; background: repeating-linear-gradient(to right, #64748b 0px, #64748b 4px, transparent 4px, transparent 8px);"></div>
                            </div>
                        `;
                    }
                }
                
                const rgbMap = {
                    '#fbbf24': '251, 191, 36',
                    '#ec4899': '236, 72, 153',
                    '#5B92D4': '168, 85, 247',
                    '#3b82f6': '59, 130, 246',
                    '#ef4444': '239, 68, 68',
                    '#64748b': '100, 116, 139'
                };
                const rgb = rgbMap[color] || '100, 116, 139';
                
                // Style differently if used
                const usedStyles = isUsed ? `
                    opacity: 0.5;
                    cursor: not-allowed;
                ` : `
                    cursor: grab;
                `;
                
                const cardUsedStyles = isUsed ? `
                    background: linear-gradient(135deg, rgba(30, 41, 59, 0.5) 0%, rgba(15, 23, 42, 0.5) 100%);
                    border-color: #334155;
                ` : `
                    background: linear-gradient(135deg, rgba(30, 41, 59, 0.9) 0%, rgba(15, 23, 42, 0.9) 100%);
                    border: 1px solid ${color};
                `;
                
                const nameStyles = isUsed ? `
                    text-decoration: line-through;
                    color: #64748b;
                ` : `
                    color: #e2e8f0;
                `;
                
                const isSelected = selectedTimelineIndices.has(idx);
                const selectedStyles = isSelected && !isUsed ? `
                    box-shadow: 0 0 0 2px #D96444, 0 4px 12px rgba(217, 100, 68, 0.3);
                ` : '';
                
                // Check for merged/attempt flags
                const isMerged = enc.merged === true;
                const isAttempt = enc.is_attempt === true;
                const isBoss = isBossCategory(enc.category);
                
                // Determine border color
                const borderColor = isUsed ? '#334155' : (isAttempt ? '#ef4444' : (isMerged ? '#fbbf24' : (isSelected ? '#D96444' : color)));
                
                // Check if this is the start of a consecutive adds group (for bulk select)
                let addsGroupSize = 0;
                let addsGroupIndices = [];
                if ((enc.category === 'adds' || enc.category === 'other') && !isUsed) {
                    // Count consecutive adds/other with small gaps
                    addsGroupIndices.push(idx);
                    for (let j = idx + 1; j < timelineEncounters.length; j++) {
                        const nextEnc = timelineEncounters[j];
                        if (nextEnc.category !== 'adds' && nextEnc.category !== 'other') break;
                        
                        // Check gap
                        const prevEnd = new Date(timelineEncounters[j-1].end_time);
                        const nextStart = new Date(nextEnc.start_time);
                        const gap = (nextStart - prevEnd) / 1000;
                        if (gap > 30) break; // Stop if gap > 30s
                        
                        // Check if already used
                        const nextId = `${nextEnc.target_name}|${nextEnc.start_time}`;
                        if (usedEncounterIds.has(nextId)) break;
                        
                        addsGroupIndices.push(j);
                    }
                    addsGroupSize = addsGroupIndices.length;
                }
                
                // Check if this add is part of a previous group (don't show group button again)
                let isPartOfPreviousGroup = false;
                if ((enc.category === 'adds' || enc.category === 'other') && idx > 0) {
                    const prevEnc = timelineEncounters[idx - 1];
                    if (prevEnc.category === 'adds' || prevEnc.category === 'other') {
                        const prevEnd = new Date(prevEnc.end_time);
                        const currStart = new Date(enc.start_time);
                        const gap = (currStart - prevEnd) / 1000;
                        if (gap <= 30) {
                            isPartOfPreviousGroup = true;
                        }
                    }
                }
                
                if (isBoss) {
                    // BOSS: Full-size card with all stats
                    const mergedStyles = isMerged && !isUsed ? `
                        border-color: #fbbf24 !important;
                        background: linear-gradient(135deg, rgba(251, 191, 36, 0.12) 0%, rgba(15, 23, 42, 0.9) 100%) !important;
                    ` : '';
                    
                    const attemptStyles = isAttempt && !isUsed ? `
                        border-color: #ef4444 !important;
                        background: linear-gradient(135deg, rgba(239, 68, 68, 0.12) 0%, rgba(15, 23, 42, 0.9) 100%) !important;
                    ` : '';
                    
                    html += `
                        <div class="timeline-encounter-compact ${isMerged ? 'merged-encounter' : ''} ${isAttempt ? 'attempt-encounter' : ''}" ${!isUsed ? `draggable="true" ondragstart="dragTimelineEncounter(event, ${idx})"` : ''} 
                             onclick="${!isUsed ? `toggleTimelineSelection(${idx}, event)` : ''}"
                             style="position: relative; margin-bottom: 16px; ${usedStyles}">
                            <!-- Timeline dot -->
                            <div style="position: absolute; left: -17px; top: 8px; width: 10px; height: 10px; background: ${isUsed ? '#334155' : (isMerged ? '#fbbf24' : (isAttempt ? '#ef4444' : color))}; border: 2px solid #0f172a; border-radius: 50%; ${!isUsed ? `box-shadow: 0 0 0 3px rgba(${rgb}, 0.3);` : ''} z-index: 10;"></div>
                            
                            <!-- Full card -->
                            <div style="${cardUsedStyles} ${selectedStyles} ${mergedStyles} ${attemptStyles} border-left: 3px solid ${borderColor}; border-radius: 6px; padding: 8px; transition: all 0.2s; position: relative;">
                                ${isUsed ? '<div style="position: absolute; top: 4px; right: 6px; font-size: 0.6rem; color: #D96444; font-weight: 600;">✓ IN RUN</div>' : 
                                  `<div onclick="event.stopPropagation(); toggleTimelineSelection(${idx}, event)" style="position: absolute; top: 6px; right: 6px; width: 18px; height: 18px; background: ${isSelected ? '#D96444' : 'rgba(30, 41, 59, 0.8)'}; border: 2px solid ${isSelected ? '#D96444' : '#475569'}; border-radius: 4px; cursor: pointer; display: flex; align-items: center; justify-content: center; transition: all 0.2s;">
                                      ${isSelected ? '<span style="color: #0f172a; font-size: 0.7rem; font-weight: 700;">✓</span>' : ''}
                                  </div>`}
                                <div style="display: flex; align-items: center; gap: 6px; margin-bottom: 4px; ${!isUsed ? 'padding-right: 24px;' : ''}">
                                    <span style="font-size: 1rem; ${isUsed ? 'opacity: 0.5;' : ''}">${categoryIcon}</span>
                                    <div style="flex: 1;">
                                        <div style="font-weight: 600; font-size: 0.8rem; line-height: 1.2; ${nameStyles}">
                                            ${enc.target_name}
                                            ${isMerged ? '<span style="margin-left: 4px; font-size: 0.6rem; color: #fbbf24;">🔗</span>' : ''}
                                            ${isAttempt ? '<span class="attempt-badge" style="margin-left: 4px;">ATTEMPT</span>' : ''}
                                        </div>
                                        <div style="font-size: 0.65rem; color: ${isUsed ? '#475569' : color}; font-weight: 600; opacity: 0.8;">${categoryLabel}</div>
                                    </div>
                                </div>
                                <div style="display: flex; justify-content: space-between; font-size: 0.65rem; color: ${isUsed ? '#475569' : '#94a3b8'}; margin-bottom: 3px;">
                                    <span>⏱️ ${startTime}</span>
                                    <span style="color: ${isUsed ? '#475569' : '#e2e8f0'}; font-weight: 600;">${durationLabel}</span>
                                </div>
                                <div style="display: flex; justify-content: space-between; align-items: center;">
                                    <div style="font-size: 0.7rem; color: ${isUsed ? '#475569' : color}; font-weight: 600;">
                                        💥 ${(enc.dps / 1000).toFixed(1)}K DPS
                                    </div>
                                    ${!isUsed ? `
                                        <button class="attempt-toggle ${isAttempt ? 'active' : ''}" onclick="event.stopPropagation(); toggleAttemptFlag(${idx})">
                                            ${isAttempt ? '✓ Attempt' : '⚑ Mark Attempt'}
                                        </button>
                                    ` : ''}
                                </div>
                                ${!isUsed && isMerged ? `
                                    <button onclick="event.stopPropagation(); unmergeTimelineEncounter(${idx})" style="margin-top: 6px; width: 100%; padding: 4px; font-size: 0.6rem; background: rgba(251, 191, 36, 0.1); border: 1px solid rgba(251, 191, 36, 0.3); color: #fbbf24; border-radius: 3px; cursor: pointer;">
                                        ↔️ Unmerge
                                    </button>
                                ` : ''}
                            </div>
                        </div>
                    `;
                } else {
                    // ADDS/OTHER: Compact single-line format
                    
                    // Show group select button if this is start of a group with 2+ adds
                    const showGroupButton = addsGroupSize >= 2 && !isPartOfPreviousGroup;
                    
                    html += `
                        <div class="timeline-encounter-compact" ${!isUsed ? `draggable="true" ondragstart="dragTimelineEncounter(event, ${idx})"` : ''} 
                             onclick="${!isUsed ? `toggleTimelineSelection(${idx}, event)` : ''}"
                             style="position: relative; margin-bottom: 4px; ${usedStyles}">
                            <!-- Timeline dot -->
                            <div style="position: absolute; left: -17px; top: 50%; transform: translateY(-50%); width: 6px; height: 6px; background: ${isUsed ? '#334155' : color}; border: 1.5px solid #0f172a; border-radius: 50%; z-index: 10;"></div>
                            
                            <!-- Compact single-line card -->
                            <div style="background: ${isUsed ? 'rgba(30, 41, 59, 0.3)' : 'rgba(30, 41, 59, 0.6)'}; ${isSelected && !isUsed ? 'box-shadow: 0 0 0 1px #D96444;' : ''} border-left: 2px solid ${isUsed ? '#334155' : (isSelected ? '#D96444' : color)}; border-radius: 3px; padding: 4px 6px; display: flex; align-items: center; gap: 5px; transition: all 0.15s;">
                                <!-- Checkbox -->
                                ${isUsed ? '' : `
                                    <div onclick="event.stopPropagation(); toggleTimelineSelection(${idx}, event)" style="width: 12px; height: 12px; min-width: 12px; background: ${isSelected ? '#D96444' : 'transparent'}; border: 1.5px solid ${isSelected ? '#D96444' : '#475569'}; border-radius: 2px; cursor: pointer; display: flex; align-items: center; justify-content: center;">
                                        ${isSelected ? '<span style="color: #0f172a; font-size: 0.5rem; font-weight: 700;">✓</span>' : ''}
                                    </div>
                                `}
                                
                                <!-- Icon -->
                                <span style="font-size: 0.7rem; ${isUsed ? 'opacity: 0.4;' : ''}">${categoryIcon}</span>
                                
                                <!-- Target name (truncated) -->
                                <span style="flex: 1; min-width: 0; font-weight: 500; font-size: 0.7rem; color: ${isUsed ? '#64748b' : '#cbd5e1'}; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; ${isUsed ? 'text-decoration: line-through;' : ''}">${enc.target_name}</span>
                                
                                <!-- Time only -->
                                <span style="font-size: 0.6rem; color: ${isUsed ? '#475569' : '#64748b'}; white-space: nowrap;">${startTime}</span>
                                
                                ${isUsed ? '<span style="font-size: 0.5rem; color: #D96444;">✓</span>' : ''}
                                
                                <!-- Group select button -->
                                ${showGroupButton ? `
                                    <button onclick="event.stopPropagation(); selectAddsGroup([${addsGroupIndices.join(',')}])" style="padding: 2px 5px; font-size: 0.55rem; background: rgba(239, 68, 68, 0.15); border: 1px solid rgba(239, 68, 68, 0.3); color: #ef4444; border-radius: 3px; cursor: pointer; white-space: nowrap;" title="Select all ${addsGroupSize} consecutive adds">+${addsGroupSize}</button>
                                ` : ''}
                            </div>
                        </div>
                    `;
                }
            });
            
            // End time marker
            html += `<div style="margin-top: 12px; padding-left: 8px; color: #64748b; font-size: 0.75rem; font-weight: 600;">■ END: ${lastTime.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}</div>`;
            
            html += '</div>';
            
            container.innerHTML = html;
            
            // Show selection bar when there are encounters
            const selectionBar = document.getElementById('timelineSelectionBar');
            if (selectionBar) {
                selectionBar.style.display = timelineEncounters.length > 0 ? 'block' : 'none';
            }
            updateSelectionCount();
        }
        
        // === MULTI-SELECT FUNCTIONS ===
        function toggleTimelineSelection(idx, event) {
            // Prevent drag from triggering
            if (event) event.stopPropagation();
            
            // Check if this encounter is already in run
            const enc = timelineEncounters[idx];
            const encounterId = `${enc.target_name}|${enc.start_time}`;
            const isUsed = runEncounters.some(e => `${e.target_name}|${e.start_time}` === encounterId);
            if (isUsed) return;
            
            if (selectedTimelineIndices.has(idx)) {
                selectedTimelineIndices.delete(idx);
            } else {
                selectedTimelineIndices.add(idx);
            }
            
            // Re-render to show selection state
            displayEncounterTimeline(timelineEncounters);
        }
        
        function selectAllTimelineEncounters() {
            // Select all encounters that aren't already in the run
            const usedIds = new Set(runEncounters.map(e => `${e.target_name}|${e.start_time}`));
            
            timelineEncounters.forEach((enc, idx) => {
                // Skip adds if toggle is off
                if (!showAddsInTimeline && (enc.category === 'adds' || enc.category === 'other')) {
                    return;
                }
                
                const encId = `${enc.target_name}|${enc.start_time}`;
                if (!usedIds.has(encId)) {
                    selectedTimelineIndices.add(idx);
                }
            });
            
            displayEncounterTimeline(timelineEncounters);
        }
        
        function clearTimelineSelection() {
            selectedTimelineIndices.clear();
            displayEncounterTimeline(timelineEncounters);
        }
        
        function toggleShowAdds() {
            showAddsInTimeline = document.getElementById('showAddsToggle').checked;
            // Clear any selected adds when hiding
            if (!showAddsInTimeline) {
                timelineEncounters.forEach((enc, idx) => {
                    if (enc.category === 'adds' || enc.category === 'other') {
                        selectedTimelineIndices.delete(idx);
                    }
                });
            }
            displayEncounterTimeline(timelineEncounters);
        }
        
        function selectAddsGroup(indices) {
            // Check if all in group are already selected
            const usedIds = new Set(runEncounters.map(e => `${e.target_name}|${e.start_time}`));
            const selectableIndices = indices.filter(idx => {
                const enc = timelineEncounters[idx];
                if (!enc) return false;
                const encId = `${enc.target_name}|${enc.start_time}`;
                return !usedIds.has(encId);
            });
            
            const allSelected = selectableIndices.every(idx => selectedTimelineIndices.has(idx));
            
            if (allSelected) {
                // Unselect all in group
                selectableIndices.forEach(idx => {
                    selectedTimelineIndices.delete(idx);
                });
            } else {
                // Select all in group
                selectableIndices.forEach(idx => {
                    selectedTimelineIndices.add(idx);
                });
            }
            
            displayEncounterTimeline(timelineEncounters);
        }
        
        function updateSelectionCount() {
            const countEl = document.getElementById('selectionCount');
            if (countEl) {
                const count = selectedTimelineIndices.size;
                countEl.textContent = `${count} selected`;
            }
        }
        
        function addSelectedToRun() {
            if (selectedTimelineIndices.size === 0) {
                alert('No encounters selected. Click on encounter cards to select them.');
                return;
            }
            
            // Get selected encounters that aren't already in run
            const usedIds = new Set(runEncounters.map(e => `${e.target_name}|${e.start_time}`));
            let addedCount = 0;
            
            Array.from(selectedTimelineIndices).sort((a, b) => a - b).forEach(idx => {
                const enc = timelineEncounters[idx];
                const encId = `${enc.target_name}|${enc.start_time}`;
                if (!usedIds.has(encId)) {
                    runEncounters.push(enc);
                    usedIds.add(encId);
                    addedCount++;
                }
            });
            
            if (addedCount > 0) {
                // Sort by start time
                runEncounters.sort((a, b) => new Date(a.start_time) - new Date(b.start_time));
                updateRunDisplay();
                calculateRunStats();
            }
            
            // Clear selection
            selectedTimelineIndices.clear();
            displayEncounterTimeline(timelineEncounters);
        }
        
        function dragTimelineEncounter(event, index) {
            // If the dragged item is selected and there are multiple selections, drag all selected
            let indicesToDrag;
            if (selectedTimelineIndices.has(index) && selectedTimelineIndices.size > 1) {
                indicesToDrag = Array.from(selectedTimelineIndices).sort((a, b) => a - b);
            } else {
                indicesToDrag = [index];
            }
            
            event.dataTransfer.setData('text/plain', indicesToDrag.join(','));
            event.dataTransfer.effectAllowed = 'copy';
            console.log('[RunBuilder] Dragging encounter indices:', indicesToDrag);
        }
        
        function allowRunDrop(event) {
            console.log('[RunBuilder] allowRunDrop fired on:', event.currentTarget.id);
            event.preventDefault();
            event.dataTransfer.dropEffect = 'copy';
            event.currentTarget.classList.add('drag-over');
        }
        
        function dragLeaveCanvas(event) {
            if (event.currentTarget === event.target || !event.currentTarget.contains(event.relatedTarget)) {
                event.currentTarget.classList.remove('drag-over');
            }
        }
        
        function dropRunCanvas(event) {
            console.log('[RunBuilder] dropRunCanvas fired on:', event.currentTarget.id);
            event.preventDefault();
            event.stopPropagation();
            event.currentTarget.classList.remove('drag-over');
            
            const indexStr = event.dataTransfer.getData('text/plain');
            if (!indexStr) return;
            
            // Handle multiple indices (comma-separated)
            const indices = indexStr.split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n));
            
            let addedCount = 0;
            const usedIds = new Set(runEncounters.map(e => `${e.target_name}|${e.start_time}`));
            
            indices.forEach(idx => {
                const encounter = timelineEncounters[idx];
                if (!encounter) return;
                
                // Check if already in run (prevent duplicates)
                const encounterId = `${encounter.target_name}|${encounter.start_time}`;
                if (usedIds.has(encounterId)) {
                    console.log('[RunBuilder] Encounter already in run, skipping:', encounter.target_name);
                    return;
                }
                
                runEncounters.push(encounter);
                usedIds.add(encounterId);
                addedCount++;
            });
            
            if (addedCount > 0) {
                // Auto-sort by start time
                runEncounters.sort((a, b) => new Date(a.start_time) - new Date(b.start_time));
                
                updateRunDisplay();
                calculateRunStats();
                
                console.log(`[RunBuilder] Added ${addedCount} encounter(s) to run`);
            }
            
            // Clear selection after drag
            selectedTimelineIndices.clear();
            
            // Refresh timeline to show "used" indicator
            displayEncounterTimeline(timelineEncounters);
        }
        
        // Track which adds groups are expanded
        let expandedAddsGroups = new Set();
        
        function updateRunDisplay() {
            const placeholder = document.getElementById('runPlaceholder');
            const container = document.getElementById('runEncountersList');
            
            if (runEncounters.length === 0) {
                placeholder.style.display = 'block';
                container.innerHTML = '';
                return;
            }
            
            placeholder.style.display = 'none';
            
            // Category colors
            const categoryColors = {
                'archboss': '#fbbf24',
                'raid_boss': '#ec4899',
                'field_boss': '#5B92D4',
                'dungeon_boss': '#3b82f6',
                'adds': '#ef4444',
                'other': '#64748b'
            };
            
            // Boss categories (shown on left, full size)
            const bossCategories = new Set(['archboss', 'raid_boss', 'field_boss', 'dungeon_boss']);
            
            // Sort by time (should already be sorted, but ensure)
            const sortedEncounters = [...runEncounters].sort((a, b) => new Date(a.start_time) - new Date(b.start_time));
            
            // Group consecutive adds together
            const groupedItems = [];
            let currentAddsGroup = null;
            
            sortedEncounters.forEach((enc, idx) => {
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
                    // If we were building an adds group, push it first
                    if (currentAddsGroup) {
                        groupedItems.push(currentAddsGroup);
                        currentAddsGroup = null;
                    }
                    groupedItems.push({ type: 'single', enc, originalIdx: idx });
                }
            });
            
            // Don't forget the last adds group if there is one
            if (currentAddsGroup) {
                groupedItems.push(currentAddsGroup);
            }
            
            // Build timeline HTML
            let html = `
                <div style="position: relative; min-height: 200px;">
                    <!-- Center timeline line -->
                    <div style="position: absolute; left: 50%; top: 20px; bottom: 20px; width: 4px; transform: translateX(-50%); background: linear-gradient(to bottom, #fbbf24, #ec4899, #5B92D4, #3b82f6); border-radius: 2px; box-shadow: 0 0 15px rgba(168, 85, 247, 0.4);"></div>
            `;
            
            let groupCounter = 0;
            
            groupedItems.forEach((item) => {
                if (item.type === 'adds_group') {
                    // Render collapsed adds group
                    const groupId = `adds_group_${groupCounter}`;
                    const isExpanded = expandedAddsGroups.has(groupId);
                    const addsCount = item.encounters.length;
                    const totalDamage = item.encounters.reduce((sum, e) => sum + e.enc.total_damage, 0);
                    const totalDuration = item.encounters.reduce((sum, e) => sum + (e.enc.duration || 0), 0);
                    const color = categoryColors['adds'];
                    const rgb = '239, 68, 68';
                    
                    html += `
                        <div class="run-timeline-item adds-group" style="display: flex; align-items: flex-start; margin-bottom: 16px; position: relative;">
                            <!-- Left: Empty space -->
                            <div style="width: calc(50% - 30px); padding-right: 20px;"></div>
                            
                            <!-- Center: Timeline dot -->
                            <div style="position: absolute; left: 50%; top: 12px; transform: translateX(-50%); width: 14px; height: 14px; background: ${color}; border: 2px solid #0f172a; border-radius: 50%; box-shadow: 0 0 0 3px rgba(${rgb}, 0.3); z-index: 10;"></div>
                            
                            <!-- Right: Adds Group Card -->
                            <div style="width: calc(50% - 30px); padding-left: 20px;">
                                <div style="background: linear-gradient(135deg, rgba(30, 41, 59, 0.95) 0%, rgba(15, 23, 42, 0.95) 100%); border: 1px solid ${color}; border-left: 4px solid ${color}; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 15px rgba(0, 0, 0, 0.3);">
                                    <!-- Header (clickable to expand/collapse) -->
                                    <div onclick="toggleAddsGroup('${groupId}')" style="padding: 10px 12px; cursor: pointer; display: flex; justify-content: space-between; align-items: center; background: rgba(239, 68, 68, 0.1); transition: background 0.2s;" onmouseover="this.style.background='rgba(239, 68, 68, 0.2)'" onmouseout="this.style.background='rgba(239, 68, 68, 0.1)'">
                                        <div style="display: flex; align-items: center; gap: 8px;">
                                            <span style="font-size: 1.1rem; transition: transform 0.2s; transform: rotate(${isExpanded ? '90deg' : '0deg'});">▶</span>
                                            <span style="font-size: 1rem;">💀</span>
                                            <div>
                                                <div style="font-weight: 700; color: #e2e8f0; font-size: 0.9rem;">Adds <span style="color: ${color}; font-weight: 400;">(${addsCount})</span></div>
                                                <div style="font-size: 0.65rem; color: #94a3b8;">${Math.round(totalDuration)}s total</div>
                                            </div>
                                        </div>
                                        <div style="text-align: right;">
                                            <div style="color: ${color}; font-size: 1.1rem; font-weight: 700;">${(totalDamage / 1000000).toFixed(2)}M</div>
                                            <div style="color: #64748b; font-size: 0.6rem; text-transform: uppercase;">Total Damage</div>
                                        </div>
                                    </div>
                                    
                                    <!-- Expanded content -->
                                    <div id="${groupId}" style="display: ${isExpanded ? 'block' : 'none'}; border-top: 1px solid rgba(239, 68, 68, 0.3);">
                    `;
                    
                    // Render each add in the group
                    item.encounters.forEach(({ enc, originalIdx }) => {
                        const startTime = new Date(enc.start_time).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
                        html += `
                                        <div style="padding: 8px 12px; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid rgba(51, 65, 85, 0.5); background: rgba(15, 23, 42, 0.4);">
                                            <div style="display: flex; align-items: center; gap: 8px;">
                                                <span style="color: #475569; font-size: 0.75rem;">└</span>
                                                <span style="font-size: 0.85rem;">💀</span>
                                                <div>
                                                    <div style="font-weight: 600; color: #e2e8f0; font-size: 0.8rem;">${enc.target_name}</div>
                                                    <div style="font-size: 0.6rem; color: #64748b;">⏱️ ${startTime}</div>
                                                </div>
                                            </div>
                                            <div style="display: flex; align-items: center; gap: 8px;">
                                                <div style="text-align: right;">
                                                    <div style="color: ${color}; font-size: 0.85rem; font-weight: 600;">${(enc.total_damage / 1000000).toFixed(2)}M</div>
                                                </div>
                                                <button onclick="event.stopPropagation(); removeFromRun(${originalIdx})" style="padding: 3px 6px; background: rgba(239, 68, 68, 0.7); color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 0.6rem;">✕</button>
                                            </div>
                                        </div>
                        `;
                    });
                    
                    html += `
                                    </div>
                                </div>
                            </div>
                        </div>
                    `;
                    
                    groupCounter++;
                } else {
                    // Render single encounter (boss, other)
                    const enc = item.enc;
                    const idx = item.originalIdx;
                    const color = categoryColors[enc.category] || '#64748b';
                    const isBoss = bossCategories.has(enc.category);
                    const categoryIcon = getCategoryIcon(enc.category);
                    const startTime = new Date(enc.start_time).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
                    const durationLabel = enc.duration < 60 ? `${Math.round(enc.duration)}s` : `${Math.floor(enc.duration / 60)}m ${Math.round(enc.duration % 60)}s`;
                    
                    // RGB for glow effects
                    const rgbMap = {
                        '#fbbf24': '251, 191, 36',
                        '#ec4899': '236, 72, 153',
                        '#5B92D4': '168, 85, 247',
                        '#3b82f6': '59, 130, 246',
                        '#ef4444': '239, 68, 68',
                        '#64748b': '100, 116, 139'
                    };
                    const rgb = rgbMap[color] || '100, 116, 139';
                    
                    if (isBoss) {
                        // Check for merged/attempt flags
                        const isMerged = enc.merged === true;
                        const isAttempt = enc.is_attempt === true;
                        
                        // Modify colors for attempt/merged
                        const cardColor = isAttempt ? '#ef4444' : (isMerged ? '#fbbf24' : color);
                        const cardRgb = isAttempt ? '239, 68, 68' : (isMerged ? '251, 191, 36' : rgb);
                        
                        // Get current run loot data for display
                        const runLootData = getCurrentRunLootData();
                        
                        // BOSS CARD - Left side, large, full stats
                        html += `
                            <div class="run-timeline-item" style="display: flex; align-items: flex-start; margin-bottom: 24px; position: relative;">
                                <!-- Left: Boss Card -->
                                <div style="width: calc(50% - 30px); padding-right: 20px;">
                                    <div style="background: linear-gradient(135deg, rgba(30, 41, 59, 0.95) 0%, rgba(15, 23, 42, 0.95) 100%); border: 2px solid ${cardColor}; border-radius: 12px; padding: 16px; box-shadow: 0 4px 25px rgba(0, 0, 0, 0.4), 0 0 30px rgba(${cardRgb}, 0.15); position: relative;">
                                        <!-- Remove button -->
                                        <button onclick="removeFromRun(${idx})" style="position: absolute; top: 8px; right: 8px; padding: 4px 8px; background: rgba(239, 68, 68, 0.8); color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 0.65rem; font-weight: 700;">✕</button>
                                        
                                        <!-- Header with icon and name -->
                                        <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 12px;">
                                            <span style="font-size: 2rem; filter: drop-shadow(0 2px 4px rgba(0,0,0,0.4));">${categoryIcon}</span>
                                            <div>
                                                <div style="font-weight: 700; color: #e2e8f0; font-size: 1.1rem; text-shadow: 0 1px 3px rgba(0,0,0,0.5);">
                                                    ${enc.target_name}
                                                    ${isMerged ? '<span style="margin-left: 6px; font-size: 0.7rem; color: #fbbf24;">🔗 Merged</span>' : ''}
                                                    ${isAttempt ? '<span class="attempt-badge" style="margin-left: 6px;">ATTEMPT</span>' : ''}
                                                </div>
                                                <div style="font-size: 0.7rem; color: ${color}; font-weight: 600; text-transform: uppercase; letter-spacing: 1px;">${enc.category.replace('_', ' ')}</div>
                                            </div>
                                        </div>
                                        
                                        <!-- Stats -->
                                        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 12px;">
                                            <div style="background: rgba(0,0,0,0.2); border-radius: 8px; padding: 10px; text-align: center;">
                                                <div style="color: ${cardColor}; font-size: 1.4rem; font-weight: 700; text-shadow: 0 0 15px rgba(${cardRgb}, 0.6);">${Math.round(enc.dps).toLocaleString()}</div>
                                                <div style="color: #64748b; font-size: 0.65rem; text-transform: uppercase; letter-spacing: 0.5px;">DPS</div>
                                            </div>
                                            <div style="background: rgba(0,0,0,0.2); border-radius: 8px; padding: 10px; text-align: center;">
                                                <div style="color: #e2e8f0; font-size: 1.4rem; font-weight: 700;">${(enc.total_damage / 1000000).toFixed(2)}M</div>
                                                <div style="color: #64748b; font-size: 0.65rem; text-transform: uppercase; letter-spacing: 0.5px;">Damage</div>
                                            </div>
                                        </div>
                                        
                                        <!-- Duration bar -->
                                        <div style="background: rgba(${cardRgb}, 0.1); border: 1px solid rgba(${cardRgb}, 0.3); border-radius: 6px; padding: 8px 12px; display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
                                            <span style="color: #94a3b8; font-size: 0.75rem;">⏱️ ${startTime}</span>
                                            <span style="color: ${cardColor}; font-size: 0.85rem; font-weight: 600;">⏳ ${durationLabel}</span>
                                        </div>
                                        
                                        <!-- Attempt toggle -->
                                        <button class="attempt-toggle ${isAttempt ? 'active' : ''}" onclick="toggleRunAttemptFlag(${idx})" style="width: 100%; padding: 6px;">
                                            ${isAttempt ? '✓ Marked as Attempt (wipe/reset)' : '⚑ Mark as Attempt'}
                                        </button>
                                        
                                        <!-- Loot/Contribution Section (for boss encounters) -->
                                        <div style="margin-top: 10px; padding-top: 10px; border-top: 1px dashed rgba(${cardRgb}, 0.3);">
                                            <div style="font-size: 0.65rem; color: #fbbf24; text-transform: uppercase; margin-bottom: 6px; display: flex; align-items: center; gap: 4px;">
                                                🎁 Loot Tracking <span style="color: #64748b; font-weight: 400;">(optional)</span>
                                            </div>
                                            ${(enc.category === 'archboss' || enc.category === 'field_boss') ? `
                                            <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
                                                <span style="font-size: 0.7rem; color: #94a3b8;">📊</span>
                                                <input type="number" id="runCardContribution_${idx}" min="0" max="100" step="0.1" placeholder="Contrib %" 
                                                       value="${runLootData.contribution_percent != null ? runLootData.contribution_percent : ''}"
                                                       onchange="updateRunLootFromCard('contribution', this.value)"
                                                       style="flex: 1; padding: 6px 8px; background: rgba(0,0,0,0.3); border: 1px solid #334155; border-radius: 4px; color: #e2e8f0; font-size: 0.75rem; max-width: 80px;">
                                                <span style="font-size: 0.7rem; color: #64748b;">%</span>
                                            </div>
                                            ` : ''}
                                            <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
                                                <label style="display: flex; align-items: center; gap: 4px; cursor: pointer; font-size: 0.7rem; color: #94a3b8;">
                                                    <input type="radio" name="runCardLoot_${idx}" value="no" ${!runLootData.got_loot ? 'checked' : ''} onchange="updateRunLootFromCard('got_loot', false)" style="accent-color: #64748b;">
                                                    No
                                                </label>
                                                <label style="display: flex; align-items: center; gap: 4px; cursor: pointer; font-size: 0.7rem; color: #22c55e;">
                                                    <input type="radio" name="runCardLoot_${idx}" value="yes" ${runLootData.got_loot ? 'checked' : ''} onchange="updateRunLootFromCard('got_loot', true)" style="accent-color: #22c55e;">
                                                    🎁 Yes
                                                </label>
                                                <input type="text" id="runCardLootItem_${idx}" placeholder="Item name" 
                                                       value="${escapeHtml(runLootData.loot_item || '')}"
                                                       onchange="updateRunLootFromCard('loot_item', this.value)"
                                                       style="flex: 1; min-width: 100px; padding: 6px 8px; background: rgba(0,0,0,0.3); border: 1px solid #334155; border-radius: 4px; color: #e2e8f0; font-size: 0.75rem; ${runLootData.got_loot ? '' : 'opacity: 0.5;'}">
                                            </div>
                                        </div>
                                    </div>
                                </div>
                                
                                <!-- Center: Timeline dot -->
                                <div style="position: absolute; left: 50%; top: 20px; transform: translateX(-50%); width: 20px; height: 20px; background: ${cardColor}; border: 3px solid #0f172a; border-radius: 50%; box-shadow: 0 0 0 4px rgba(${cardRgb}, 0.3), 0 0 20px rgba(${cardRgb}, 0.6); z-index: 10;"></div>
                                
                                <!-- Right: Empty space for bosses -->
                                <div style="width: calc(50% - 30px); padding-left: 20px;"></div>
                            </div>
                        `;
                    } else {
                        // OTHER - Right side, single line, minimal
                        html += `
                            <div class="run-timeline-item" style="display: flex; align-items: flex-start; margin-bottom: 8px; position: relative;">
                                <!-- Left: Empty space -->
                                <div style="width: calc(50% - 30px); padding-right: 20px;"></div>
                                
                                <!-- Center: Timeline dot (tiny) -->
                                <div style="position: absolute; left: 50%; top: 8px; transform: translateX(-50%); width: 8px; height: 8px; background: ${color}; border: 2px solid #0f172a; border-radius: 50%; z-index: 10;"></div>
                                
                                <!-- Right: Single line -->
                                <div style="width: calc(50% - 30px); padding-left: 20px;">
                                    <div style="background: rgba(30, 41, 59, 0.6); border-left: 2px solid ${color}; border-radius: 4px; padding: 6px 10px; display: flex; justify-content: space-between; align-items: center;">
                                        <div style="display: flex; align-items: center; gap: 6px;">
                                            <span style="font-size: 0.8rem;">${categoryIcon}</span>
                                            <span style="color: #94a3b8; font-size: 0.75rem;">${enc.target_name}</span>
                                            <span style="color: #64748b; font-size: 0.65rem;">⏱️ ${startTime}</span>
                                        </div>
                                        <div style="display: flex; align-items: center; gap: 8px;">
                                            <span style="color: ${color}; font-size: 0.8rem; font-weight: 600;">${(enc.total_damage / 1000).toFixed(0)}K</span>
                                            <button onclick="removeFromRun(${idx})" style="padding: 2px 5px; background: rgba(239, 68, 68, 0.6); color: white; border: none; border-radius: 3px; cursor: pointer; font-size: 0.55rem;">✕</button>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        `;
                    }
                }
            });
            
            html += '</div>';
            container.innerHTML = html;
        }
        
        function toggleAddsGroup(groupId) {
            if (expandedAddsGroups.has(groupId)) {
                expandedAddsGroups.delete(groupId);
            } else {
                expandedAddsGroups.add(groupId);
            }
            updateRunDisplay();
        }
        
        let draggedRunIndex = null;
        
        function dragRunEncounter(event, index) {
            draggedRunIndex = index;
            event.dataTransfer.effectAllowed = 'move';
            event.target.style.opacity = '0.4';
        }
        
        function dropRunEncounter(event, targetIndex) {
            event.preventDefault();
            event.stopPropagation();
            
            if (draggedRunIndex === null || draggedRunIndex === targetIndex) return;
            
            // Reorder
            const [moved] = runEncounters.splice(draggedRunIndex, 1);
            runEncounters.splice(targetIndex, 0, moved);
            
            draggedRunIndex = null;
            updateRunDisplay();
            calculateRunStats();
        }
        
        function removeFromRun(index) {
            runEncounters.splice(index, 1);
            updateRunDisplay();
            calculateRunStats();
            // Refresh timeline to update "used" indicators
            if (timelineEncounters.length > 0) {
                displayEncounterTimeline(timelineEncounters);
            }
        }
        
        function mergeTimelineEncounters(idx1, idx2) {
            const enc1 = timelineEncounters[idx1];
            const enc2 = timelineEncounters[idx2];
            
            if (!enc1 || !enc2) {
                console.error('[RunBuilder] Invalid merge indices');
                return;
            }
            
            // Determine which is earlier
            const start1 = new Date(enc1.start_time);
            const start2 = new Date(enc2.start_time);
            const earlierEnc = start1 < start2 ? enc1 : enc2;
            const laterEnc = start1 < start2 ? enc2 : enc1;
            const earlierIdx = start1 < start2 ? idx1 : idx2;
            const laterIdx = start1 < start2 ? idx2 : idx1;
            
            // Calculate gap
            const earlierEnd = new Date(earlierEnc.end_time || earlierEnc.start_time);
            const laterStart = new Date(laterEnc.start_time);
            const gapSeconds = Math.round((laterStart - earlierEnd) / 1000);
            
            // Confirm
            const confirmMsg = `Merge these encounters?\n\n` +
                `• ${earlierEnc.target_name} (${formatDuration(earlierEnc.duration)})\n` +
                `  ↓ ${gapSeconds}s gap\n` +
                `• ${laterEnc.target_name} (${formatDuration(laterEnc.duration)})\n\n` +
                `This will combine them into a single encounter.`;
            
            if (!confirm(confirmMsg)) return;
            
            // Create merged encounter
            const mergedDuration = (new Date(laterEnc.end_time) - new Date(earlierEnc.start_time)) / 1000;
            const mergedDamage = (earlierEnc.total_damage || 0) + (laterEnc.total_damage || 0);
            const mergedHits = (earlierEnc.hit_count || 0) + (laterEnc.hit_count || 0);
            
            const mergedEnc = {
                target_name: earlierEnc.target_name,
                category: earlierEnc.category,
                start_time: earlierEnc.start_time,
                end_time: laterEnc.end_time,
                duration: mergedDuration,
                total_damage: mergedDamage,
                dps: mergedDuration > 0 ? mergedDamage / mergedDuration : 0,
                hit_count: mergedHits,
                merged: true,
                merged_from: [earlierEnc.start_time, laterEnc.start_time],
                is_attempt: false
            };
            
            // Replace in timeline (remove later, replace earlier with merged)
            timelineEncounters.splice(laterIdx, 1);
            timelineEncounters[earlierIdx] = mergedEnc;
            
            // Re-sort and re-render
            timelineEncounters.sort((a, b) => new Date(a.start_time) - new Date(b.start_time));
            displayEncounterTimeline(timelineEncounters);
            
            console.log('[RunBuilder] Merged encounters:', mergedEnc.target_name, mergedDuration.toFixed(1) + 's');
        }
        
        function unmergeTimelineEncounter(idx) {
            const enc = timelineEncounters[idx];
            if (!enc || !enc.merged || !enc.merged_from || enc.merged_from.length < 2) {
                console.error('[RunBuilder] Cannot unmerge - not a merged encounter');
                return;
            }
            
            if (!confirm('Unmerge this encounter back into separate entries?')) return;
            
            // Request original encounters from server
            sendCommand('get_session_encounters');
            
            // For now, just remove merged flag and let user re-add
            // The session will refresh with original encounters
            alert('Encounter unmerged. The timeline will refresh with original encounters.');
        }
        
        function toggleAttemptFlag(idx) {
            const enc = timelineEncounters[idx];
            if (!enc) return;
            
            enc.is_attempt = !enc.is_attempt;
            displayEncounterTimeline(timelineEncounters);
            
            console.log('[RunBuilder] Attempt flag:', enc.target_name, enc.is_attempt);
        }
        
        function toggleRunAttemptFlag(idx) {
            const enc = runEncounters[idx];
            if (!enc) return;
            
            enc.is_attempt = !enc.is_attempt;
            updateRunDisplay();
            calculateRunStats();
            
            console.log('[RunBuilder] Run attempt flag:', enc.target_name, enc.is_attempt);
        }
        
        // Get current run loot data from form fields
        function getCurrentRunLootData() {
            const contributionInput = document.getElementById('runContribution');
            const contributionValue = contributionInput ? parseFloat(contributionInput.value) : null;
            const contributionPercent = (!isNaN(contributionValue) && contributionValue >= 0 && contributionValue <= 100) ? contributionValue : null;
            
            const gotLoot = document.querySelector('input[name="runGotLoot"]:checked')?.value === 'yes';
            const lootItem = document.getElementById('runLootItem')?.value.trim() || null;
            
            return {
                contribution_percent: contributionPercent,
                got_loot: gotLoot,
                loot_item: gotLoot ? lootItem : null
            };
        }
        
        // Update run loot data from boss card inline fields
        function updateRunLootFromCard(field, value) {
            if (field === 'contribution') {
                const input = document.getElementById('runContribution');
                if (input) {
                    input.value = value;
                }
            } else if (field === 'got_loot') {
                const radio = document.querySelector(`input[name="runGotLoot"][value="${value ? 'yes' : 'no'}"]`);
                if (radio) {
                    radio.checked = true;
                }
                // Also trigger the loot change handler to show/hide item input
                onLootChange();
                // Update item input opacity on all boss cards
                updateRunDisplay();
            } else if (field === 'loot_item') {
                const input = document.getElementById('runLootItem');
                if (input) {
                    input.value = value;
                }
                // Also set got_loot to true if item name is entered
                if (value && value.trim()) {
                    const radio = document.querySelector('input[name="runGotLoot"][value="yes"]');
                    if (radio) {
                        radio.checked = true;
                        onLootChange();
                    }
                }
            }
        }
        
        function clearRun() {
            if (runEncounters.length > 0 && !confirm('Clear this run? This cannot be undone.')) {
                return;
            }
            runEncounters = [];
            updateRunDisplay();
            calculateRunStats();
            // Refresh timeline to remove "used" indicators
            if (timelineEncounters.length > 0) {
                displayEncounterTimeline(timelineEncounters);
            }
            // Reset loot tracking fields
            const contributionInput = document.getElementById('runContribution');
            if (contributionInput) contributionInput.value = '';
            const lootNoRadio = document.querySelector('input[name="runGotLoot"][value="no"]');
            if (lootNoRadio) lootNoRadio.checked = true;
            const lootItemInput = document.getElementById('runLootItem');
            if (lootItemInput) lootItemInput.value = '';
            const lootItemContainer = document.getElementById('runLootItemContainer');
            if (lootItemContainer) lootItemContainer.style.display = 'none';
        }
        
        function calculateRunStats() {
            const summarySection = document.getElementById('runSummarySection');
            const summaryPlaceholder = document.getElementById('runSummaryPlaceholder');
            
            if (runEncounters.length === 0) {
                // Hide summary section, show placeholder when no encounters
                if (summarySection) summarySection.style.display = 'none';
                if (summaryPlaceholder) summaryPlaceholder.style.display = 'flex';
                return;
            }
            
            // Show summary section, hide placeholder
            if (summarySection) summarySection.style.display = 'block';
            if (summaryPlaceholder) summaryPlaceholder.style.display = 'none';
            
            // Sort encounters by time for calculations
            const sorted = [...runEncounters].sort((a, b) => new Date(a.start_time) - new Date(b.start_time));
            
            // Use the pre-calculated duration from server (already in seconds)
            const activeTime = sorted.reduce((sum, enc) => sum + (enc.duration || 0), 0);
            
            // Calculate total damage
            const totalDamage = sorted.reduce((sum, e) => sum + e.total_damage, 0);
            
            // Calculate downtime (gaps between encounters)
            let downtime = 0;
            for (let i = 1; i < sorted.length; i++) {
                const prevEnd = new Date(sorted[i - 1].end_time);
                const currStart = new Date(sorted[i].start_time);
                const gap = (currStart - prevEnd) / 1000;
                if (gap > 0) downtime += gap;
            }
            
            // DPS = total damage / active time
            const dps = activeTime > 0 ? totalDamage / activeTime : 0;
            
            // Get time range for summary
            const firstStart = new Date(sorted[0].start_time).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
            const lastEnd = new Date(sorted[sorted.length - 1].end_time).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
            
            // Update overall stats
            document.getElementById('runTotalDamage').textContent = (totalDamage / 1000000).toFixed(2) + 'M';
            document.getElementById('runOverallDps').textContent = Math.round(dps).toLocaleString();
            document.getElementById('runActiveDuration').textContent = formatDuration(activeTime);
            document.getElementById('runDowntime').textContent = formatDuration(downtime);
            document.getElementById('runSummaryTimeRange').innerHTML = `${firstStart} → ${lastEnd}`;
            
            // Category breakdowns
            const categoryColors = {
                'archboss': '#fbbf24',
                'raid_boss': '#ec4899',
                'field_boss': '#5B92D4',
                'dungeon_boss': '#3b82f6',
                'adds': '#ef4444',
                'other': '#64748b'
            };
            
            const categoryIcons = {
                'archboss': '👹',
                'raid_boss': '🏰',
                'field_boss': '🐉',
                'dungeon_boss': '⚔️',
                'adds': '💀',
                'other': '📦'
            };
            
            const categoryLabels = {
                'archboss': 'Archboss',
                'raid_boss': 'Raid Boss',
                'field_boss': 'Field Boss',
                'dungeon_boss': 'Dungeon Boss',
                'adds': 'Adds/Trash',
                'other': 'Other'
            };
            
            const bossCategories = new Set(['archboss', 'raid_boss', 'field_boss', 'dungeon_boss']);
            
            // Group by category
            const byCategory = {};
            sorted.forEach(enc => {
                if (!byCategory[enc.category]) {
                    byCategory[enc.category] = [];
                }
                byCategory[enc.category].push(enc);
            });
            
            // Build category breakdown HTML - compact for sidebar
            let breakdownHtml = '';
            
            // Boss categories first (full stats - but compact)
            ['archboss', 'raid_boss', 'field_boss', 'dungeon_boss'].forEach(cat => {
                if (!byCategory[cat] || byCategory[cat].length === 0) return;
                
                const encounters = byCategory[cat];
                const catDamage = encounters.reduce((sum, e) => sum + e.total_damage, 0);
                // Use pre-calculated duration from server
                const catActiveTime = encounters.reduce((sum, e) => sum + (e.duration || 0), 0);
                const catDps = catActiveTime > 0 ? catDamage / catActiveTime : 0;
                const color = categoryColors[cat];
                const icon = categoryIcons[cat];
                const label = categoryLabels[cat];
                
                breakdownHtml += `
                    <div style="margin-bottom: 10px; padding: 10px; background: rgba(15, 23, 42, 0.5); border: 1px solid ${color}; border-left: 3px solid ${color}; border-radius: 6px;">
                        <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
                            <span style="font-size: 1.1rem;">${icon}</span>
                            <div style="flex: 1;">
                                <div style="font-weight: 700; color: ${color}; font-size: 0.8rem;">${label}</div>
                                <div style="font-size: 0.6rem; color: #64748b;">${encounters.length} encounter${encounters.length > 1 ? 's' : ''} · ${formatDuration(catActiveTime)}</div>
                            </div>
                        </div>
                        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 6px;">
                            <div style="text-align: center; padding: 6px; background: rgba(0,0,0,0.2); border-radius: 4px;">
                                <div style="color: ${color}; font-size: 0.95rem; font-weight: 700;">${Math.round(catDps).toLocaleString()}</div>
                                <div style="color: #64748b; font-size: 0.55rem; text-transform: uppercase;">DPS</div>
                            </div>
                            <div style="text-align: center; padding: 6px; background: rgba(0,0,0,0.2); border-radius: 4px;">
                                <div style="color: #e2e8f0; font-size: 0.95rem; font-weight: 700;">${(catDamage / 1000000).toFixed(2)}M</div>
                                <div style="color: #64748b; font-size: 0.55rem; text-transform: uppercase;">Damage</div>
                            </div>
                        </div>
                    </div>
                `;
            });
            
            // Adds/Trash (total damage only)
            if (byCategory['adds'] && byCategory['adds'].length > 0) {
                const encounters = byCategory['adds'];
                const catDamage = encounters.reduce((sum, e) => sum + e.total_damage, 0);
                const color = categoryColors['adds'];
                
                breakdownHtml += `
                    <div style="margin-bottom: 8px; padding: 8px 10px; background: rgba(15, 23, 42, 0.4); border-left: 3px solid ${color}; border-radius: 4px;">
                        <div style="display: flex; justify-content: space-between; align-items: center;">
                            <div style="display: flex; align-items: center; gap: 6px;">
                                <span style="font-size: 0.9rem;">💀</span>
                                <div>
                                    <div style="font-weight: 600; color: ${color}; font-size: 0.75rem;">Adds/Trash</div>
                                    <div style="font-size: 0.55rem; color: #64748b;">${encounters.length} pack${encounters.length > 1 ? 's' : ''}</div>
                                </div>
                            </div>
                            <div style="color: ${color}; font-size: 0.95rem; font-weight: 700;">${(catDamage / 1000000).toFixed(2)}M</div>
                        </div>
                    </div>
                `;
            }
            
            // Other (total damage only, minimal)
            if (byCategory['other'] && byCategory['other'].length > 0) {
                const encounters = byCategory['other'];
                const catDamage = encounters.reduce((sum, e) => sum + e.total_damage, 0);
                const color = categoryColors['other'];
                
                breakdownHtml += `
                    <div style="padding: 6px 10px; background: rgba(15, 23, 42, 0.3); border-left: 2px solid ${color}; border-radius: 4px;">
                        <div style="display: flex; justify-content: space-between; align-items: center;">
                            <div style="display: flex; align-items: center; gap: 4px;">
                                <span style="font-size: 0.8rem;">📦</span>
                                <span style="color: #94a3b8; font-size: 0.7rem;">Other (${encounters.length})</span>
                            </div>
                            <span style="color: ${color}; font-size: 0.85rem; font-weight: 600;">${(catDamage / 1000000).toFixed(2)}M</span>
                        </div>
                    </div>
                `;
            }
            
            document.getElementById('runCategoryBreakdowns').innerHTML = breakdownHtml;
        }
        
        function saveRun() {
            if (runEncounters.length === 0) {
                alert('Add at least one encounter to the run before saving.');
                return;
            }
            
            const runName = document.getElementById('runNameInput').value.trim() || 'Untitled Run';
            
            // Get hierarchical selection
            const runType = document.getElementById('runTypeSelect').value;
            const runMode = document.getElementById('runModeSelect').value;
            const runTier = document.getElementById('runTierSelect').value;
            const dungeonName = document.getElementById('runDungeonSelect').value;
            
            // Build dungeon info object
            const dungeonInfo = {
                type: runType,
                mode: runMode || null,
                tier: runTier || null,
                name: dungeonName || null
            };
            
            // Build display string for dungeon category
            let dungeonCategory = runType;
            if (runMode) {
                dungeonCategory += ` - ${runMode}`;
            }
            if (runTier) {
                dungeonCategory += ` T${runTier}`;
            }
            
            // Store full encounter data (sorted by time)
            const sortedEncounters = [...runEncounters].sort((a, b) => new Date(a.start_time) - new Date(b.start_time));
            const encounters = sortedEncounters.map(e => ({
                target_name: e.target_name,
                category: e.category,
                start_time: e.start_time,
                end_time: e.end_time,
                duration: e.duration,
                total_damage: e.total_damage,
                dps: e.dps,
                hit_count: e.hit_count,
                merged: e.merged || false,
                merged_from: e.merged_from || null,
                is_attempt: e.is_attempt || false
            }));
            
            // Count attempts
            const attemptCount = sortedEncounters.filter(e => e.is_attempt === true).length;
            
            // Calculate stats
            const totalDamage = runEncounters.reduce((sum, e) => sum + e.total_damage, 0);
            const totalDuration = runEncounters.reduce((sum, e) => sum + (e.duration || 0), 0);
            const dps = totalDuration > 0 ? totalDamage / totalDuration : 0;
            
            let downtime = 0;
            for (let i = 1; i < sortedEncounters.length; i++) {
                const prevEnd = new Date(sortedEncounters[i - 1].end_time);
                const currStart = new Date(sortedEncounters[i].start_time);
                const gap = (currStart - prevEnd) / 1000;
                if (gap > 0) downtime += gap;
            }
            
            const bossCategories = new Set(['archboss', 'raid_boss', 'field_boss', 'dungeon_boss']);
            const bossDamage = runEncounters.filter(e => bossCategories.has(e.category)).reduce((sum, e) => sum + e.total_damage, 0);
            const bossDuration = runEncounters.filter(e => bossCategories.has(e.category)).reduce((sum, e) => sum + (e.duration || 0), 0);
            const bossDps = bossDuration > 0 ? bossDamage / bossDuration : 0;
            
            const trashDamage = runEncounters.filter(e => e.category === 'adds').reduce((sum, e) => sum + e.total_damage, 0);
            const trashDuration = runEncounters.filter(e => e.category === 'adds').reduce((sum, e) => sum + (e.duration || 0), 0);
            const trashDps = trashDuration > 0 ? trashDamage / trashDuration : 0;
            
            const stats = {
                total_damage: totalDamage,
                dps: dps,
                duration: totalDuration,
                downtime: downtime,
                boss_dps: bossDps,
                trash_dps: trashDps,
                boss_damage: bossDamage,
                trash_damage: trashDamage,
                encounter_count: runEncounters.length,
                attempt_count: attemptCount
            };
            
            if (!ws || ws.readyState !== WebSocket.OPEN) {
                alert('WebSocket not connected. Cannot save run.');
                return;
            }
            
            // Get class/build info
            const playerClass = document.getElementById('runClassSelect').value || '';
            const buildTag = document.getElementById('runBuildTag').value.trim() || '';
            
            // Get contribution and loot info
            const contributionInput = document.getElementById('runContribution');
            const contributionValue = contributionInput ? parseFloat(contributionInput.value) : null;
            const contributionPercent = (!isNaN(contributionValue) && contributionValue >= 0 && contributionValue <= 100) ? contributionValue : null;
            
            const gotLoot = document.querySelector('input[name="runGotLoot"]:checked')?.value === 'yes';
            const lootItem = gotLoot ? (document.getElementById('runLootItem')?.value.trim() || null) : null;
            
            ws.send(JSON.stringify({
                command: 'save_run',
                run_name: runName,
                dungeon_category: dungeonCategory,
                dungeon_name: dungeonName || dungeonCategory,
                dungeon_info: dungeonInfo,
                player_class: playerClass,
                build_tag: buildTag,
                contribution_percent: contributionPercent,
                got_loot: gotLoot,
                loot_item: lootItem,
                encounters: encounters,
                stats: stats
            }));
            
            console.log('[RunBuilder] Saving run:', runName, dungeonInfo, 'class:', playerClass, 'contribution:', contributionPercent, 'loot:', gotLoot, lootItem, encounters.length, 'encounters');
        }
        
        // === DUNGEON MANAGEMENT ===
        let dungeonsData = {};
        
        // Default dungeon data structure
        const defaultDungeonsData = {
            "Co-op Dungeon": [
                "Butcher's Canyon", "Carmine Rage Island", "Cave of Desperation", "Cave of Destruction",
                "Chapel of Madness", "Cursed Wasteland", "Death's Abyss", "Forest of Grudge",
                "Hall of Tragedy", "Island of Terror", "Roaring Temple", "Shadowed Crypt",
                "Specter's Abyss", "Temple of Slaughter", "Torture Chamber of Screams", "Tyrant's Isle",
                "Serpent's Abyss"
            ],
            "Raid": ["Calanthia"],
            "Field Boss": ["Cornelius", "Ahzreil", "Morokai", "Deluzhnoa", "Giant Cordy", "Queen Bellandir"],
            "Archboss": ["Tevent", "Queen Bellandir", "Deluzhnoa", "Giant Cordy"],
            "Custom": []
        };
        
        function loadDungeons() {
            if (!ws || ws.readyState !== WebSocket.OPEN) return;
            ws.send(JSON.stringify({ command: 'get_dungeons' }));
        }
        
        function populateDungeonDropdown(dungeons) {
            dungeonsData = dungeons || defaultDungeonsData;
            
            // Populate custom types in Type dropdown
            updateTypeDropdown();
        }
        
        function updateTypeDropdown() {
            const typeSelect = document.getElementById('runTypeSelect');
            if (!typeSelect) return;
            
            // Core types (always present)
            const coreTypes = ['Co-op Dungeon', 'Raid', 'Field Boss', 'Archboss'];
            
            // Find custom types (not in core list)
            const customTypes = Object.keys(dungeonsData).filter(t => 
                !coreTypes.includes(t) && t !== 'Custom' && t !== 'Dimensional Trial'
            );
            
            let html = '<option value="">-- Select Type --</option>';
            
            coreTypes.forEach(type => {
                html += `<option value="${type}">${type}</option>`;
            });
            
            // Add custom types
            if (customTypes.length > 0) {
                html += '<optgroup label="Custom Types">';
                customTypes.forEach(type => {
                    html += `<option value="${type}">${type}</option>`;
                });
                html += '</optgroup>';
            }
            
            html += '<option value="Custom">⚙️ Custom / Manage</option>';
            
            typeSelect.innerHTML = html;
        }
        
        function onRunTypeChange() {
            const typeSelect = document.getElementById('runTypeSelect');
            const type = typeSelect.value;
            
            const modeContainer = document.getElementById('runModeContainer');
            const tierContainer = document.getElementById('runTierContainer');
            const nameContainer = document.getElementById('runNameContainer');
            const customSection = document.getElementById('customManagementSection');
            const dungeonContainer = document.getElementById('dungeonSelectorContainer');
            const lootSection = document.getElementById('runLootSection');
            const contributionContainer = document.getElementById('runContributionContainer');
            
            // Reset all
            modeContainer.style.display = 'none';
            tierContainer.style.display = 'none';
            nameContainer.style.display = 'none';
            customSection.style.display = 'none';
            lootSection.style.display = 'none';
            contributionContainer.style.display = 'none';
            
            if (type === 'Custom') {
                customSection.style.display = 'block';
                return;
            }
            
            // Show loot section for all main types
            if (type === 'Co-op Dungeon' || type === 'Raid' || type === 'Field Boss' || type === 'Archboss') {
                lootSection.style.display = 'block';
                
                // Contribution only for Field Boss and Archboss
                if (type === 'Field Boss' || type === 'Archboss') {
                    contributionContainer.style.display = 'block';
                }
            }
            
            if (type === 'Co-op Dungeon') {
                // Show mode: Dimensional Circle or Dimensional Trial
                document.getElementById('runModeLabel').textContent = 'Mode';
                document.getElementById('runModeSelect').innerHTML = `
                    <option value="">-- Select Mode --</option>
                    <option value="Dimensional Circle">Dimensional Circle</option>
                    <option value="Dimensional Trial">Dimensional Trial</option>
                `;
                modeContainer.style.display = 'block';
            } else if (type === 'Raid') {
                // Show difficulty
                document.getElementById('runModeLabel').textContent = 'Difficulty';
                document.getElementById('runModeSelect').innerHTML = `
                    <option value="">-- Select Difficulty --</option>
                    <option value="Normal">Normal</option>
                    <option value="Difficult">Difficult</option>
                    <option value="Nightmare">Nightmare</option>
                `;
                modeContainer.style.display = 'block';
            } else if (type === 'Field Boss' || type === 'Archboss') {
                // Show Normal/Ascended
                document.getElementById('runModeLabel').textContent = 'Mode';
                document.getElementById('runModeSelect').innerHTML = `
                    <option value="">-- Select Mode --</option>
                    <option value="Normal">Normal</option>
                    <option value="Ascended">Ascended</option>
                `;
                modeContainer.style.display = 'block';
            } else {
                // Custom type - just show name dropdown
                populateNameDropdown(type);
                nameContainer.style.display = 'block';
            }
        }
        
        function onLootChange() {
            const gotLoot = document.querySelector('input[name="runGotLoot"]:checked')?.value === 'yes';
            const lootItemContainer = document.getElementById('runLootItemContainer');
            lootItemContainer.style.display = gotLoot ? 'block' : 'none';
            if (!gotLoot) {
                document.getElementById('runLootItem').value = '';
            }
        }
        
        function onRunModeChange() {
            const type = document.getElementById('runTypeSelect').value;
            const mode = document.getElementById('runModeSelect').value;
            
            const tierContainer = document.getElementById('runTierContainer');
            const nameContainer = document.getElementById('runNameContainer');
            
            tierContainer.style.display = 'none';
            nameContainer.style.display = 'none';
            
            if (!mode) return;
            
            if (type === 'Co-op Dungeon') {
                if (mode === 'Dimensional Trial') {
                    // Show tier selection
                    tierContainer.style.display = 'block';
                }
                // Both modes show dungeon dropdown
                document.getElementById('runNameLabel').textContent = 'Dungeon';
                populateNameDropdown('Co-op Dungeon');
                nameContainer.style.display = 'block';
            } else if (type === 'Raid') {
                document.getElementById('runNameLabel').textContent = 'Raid';
                populateNameDropdown('Raid');
                nameContainer.style.display = 'block';
            } else if (type === 'Field Boss' || type === 'Archboss') {
                document.getElementById('runNameLabel').textContent = 'Boss';
                populateNameDropdown(type);
                nameContainer.style.display = 'block';
            }
        }
        
        function populateNameDropdown(type) {
            const select = document.getElementById('runDungeonSelect');
            if (!select) return;
            
            const entries = dungeonsData[type] || [];
            
            let html = '<option value="">-- Select --</option>';
            entries.forEach(entry => {
                html += `<option value="${entry}">${entry}</option>`;
            });
            
            select.innerHTML = html;
        }
        
        function closeCustomManagement() {
            document.getElementById('customManagementSection').style.display = 'none';
            document.getElementById('runTypeSelect').value = '';
        }
        
        // === CUSTOM MODAL FUNCTIONS ===
        
