        function updateClassPreview(className) {
            const card = document.getElementById('classPreviewCard');
            if (!className) {
                card.style.display = 'none';
                return;
            }
            
            const classInfo = TL_CLASSES.find(c => c.name === className);
            if (classInfo) {
                document.getElementById('classPreviewName').textContent = classInfo.name;
                document.getElementById('classPreviewWeapons').textContent = classInfo.weapons;
                card.style.display = 'block';
            } else {
                card.style.display = 'none';
            }
        }

        function closeSaveModal() {
            document.getElementById('saveModal').classList.remove('active');
            saveSource = 'buildtest';
            saveSourceEncounter = null;
            savingFromEncounterHistory = false;
            pendingEncounterSave = null;
            // Re-enable save button in case it was disabled during load step
            const saveBtn = document.querySelector('#saveModal .btn-primary');
            if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = '💾 Save'; }
        }

        // Parse contribution info encoded in notes field: [CONTRIB:pct:bossHp] rest of notes
        function parseContribNotes(notes) {
            const m = (notes || '').match(/^\[CONTRIB:([0-9.]+):([0-9]+)\]\s*/);
            if (!m) return { contribPct: null, bossHp: null, cleanNotes: notes || '' };
            return { contribPct: parseFloat(m[1]), bossHp: parseInt(m[2]), cleanNotes: notes.slice(m[0].length) };
        }
        
        // === TAG MANAGER ===
        function openTagManagerModal() {
            updateTagManagerList();
            document.getElementById('tagManagerModal').classList.add('active');
        }
        
        function closeTagManagerModal() {
            document.getElementById('tagManagerModal').classList.remove('active');
            updateRecentBuildTags(); // Refresh the build tags in save modal
        }
        
        function updateTagManagerList() {
            const container = document.getElementById('tagManagerList');
            if (visibleBuildTags().length === 0) {
                container.innerHTML = '<div style="color: #7A8CB8; text-align: center; padding: 20px;">No tags yet. Add one below or save an encounter with a new tag.</div>';
                return;
            }
            
            container.innerHTML = visibleBuildTags().map(tag => `
                <div style="display: flex; justify-content: space-between; align-items: center; padding: 10px 14px; background: rgba(29, 47, 80, 0.6); border: 1px solid #263956; border-radius: 8px;">
                    <span style="color: #F0EBE0; font-weight: 500;">🏷️ ${tag}</span>
                    <button onclick="deleteTag('${tag.replace(/'/g, "\\'")}')" style="padding: 4px 8px; background: rgba(239, 68, 68, 0.2); border: 1px solid rgba(239, 68, 68, 0.4); border-radius: 4px; color: #ef4444; cursor: pointer; font-size: 0.8rem;" onmouseover="this.style.background='rgba(239, 68, 68, 0.3)'" onmouseout="this.style.background='rgba(239, 68, 68, 0.2)'">✕</button>
                </div>
            `).join('');
        }
        
        function deleteTag(tag) {
            if (confirm(`Delete tag "${tag}"?\n\nNote: Tags used by saved encounters will reappear when you reload.`)) {
                buildTags = buildTags.filter(t => t !== tag);
                updateTagManagerList();
            }
        }
        
        function addNewTag() {
            const input = document.getElementById('newTagInput');
            const tag = input.value.trim();
            
            if (!tag) {
                alert('Please enter a tag name');
                return;
            }
            
            if (buildTags.includes(tag)) {
                alert('This tag already exists');
                return;
            }
            
            buildTags.push(tag);
            buildTags.sort();
            updateTagManagerList();
            input.value = '';
        }

        // === ENCOUNTERS TAB ===
        let sessionEncounters = [];  // Store detected encounters
        let selectedSessionEncounter = null;  // Currently selected encounter
        let selectedEncounterData = null;  // Full data for selected encounter
        let hideAddsOtherInEncounters = true;  // Default to hiding adds and other
        
        function updateSessionEncountersList(encounters) {
            sessionEncounters = encounters || [];
            renderSessionEncountersList();
        }
        
        function filterSessionEncounters() {
            renderSessionEncountersList();
        }
        
        function toggleHideAddsOther() {
            hideAddsOtherInEncounters = !hideAddsOtherInEncounters;
            renderSessionEncountersList();
            updateHideAddsOtherButton();
        }
        
        function updateHideAddsOtherButton() {
            const btn = document.getElementById('hideAddsToggle');
            if (!btn) return;
            
            const addsCount = sessionEncounters.filter(enc => enc.category === 'adds').length;
            const otherCount = sessionEncounters.filter(enc => enc.category === 'other').length;
            const totalHidden = addsCount + otherCount;
            
            if (hideAddsOtherInEncounters) {
                btn.style.background = 'rgba(239, 68, 68, 0.2)';
                btn.style.borderColor = 'rgba(239, 68, 68, 0.4)';
                btn.style.color = '#ef4444';
                btn.innerHTML = `👥 Adds/Other Hidden <span style="background: #ef4444; color: white; padding: 1px 6px; border-radius: 10px; font-size: 0.7rem; margin-left: 4px;">${totalHidden}</span>`;
            } else {
                btn.style.background = 'rgba(34, 197, 94, 0.2)';
                btn.style.borderColor = 'rgba(34, 197, 94, 0.4)';
                btn.style.color = '#22c55e';
                btn.innerHTML = `👥 Showing All <span style="background: #22c55e; color: white; padding: 1px 6px; border-radius: 10px; font-size: 0.7rem; margin-left: 4px;">${totalHidden}</span>`;
            }
        }
        
        function getFilteredSessionEncounters() {
            const filterValue = document.getElementById('encounterCategoryFilter')?.value || '';
            
            let filtered = sessionEncounters;
            
            // If filter is set, use that (even if it's 'adds' or 'other')
            if (filterValue) {
                filtered = sessionEncounters.filter(enc => enc.category === filterValue);
            } else {
                // No filter set - apply hide adds/other if enabled
                if (hideAddsOtherInEncounters) {
                    filtered = sessionEncounters.filter(enc => enc.category !== 'adds' && enc.category !== 'other');
                }
            }
            
            return filtered;
        }
        
        function getCategoryIcon(category) {
            const icons = {
                'archboss': '👑',
                'raid_boss': '⚔️',
                'field_boss': '🌍',
                'dungeon_boss': '🏰',
                'adds': '👥',
                'other': '❓'
            };
            return icons[category] || '';
        }
        
        function getCategoryLabel(category) {
            const labels = {
                'archboss': 'Archboss',
                'raid_boss': 'Raid Boss',
                'field_boss': 'Field Boss',
                'dungeon_boss': 'Dungeon Boss',
                'adds': 'Adds',
                'other': 'Other'
            };
            return labels[category] || category || 'Unknown';
        }
        
        function isBossCategory(category) {
            return ['archboss', 'raid_boss', 'field_boss', 'dungeon_boss'].includes(category);
        }
        
        function checkMergeable(enc1, enc2) {
            // Check if two encounters could be merged (same boss, 31-90s gap)
            if (!enc1 || !enc2) return null;
            if (enc1.target_name !== enc2.target_name) return null;
            if (!isBossCategory(enc1.category) || !isBossCategory(enc2.category)) return null;
            
            // Calculate gap between end of enc1 and start of enc2
            // enc1 should be EARLIER (newer appears first in list, so enc2 is earlier)
            const end1 = new Date(enc1.end_time || enc1.start_time);
            const start2 = new Date(enc2.start_time);
            const end2 = new Date(enc2.end_time || enc2.start_time);
            const start1 = new Date(enc1.start_time);
            
            // Figure out which is earlier
            let gapSeconds;
            if (start1 > end2) {
                // enc2 happened before enc1
                gapSeconds = (start1 - end2) / 1000;
            } else if (start2 > end1) {
                // enc1 happened before enc2
                gapSeconds = (start2 - end1) / 1000;
            } else {
                // Overlapping? Shouldn't happen
                return null;
            }
            
            // Check if gap is in mergeable range (31-90 seconds)
            if (gapSeconds >= 31 && gapSeconds <= 90) {
                return Math.round(gapSeconds);
            }
            return null;
        }
        
        function findMergeCandidate(filtered, currentIndex, enc) {
            // If current encounter is not a boss, no merge
            if (!isBossCategory(enc.category)) return null;
            
            // Look ahead in filtered list to find same boss (skipping adds)
            for (let i = currentIndex + 1; i < filtered.length; i++) {
                const nextEnc = filtered[i];
                
                // Skip adds/other
                if (nextEnc.category === 'adds' || nextEnc.category === 'other') {
                    continue;
                }
                
                // Found a boss - check if same name
                if (isBossCategory(nextEnc.category)) {
                    if (nextEnc.target_name === enc.target_name) {
                        const gapSeconds = checkMergeable(enc, nextEnc);
                        if (gapSeconds !== null) {
                            return { encounter: nextEnc, gap: gapSeconds, filteredIndex: i };
                        }
                    }
                    // Stop looking once we hit any boss (whether match or not)
                    break;
                }
            }
            return null;
        }
        
        function renderSessionEncountersList() {
            const container = document.getElementById('encountersSessionList');
            if (!container) return;
            
            const filtered = getFilteredSessionEncounters();
            
            if (sessionEncounters.length === 0) {
                container.innerHTML = '<div class="no-data" style="padding: 20px;"><div class="no-data-icon">⚔️</div><div>No encounters detected yet.<br>Start combat to see encounters here.</div></div>';
                return;
            }
            
            if (filtered.length === 0) {
                container.innerHTML = '<div class="no-data" style="padding: 20px;"><div class="no-data-icon">🔍</div><div>No encounters match this filter.</div></div>';
                return;
            }
            
            let html = '';
            
            filtered.forEach((enc, filteredIndex) => {
                // Find original index in sessionEncounters for selection
                const originalIndex = sessionEncounters.findIndex(e => 
                    e.target_name === enc.target_name && e.start_time === enc.start_time
                );
                const category = enc.category || 'other';
                const isActive = selectedSessionEncounter === originalIndex;
                const isMerged = mergedEncounterIndices && mergedEncounterIndices.includes(originalIndex);
                const duration = enc.duration ? formatDuration(enc.duration) : '--';
                const dps = enc.total_damage && enc.duration ? Math.round(enc.total_damage / enc.duration) : 0;
                const categoryIcon = getCategoryIcon(category);
                
                // Render the encounter item
                html += `
                    <div class="encounters-session-item ${category} ${isActive ? 'active' : ''} ${isMerged ? 'merged-source' : ''}" 
                         onclick="selectSessionEncounter(${originalIndex})">
                        ${isMerged ? '<span class="merged-link-icon">🔗</span>' : ''}
                        <div class="target-name">${categoryIcon} ${enc.target_name || 'Unknown'}</div>
                        <div class="encounter-meta">
                            <span class="dps">${formatNumber(dps)} DPS</span>
                            <span>${duration}</span>
                            <span>${formatNumber(enc.total_damage || 0)} dmg</span>
                        </div>
                    </div>
                `;
                
                // Check if there's a mergeable boss encounter (skipping adds)
                const mergeCandidate = findMergeCandidate(filtered, filteredIndex, enc);
                
                if (mergeCandidate) {
                    const nextOriginalIndex = sessionEncounters.findIndex(e => 
                        e.target_name === mergeCandidate.encounter.target_name && e.start_time === mergeCandidate.encounter.start_time
                    );
                    
                    // Check if these two are already merged
                    const areMerged = mergedEncounterIndices && 
                        mergedEncounterIndices.includes(originalIndex) && 
                        mergedEncounterIndices.includes(nextOriginalIndex);
                    
                    if (areMerged) {
                        // Show merged connection instead of merge button
                        html += `
                            <div class="merge-indicator merged-active">
                                <div class="merge-line"></div>
                                <div class="merge-content">
                                    <span class="merge-gap">🔗 ${mergeCandidate.gap}s gap (merged)</span>
                                </div>
                                <div class="merge-line"></div>
                            </div>
                        `;
                    } else {
                        // Show merge button
                        html += `
                            <div class="merge-indicator">
                                <div class="merge-line"></div>
                                <div class="merge-content">
                                    <span class="merge-gap">⏱️ ${mergeCandidate.gap}s gap</span>
                                    <button class="merge-btn" onclick="event.stopPropagation(); mergeEncounters(${originalIndex}, ${nextOriginalIndex})">
                                        🔗 Merge
                                    </button>
                                </div>
                                <div class="merge-line"></div>
                            </div>
                        `;
                    }
                }
            });
            
            container.innerHTML = html;
            
            // Update the hide adds/other button state
            updateHideAddsOtherButton();
        }
        
        function selectSessionEncounter(index) {
            selectedSessionEncounter = index;
            renderSessionEncountersList();  // Update active state
            
            const enc = sessionEncounters[index];
            if (!enc) return;
            
            // Store category for display
            selectedEncounterCategory = enc.category;
            
            // Clear any merged view state
            mergedEncounterIndices = null;
            renderSessionEncountersList();
            
            // Request full encounter details from server
            sendCommand('get_encounter_details', {
                target_name: enc.target_name,
                start_time: enc.start_time
            });
        }
        
        // Track which encounters are currently being viewed as merged
        let mergedEncounterIndices = null;
        
        function mergeEncounters(index1, index2) {
            const enc1 = sessionEncounters[index1];
            const enc2 = sessionEncounters[index2];
            
            if (!enc1 || !enc2) {
                console.error('[Merge] Invalid encounter indices');
                return;
            }
            
            // Determine which is earlier
            const start1 = new Date(enc1.start_time);
            const start2 = new Date(enc2.start_time);
            const earlierEnc = start1 < start2 ? enc1 : enc2;
            const laterEnc = start1 < start2 ? enc2 : enc1;
            const earlierIndex = start1 < start2 ? index1 : index2;
            const laterIndex = start1 < start2 ? index2 : index1;
            
            // Calculate gap for display
            const earlierEnd = new Date(earlierEnc.end_time || earlierEnc.start_time);
            const laterStart = new Date(laterEnc.start_time);
            const gapSeconds = Math.round((laterStart - earlierEnd) / 1000);
            
            // Confirm with user
            const confirmMsg = `Merge these encounters?\n\n` +
                `• ${earlierEnc.target_name} (${formatDuration(earlierEnc.duration)})\n` +
                `  ↓ ${gapSeconds}s gap\n` +
                `• ${laterEnc.target_name} (${formatDuration(laterEnc.duration)})\n\n` +
                `This will combine them into a single encounter.`;
            
            if (!confirm(confirmMsg)) return;
            
            // Track which encounters are merged for highlighting
            mergedEncounterIndices = [earlierIndex, laterIndex];
            selectedSessionEncounter = null; // Clear single selection
            renderSessionEncountersList(); // Update list to show merged state
            
            // Send merge request to server
            sendCommand('merge_encounters', {
                target_name: enc1.target_name,
                start_time_1: earlierEnc.start_time,
                start_time_2: laterEnc.start_time
            });
            
            console.log('[Merge] Requested merge of', earlierEnc.target_name, 'encounters');
        }
        
        let selectedEncounterCategory = null;
        
        function displayEncounterDetails(data) {
            console.log('[Encounters] Received encounter details:', data);
            console.log('[Encounters] hit_log length:', data.hit_log ? data.hit_log.length : 'undefined');
            console.log('[Encounters] skills:', data.skills);
            
            selectedEncounterData = data;
            
            // Show detail content, hide empty state
            document.getElementById('encountersEmptyState').style.display = 'none';
            document.getElementById('encountersDetailContent').style.display = 'block';
            
            // Update header
            const targetEl = document.getElementById('encDetailTarget');
            if (targetEl) {
                targetEl.textContent = data.target_name || 'Unknown';
            }
            document.getElementById('encDetailDuration').textContent = formatDuration(data.duration || 0);
            document.getElementById('encDetailTime').textContent = data.start_time ? new Date(data.start_time).toLocaleString() : '--';
            
            // Show/hide merged badge
            let mergedBadge = document.getElementById('encMergedBadge');
            if (!mergedBadge) {
                // Create merged badge if it doesn't exist
                const headerEl = document.querySelector('.encounters-detail-title');
                if (headerEl) {
                    mergedBadge = document.createElement('span');
                    mergedBadge.id = 'encMergedBadge';
                    mergedBadge.className = 'merged-badge';
                    mergedBadge.innerHTML = '🔗 Merged';
                    headerEl.appendChild(mergedBadge);
                }
            }
            if (mergedBadge) {
                mergedBadge.style.display = data.merged ? 'inline-block' : 'none';
            }
            
            // Update category badge
            const categoryEl = document.getElementById('encDetailCategory');
            if (categoryEl && selectedEncounterCategory) {
                categoryEl.textContent = getCategoryIcon(selectedEncounterCategory) + ' ' + getCategoryLabel(selectedEncounterCategory);
                categoryEl.className = 'encounters-detail-category ' + selectedEncounterCategory;
                categoryEl.style.display = 'inline-block';
            } else if (categoryEl) {
                categoryEl.style.display = 'none';
            }
            
            // Render all subtabs
            try {
                renderEncSummary(data);
            } catch (e) {
                console.error('[Encounters] Error in renderEncSummary:', e);
            }
            
            try {
                renderEncSkillsTable(data.skills || []);
            } catch (e) {
                console.error('[Encounters] Error in renderEncSkillsTable:', e);
            }
            
            try {
                renderEncWeapons(data);
            } catch (e) {
                console.error('[Encounters] Error in renderEncWeapons:', e);
            }
            
            try {
                renderEncRotationFull(data);
            } catch (e) {
                console.error('[Encounters] Error in renderEncRotationFull:', e);
            }
            
            // Reset to summary tab
            switchEncSubtab('summary');
        }
        
        function renderEncSummary(data) {
            const dps = data.duration > 0 ? Math.round(data.total_damage / data.duration) : 0;
            const avgHit = data.hit_count > 0 ? Math.round(data.total_damage / data.hit_count) : 0;
            
            // Performance Overview
            document.getElementById('encSummaryDps').textContent = formatNumber(dps);
            document.getElementById('encSummaryDamage').textContent = formatNumber(data.total_damage || 0);
            document.getElementById('encSummaryHits').textContent = formatNumber(data.hit_count || 0);
            document.getElementById('encSummaryAvgHit').textContent = formatNumber(avgHit);
            
            // Crit/Heavy stats
            document.getElementById('encSummaryNormal').textContent = (data.normal_rate || 0).toFixed(1) + '%';
            document.getElementById('encSummaryCrit').textContent = (data.crit_rate || 0).toFixed(1) + '%';
            document.getElementById('encSummaryHeavy').textContent = (data.heavy_rate || 0).toFixed(1) + '%';
            document.getElementById('encSummaryCritHeavy').textContent = (data.crit_heavy_rate || 0).toFixed(1) + '%';
            
            // Top 5 Skills
            renderEncTop5Skills(data.skills || []);
            
            // Piano Roll
            renderEncPianoRoll(data.hit_log || [], data.duration || 60);
        }
        
        function renderEncTop5Skills(skills) {
            const container = document.getElementById('encSummaryTopSkills');
            if (!skills || skills.length === 0) {
                container.innerHTML = '<div style="color: #7A8CB8; padding: 12px; text-align: center;">No skills recorded</div>';
                return;
            }
            
            const sorted = [...skills].sort((a, b) => b.damage - a.damage).slice(0, 5);
            const maxDamage = sorted[0]?.damage || 1;
            const totalDamage = skills.reduce((sum, s) => sum + s.damage, 0);
            
            container.innerHTML = sorted.map((skill, i) => {
                const pct = totalDamage > 0 ? (skill.damage / totalDamage * 100).toFixed(1) : 0;
                const barWidth = (skill.damage / maxDamage * 100).toFixed(1);
                const colors = ['#5B92D4', '#D96444', '#f472b6', '#34d399', '#fbbf24'];
                
                return `
                    <div style="display: flex; align-items: center; gap: 12px; padding: 8px 12px; background: rgba(21, 32, 53, 0.4); border-radius: 8px;">
                        <div style="width: 24px; height: 24px; background: ${colors[i]}; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 0.7rem; font-weight: 700; color: #152035;">${i + 1}</div>
                        <div style="flex: 1; min-width: 0;">
                            <div style="display: flex; justify-content: space-between; margin-bottom: 4px;">
                                <span style="font-size: 0.85rem; font-weight: 600; color: #F0EBE0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${skill.name}</span>
                                <span style="font-size: 0.85rem; font-weight: 600; color: ${colors[i]};">${pct}%</span>
                            </div>
                            <div style="height: 4px; background: rgba(122, 140, 184, 0.3); border-radius: 2px; overflow: hidden;">
                                <div style="height: 100%; width: ${barWidth}%; background: ${colors[i]}; border-radius: 2px;"></div>
                            </div>
                        </div>
                        <div style="text-align: right; min-width: 70px;">
                            <div style="font-size: 0.8rem; font-weight: 600; color: #F0EBE0;">${formatNumber(skill.damage)}</div>
                        </div>
                    </div>
                `;
            }).join('');
        }
        
        function renderEncPianoRoll(rotation, duration) {
            const container = document.getElementById('encSummaryPianoRoll');
            if (!container) return;
            
            if (!rotation || rotation.length === 0) {
                container.innerHTML = `
                    <div class="piano-roll-empty">
                        <div style="font-size: 1.5rem; margin-bottom: 8px;">🎹</div>
                        <div>No rotation data available</div>
                    </div>
                `;
                return;
            }
            
            // Group hits by skill
            const skillHits = {};
            const skillDamage = {};
            const skillCounts = {};
            
            rotation.forEach(hit => {
                const skill = hit.skill || 'Unknown';
                if (!skillHits[skill]) {
                    skillHits[skill] = [];
                    skillDamage[skill] = 0;
                    skillCounts[skill] = 0;
                }
                skillHits[skill].push(hit);
                skillDamage[skill] += hit.damage;
                skillCounts[skill]++;
            });
            
            // Sort skills by total damage (descending)
            const sortedSkills = Object.keys(skillHits).sort((a, b) => skillDamage[b] - skillDamage[a]);
            
            // Calculate time markers based on duration
            const timeMarkers = [];
            const markerInterval = duration <= 60 ? 15 : duration <= 120 ? 30 : duration <= 300 ? 60 : 120;
            for (let t = 0; t <= duration; t += markerInterval) {
                timeMarkers.push(t);
            }
            if (timeMarkers[timeMarkers.length - 1] < duration) {
                timeMarkers.push(Math.ceil(duration));
            }
            
            // Build piano roll HTML
            let html = `
                <div class="piano-roll-header">
                    <div class="piano-roll-time-markers">
                        ${timeMarkers.map(t => `<span>${t}s</span>`).join('')}
                    </div>
                    <div style="width: 80px; text-align: right; font-size: 0.7rem; color: #7A8CB8;">DAMAGE</div>
                </div>
            `;
            
            sortedSkills.forEach(skill => {
                const hits = skillHits[skill];
                const damage = skillDamage[skill];
                const count = skillCounts[skill];
                
                // Generate hit markers
                let hitsHtml = '';
                hits.forEach(hit => {
                    const time = hit.relative_time || 0;
                    const leftPercent = (time / duration) * 100;
                    
                    // Determine hit type class
                    let hitClass = 'normal';
                    let tooltip = `${formatNumber(hit.damage)}`;
                    
                    if (hit.is_crit && hit.is_heavy) {
                        hitClass = 'crit-heavy';
                        tooltip += ' (Crit+Heavy)';
                    } else if (hit.is_crit) {
                        hitClass = 'crit';
                        tooltip += ' (Crit)';
                    } else if (hit.is_heavy) {
                        hitClass = 'heavy';
                        tooltip += ' (Heavy)';
                    }
                    
                    hitsHtml += `<div class="piano-roll-hit ${hitClass}" style="left: ${leftPercent}%" title="${time.toFixed(1)}s: ${tooltip}"></div>`;
                });
                
                html += `
                    <div class="piano-roll-row">
                        <div class="piano-roll-skill-name" title="${skill}">${skill}</div>
                        <div class="piano-roll-lane">${hitsHtml}</div>
                        <div class="piano-roll-stats">
                            <div class="damage">${formatNumber(damage)}</div>
                            <div class="hits">${count} hit${count !== 1 ? 's' : ''}</div>
                        </div>
                    </div>
                `;
            });
            
            // Add legend
            html += `
                <div class="piano-roll-legend">
                    <div class="piano-roll-legend-item">
                        <div class="piano-roll-legend-dot normal"></div>
                        <span>Normal</span>
                    </div>
                    <div class="piano-roll-legend-item">
                        <div class="piano-roll-legend-dot crit"></div>
                        <span>Crit</span>
                    </div>
                    <div class="piano-roll-legend-item">
                        <div class="piano-roll-legend-dot heavy"></div>
                        <span>Heavy</span>
                    </div>
                    <div class="piano-roll-legend-item">
                        <div class="piano-roll-legend-dot crit-heavy"></div>
                        <span>Crit+Heavy</span>
                    </div>
                </div>
            `;
            
            container.innerHTML = html;
        }
        
        function renderEncSkillsTable(skills) {
            const tbody = document.getElementById('encSkillsBody');
            if (!tbody) return;
            
            if (!skills || skills.length === 0) {
                tbody.innerHTML = '<tr><td colspan="9" style="text-align: center; color: #7A8CB8; padding: 20px;">No skills recorded</td></tr>';
                return;
            }
            
            const sorted = [...skills].sort((a, b) => b.damage - a.damage);
            const maxDamage = sorted[0]?.damage || 1;
            const totalDamage = sorted.reduce((sum, s) => sum + s.damage, 0);
            
            tbody.innerHTML = sorted.map(skill => {
                const pct = totalDamage > 0 ? (skill.damage / totalDamage * 100).toFixed(1) : 0;
                const barWidth = (skill.damage / maxDamage * 100).toFixed(1);
                const critPct = skill.hits > 0 ? (skill.crits / skill.hits * 100).toFixed(1) : '0.0';
                const heavyPct = skill.hits > 0 ? (skill.heavies / skill.hits * 100).toFixed(1) : '0.0';
                
                return `
                    <tr>
                        <td>${skill.name}</td>
                        <td class="num">${formatNumber(skill.damage)}</td>
                        <td style="width: 100px;">
                            <div style="height: 8px; background: rgba(122, 140, 184, 0.3); border-radius: 4px; overflow: hidden;">
                                <div style="height: 100%; width: ${barWidth}%; background: linear-gradient(90deg, #D96444, #5B92D4); border-radius: 4px;"></div>
                            </div>
                        </td>
                        <td class="num">${skill.hits}</td>
                        <td class="num" style="color: #fbbf24;">${skill.crits}</td>
                        <td class="num" style="color: #fbbf24;">${critPct}%</td>
                        <td class="num" style="color: #fb923c;">${skill.heavies}</td>
                        <td class="num" style="color: #fb923c;">${heavyPct}%</td>
                        <td class="num" style="color: #5B92D4; font-weight: 600;">${pct}%</td>
                    </tr>
                `;
            }).join('');
        }
        
        function renderEncWeapons(data) {
            const skills = data.skills || [];
            const grid = document.getElementById('encWeaponBreakdownGrid');
            const legendContainer = document.getElementById('encPieChartLegend');
            const canvas = document.getElementById('encCategoryPieChart');
            
            console.log('[Encounters] renderEncWeapons - skills:', skills.length, 'grid:', !!grid);
            
            if (!grid) {
                console.error('[Encounters] encWeaponBreakdownGrid not found');
                return;
            }
            
            // Category definitions (same as Build Testing)
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
            const categoryColors = {
                greatsword: '#ef4444',
                sns: '#f97316',
                dagger: '#5B92D4',
                spear: '#ec4899',
                crossbow: '#22c55e',
                longbow: '#84cc16',
                staff: '#3b82f6',
                wand: '#D96444',
                orb: '#8b5cf6',
                mastery: '#fbbf24',
                other: '#7A8CB8',
                unassigned: '#405A85'
            };
            
            // Get skill assignments
            const assignments = (typeof weaponConfig !== 'undefined' && weaponConfig.skillAssignments) 
                ? weaponConfig.skillAssignments 
                : {};
            
            // Build breakdown data per category
            const breakdown = {};
            let totalDamage = 0;
            
            skills.forEach(skill => {
                const cat = assignments[skill.name] || 'unassigned';
                
                if (!breakdown[cat]) {
                    breakdown[cat] = {
                        damage: 0,
                        hits: 0,
                        crits: 0,
                        heavies: 0,
                        skills: []
                    };
                }
                
                breakdown[cat].damage += skill.damage || 0;
                breakdown[cat].hits += skill.hits || 0;
                breakdown[cat].crits += skill.crits || 0;
                breakdown[cat].heavies += skill.heavies || 0;
                breakdown[cat].skills.push({
                    name: skill.name,
                    damage: skill.damage || 0
                });
                totalDamage += skill.damage || 0;
            });
            
            // Calculate derived stats and percent
            Object.keys(breakdown).forEach(cat => {
                const data = breakdown[cat];
                data.percent = totalDamage > 0 ? (data.damage / totalDamage * 100) : 0;
                data.avg_hit = data.hits > 0 ? data.damage / data.hits : 0;
                data.crit_rate = data.hits > 0 ? (data.crits / data.hits * 100) : 0;
                data.heavy_rate = data.hits > 0 ? (data.heavies / data.hits * 100) : 0;
                // Sort skills by damage
                data.skills.sort((a, b) => b.damage - a.damage);
            });
            
            // Render weapon breakdown cards
            let html = '';
            
            categoryOrder.forEach(cat => {
                const catData = breakdown[cat];
                if (!catData || catData.damage === 0) return;
                
                const categoryName = categoryNames[cat];
                const icon = categoryIcons[cat];
                const topSkills = catData.skills.slice(0, 5);
                
                html += `
                    <div class="weapon-breakdown-card ${cat}">
                        <div class="breakdown-header">
                            <div class="breakdown-title">
                                <span class="breakdown-icon">${icon}</span>
                                <div>
                                    <div class="breakdown-name">${categoryName}</div>
                                </div>
                            </div>
                            <div class="breakdown-percent">${catData.percent.toFixed(1)}%</div>
                        </div>
                        
                        <div class="breakdown-damage">${formatNumber(catData.damage)}</div>
                        
                        <div class="breakdown-bar">
                            <div class="breakdown-bar-fill" style="width: ${catData.percent}%"></div>
                        </div>
                        
                        <div class="breakdown-stats">
                            <div class="breakdown-stat">
                                <span class="breakdown-stat-label">Hits</span>
                                <span class="breakdown-stat-value">${catData.hits}</span>
                            </div>
                            <div class="breakdown-stat">
                                <span class="breakdown-stat-label">Avg Hit</span>
                                <span class="breakdown-stat-value">${formatNumber(Math.round(catData.avg_hit))}</span>
                            </div>
                            <div class="breakdown-stat">
                                <span class="breakdown-stat-label">Crit %</span>
                                <span class="breakdown-stat-value">${catData.crit_rate.toFixed(1)}%</span>
                            </div>
                            <div class="breakdown-stat">
                                <span class="breakdown-stat-label">Heavy %</span>
                                <span class="breakdown-stat-value">${catData.heavy_rate.toFixed(1)}%</span>
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
                        <div class="no-data-icon">⚔️</div>
                        <div>Assign skills in the <strong>Skill Assign</strong> tab to see breakdown</div>
                    </div>
                `;
            }
            
            grid.innerHTML = html;
            
            // Draw pie chart (same as Build Testing)
            if (canvas && legendContainer) {
                const ctx = canvas.getContext('2d');
                const centerX = canvas.width / 2;
                const centerY = canvas.height / 2;
                const radius = Math.min(centerX, centerY) - 10;
                
                ctx.clearRect(0, 0, canvas.width, canvas.height);
                
                // Collect pie data
                const pieData = [];
                categoryOrder.forEach(cat => {
                    const catData = breakdown[cat];
                    if (!catData || catData.damage === 0) return;
                    pieData.push({
                        category: cat,
                        name: categoryNames[cat],
                        damage: catData.damage,
                        percent: catData.percent,
                        color: categoryColors[cat]
                    });
                });
                
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
                let startAngle = -Math.PI / 2;
                pieData.forEach(item => {
                    const sliceAngle = (item.damage / totalDamage) * 2 * Math.PI;
                    
                    ctx.beginPath();
                    ctx.moveTo(centerX, centerY);
                    ctx.arc(centerX, centerY, radius, startAngle, startAngle + sliceAngle);
                    ctx.closePath();
                    ctx.fillStyle = item.color;
                    ctx.fill();
                    
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
                ctx.fillText('Total Damage', centerX, centerY + 12);
                
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
        }
        
        function renderEncRotationFull(data) {
            const rotation = data.hit_log || [];
            const duration = data.duration || 60;
            
            console.log('[Encounters] renderEncRotationFull - rotation length:', rotation.length, 'duration:', duration);
            
            // Handle empty rotation data
            if (!rotation || rotation.length === 0) {
                console.log('[Encounters] No rotation data - showing empty state');
                const chartContainer = document.getElementById('encRotationDpsChart');
                const segmentsContainer = document.getElementById('encRotationSegments');
                const insightsContainer = document.getElementById('encRotationInsights');
                const hitListContainer = document.getElementById('encRotationHitList');
                
                if (chartContainer) chartContainer.innerHTML = '<div style="color: #7A8CB8; padding: 20px; text-align: center;">No DPS data available</div>';
                if (segmentsContainer) segmentsContainer.innerHTML = '<div style="color: #7A8CB8; padding: 20px; text-align: center;">No segment data available</div>';
                if (insightsContainer) insightsContainer.innerHTML = '<div class="rotation-insight info"><span class="rotation-insight-icon">ℹ️</span><span class="rotation-insight-text">No rotation data to analyze</span></div>';
                if (hitListContainer) hitListContainer.innerHTML = '<div style="color: #7A8CB8; padding: 12px; text-align: center;">No hits recorded</div>';
                
                const gapsSection = document.getElementById('encRotationGapsSection');
                if (gapsSection) gapsSection.style.display = 'none';
                return;
            }
            
            console.log('[Encounters] Rendering rotation with', rotation.length, 'hits');
            
            // Update x-axis labels
            const xAxis = document.getElementById('encRotationXAxis');
            if (xAxis) {
                const markerInterval = duration <= 60 ? 15 : duration <= 120 ? 30 : duration <= 300 ? 60 : 120;
                const markers = [];
                for (let t = 0; t <= duration; t += markerInterval) {
                    markers.push(`<span>${t}s</span>`);
                }
                if (markers.length > 0 && parseInt(markers[markers.length - 1].match(/\d+/)[0]) < duration) {
                    markers.push(`<span>${Math.ceil(duration)}s</span>`);
                }
                xAxis.innerHTML = markers.join('');
            }
            
            // DPS Timeline chart
            renderEncDpsChart(rotation, duration);
            
            // Rotation Segments
            renderEncSegments(rotation, duration);
            
            // Performance Analysis
            renderEncInsights(data, rotation, duration);
            
            // Gap Analysis
            renderEncGaps(rotation, duration);
            
            // Summary cards
            renderEncRotationSummary(data, rotation, duration);
            
            // Hit Log
            renderEncHitLog(rotation);
        }
        
        function renderEncDpsChart(rotation, duration) {
            lastEncRotationCache = { rotation, duration };
            renderEncStackedChart(rotation, duration);
            // Update dynamic x-axis labels for variable duration
            const xAxis = document.getElementById('encRotationXAxis');
            if (xAxis) {
                const maxSec = Math.min(Math.ceil(duration), 120);
                const interval = maxSec <= 60 ? 15 : maxSec <= 120 ? 30 : 60;
                const markers = [];
                for (let t = 0; t <= maxSec; t += interval) markers.push(`<span>${t}s</span>`);
                if (parseInt(markers[markers.length-1].match(/\d+/)?.[0]||0) < maxSec) markers.push(`<span>${maxSec}s</span>`);
                xAxis.innerHTML = markers.join('');
            }
        }
        
        function renderEncSegments(rotation, duration) {
            const container = document.getElementById('encRotationSegments');
            if (!container) {
                console.error('[Encounters] encRotationSegments container not found');
                return;
            }
            
            if (!rotation || rotation.length === 0) {
                container.innerHTML = '<div style="color: #7A8CB8; padding: 20px; text-align: center;">No segment data available</div>';
                return;
            }
            
            console.log('[Encounters] renderEncSegments - rotation:', rotation.length, 'duration:', duration);
            
            // Divide into 4 segments
            const segmentDuration = duration / 4;
            const segments = [];
            
            for (let i = 0; i < 4; i++) {
                const start = i * segmentDuration;
                const end = (i + 1) * segmentDuration;
                const segmentHits = rotation.filter(h => h.relative_time >= start && h.relative_time < end);
                const damage = segmentHits.reduce((sum, h) => sum + h.damage, 0);
                const crits = segmentHits.filter(h => h.is_crit).length;
                const heavies = segmentHits.filter(h => h.is_heavy).length;
                const dps = damage / segmentDuration;
                segments.push({ 
                    label: `${Math.round(start)}s - ${Math.round(end)}s`,
                    damage, 
                    dps, 
                    hits: segmentHits.length,
                    crits,
                    heavies
                });
            }
            
            const maxDps = Math.max(...segments.map(s => s.dps), 1);
            const bestSegment = segments.reduce((best, seg) => seg.dps > best.dps ? seg : best, segments[0]);
            const activeSegments = segments.filter(s => s.hits > 0);
            const worstSegment = activeSegments.length > 0 
                ? activeSegments.reduce((worst, seg) => seg.dps < worst.dps ? seg : worst, activeSegments[0]) 
                : segments[0];
            
            console.log('[Encounters] Segments:', segments.map(s => ({ label: s.label, dps: Math.round(s.dps), hits: s.hits })));
            
            container.innerHTML = segments.map((seg, i) => {
                let segClass = '';
                let badge = '';
                if (seg === bestSegment && seg.hits > 0) {
                    segClass = 'best';
                    badge = '<span class="rotation-segment-badge best">BEST</span>';
                } else if (seg === worstSegment && seg.hits > 0 && activeSegments.length > 1) {
                    segClass = 'worst';
                    badge = '<span class="rotation-segment-badge worst">WEAKEST</span>';
                }
                
                const barWidth = maxDps > 0 ? (seg.dps / maxDps * 100) : 0;
                
                return `
                    <div class="rotation-segment ${segClass}">
                        <div class="rotation-segment-header">
                            <span class="rotation-segment-time">${seg.label}</span>
                            ${badge}
                        </div>
                        <div class="rotation-segment-dps">${formatNumber(Math.round(seg.dps))}</div>
                        <div class="rotation-segment-damage">${formatNumber(seg.damage)} damage</div>
                        <div class="rotation-segment-bar">
                            <div class="rotation-segment-bar-fill" style="width: ${barWidth}%"></div>
                        </div>
                        <div class="rotation-segment-stats">
                            <span>${seg.hits} hits</span>
                            <span>${seg.crits} crits</span>
                            <span>${seg.heavies} heavy</span>
                        </div>
                    </div>
                `;
            }).join('');
        }
        
        function renderEncInsights(data, rotation, duration) {
            renderEncInsightsRich(data, rotation, duration);
        }
        
        function renderEncGaps(rotation, duration) {
            const container = document.getElementById('encRotationGapsList');
            const section = document.getElementById('encRotationGapsSection');
            if (!container || !section) return;
            
            if (!rotation || rotation.length < 2) {
                section.style.display = 'none';
                return;
            }
            
            // Find gaps > 2 seconds
            const sortedHits = [...rotation].sort((a, b) => a.relative_time - b.relative_time);
            const gaps = [];
            
            for (let i = 1; i < sortedHits.length; i++) {
                const prevTime = sortedHits[i - 1].relative_time;
                const currTime = sortedHits[i].relative_time;
                const gap = currTime - prevTime;
                if (gap > 2) {
                    gaps.push({
                        time: prevTime,
                        duration: gap,
                        afterSkill: sortedHits[i - 1].skill || 'Unknown'
                    });
                }
            }
            
            if (gaps.length === 0) {
                section.style.display = 'none';
                return;
            }
            
            section.style.display = 'block';
            const majorGaps = gaps.filter(g => g.duration > 3).slice(0, 10);
            
            container.innerHTML = majorGaps.map(g => `
                <div class="rotation-gap-item">
                    <span class="gap-time">${g.time.toFixed(1)}s</span>
                    <span class="gap-duration">${g.duration.toFixed(1)}s gap</span>
                    <span class="gap-after">after "${g.afterSkill}"</span>
                </div>
            `).join('');
        }
        
        function renderEncRotationSummary(data, rotation, duration) {
            // Calculate gap stats
            const sortedHits = [...rotation].sort((a, b) => a.relative_time - b.relative_time);
            let totalGapTime = 0;
            let majorGaps = 0;
            let longestGap = 0;
            const gapDurations = [];
            
            for (let i = 1; i < sortedHits.length; i++) {
                const gap = sortedHits[i].relative_time - sortedHits[i - 1].relative_time;
                if (gap > 1) {
                    totalGapTime += gap - 1;
                    gapDurations.push(gap);
                    if (gap > longestGap) longestGap = gap;
                    if (gap > 3) majorGaps++;
                }
            }
            
            const avgGap = gapDurations.length > 0 ? gapDurations.reduce((a, b) => a + b, 0) / gapDurations.length : 0;
            const activityRate = duration > 0 ? ((duration - totalGapTime) / duration * 100) : 100;
            
            // Find peak 5s window
            let peak5s = 0;
            for (let i = 0; i <= duration - 5; i++) {
                const windowHits = rotation.filter(h => h.relative_time >= i && h.relative_time < i + 5);
                const windowDps = windowHits.reduce((sum, h) => sum + h.damage, 0) / 5;
                if (windowDps > peak5s) peak5s = windowDps;
            }
            
            // Update summary cards
            const deadTimeEl = document.getElementById('encRotationDeadTime');
            const majorGapsEl = document.getElementById('encRotationMajorGaps');
            const longestGapEl = document.getElementById('encRotationLongestGap');
            const avgGapEl = document.getElementById('encRotationAvgGap');
            const activityEl = document.getElementById('encRotationActivityRate');
            const peakEl = document.getElementById('encRotationPeakWindow');
            
            if (deadTimeEl) deadTimeEl.textContent = totalGapTime.toFixed(1) + 's';
            if (majorGapsEl) majorGapsEl.textContent = majorGaps;
            if (longestGapEl) longestGapEl.textContent = longestGap.toFixed(1) + 's';
            if (avgGapEl) avgGapEl.textContent = avgGap.toFixed(1) + 's';
            if (activityEl) activityEl.textContent = activityRate.toFixed(1) + '%';
            if (peakEl) peakEl.textContent = formatNumber(Math.round(peak5s));
        }
        
        function renderEncHitLog(rotation) {
            const container = document.getElementById('encRotationHitList');
            const countEl = document.getElementById('encRotationHitCount');
            if (!container) {
                console.error('[Encounters] encRotationHitList container not found');
                return;
            }
            
            if (countEl) countEl.textContent = `${rotation.length} hits`;
            
            if (!rotation || rotation.length === 0) {
                container.innerHTML = '<div style="color: #7A8CB8; padding: 12px; text-align: center;">No hits recorded</div>';
                return;
            }
            
            console.log('[Encounters] Rendering hit log with', rotation.length, 'hits');
            
            // Sort by time and show first 100
            const sorted = [...rotation].sort((a, b) => (a.relative_time || 0) - (b.relative_time || 0)).slice(0, 100);
            
            let hitHtml = '';
            for (let i = 0; i < sorted.length; i++) {
                const hit = sorted[i];
                
                // Calculate gap from previous hit
                if (i > 0) {
                    const prevTime = sorted[i-1].relative_time || 0;
                    const currTime = hit.relative_time || 0;
                    const gap = currTime - prevTime;
                    
                    if (gap > 1.0) {
                        let gapClass = gap > 2.0 ? 'danger' : 'warning';
                        let gapIcon = gap > 2.0 ? '⚠️' : '⋮';
                        hitHtml += `
                            <div class="rotation-gap ${gapClass}">
                                <div class="gap-line"></div>
                                <span class="gap-icon">${gapIcon}</span>
                                <span class="gap-text">${gap.toFixed(1)}s gap</span>
                            </div>
                        `;
                    }
                }
                
                hitHtml += `
                    <div class="rotation-hit">
                        <div class="time">${(hit.relative_time || 0).toFixed(1)}s</div>
                        <div class="skill">${hit.skill || 'Unknown'}</div>
                        <div class="tags">
                            ${hit.is_crit ? '<span class="tag crit">CRIT</span>' : ''}
                            ${hit.is_heavy ? '<span class="tag heavy">HEAVY</span>' : ''}
                        </div>
                        <div class="damage">${formatNumber(hit.damage)}</div>
                    </div>
                `;
            }
            
            container.innerHTML = hitHtml;
            
            if (rotation.length > 100) {
                container.innerHTML += `<div style="color: #7A8CB8; padding: 8px; text-align: center; font-size: 0.8rem;">Showing first 100 of ${rotation.length} hits</div>`;
            }
        }
        
        function switchEncSubtab(subtab) {
            // Update tab buttons
            document.querySelectorAll('[data-enc-subtab]').forEach(btn => {
                btn.classList.toggle('active', btn.dataset.encSubtab === subtab);
            });
            
            // Update content panels
            document.querySelectorAll('.enc-subtab-content').forEach(panel => {
                panel.classList.remove('active');
                panel.style.display = 'none';
            });
            
            const activePanel = document.getElementById('enc-' + subtab);
            if (activePanel) {
                activePanel.classList.add('active');
                activePanel.style.display = 'block';
            }
        }
        
        // Wire up subtab clicks
        document.addEventListener('DOMContentLoaded', function() {
            document.querySelectorAll('[data-enc-subtab]').forEach(btn => {
                btn.addEventListener('click', () => switchEncSubtab(btn.dataset.encSubtab));
            });
        });

        // === LOAD ENCOUNTER ===
        let isViewingLoadedEncounter = false;
        let lastLiveStats = null;

        function openLoadModal() {
            const container = document.getElementById('loadEncounterList');
            const classFilter = document.getElementById('loadClassFilter');
            
            if (!savedEncounters || savedEncounters.length === 0) {
                classFilter.innerHTML = '<option value="">All Classes</option>';
                container.innerHTML = '<div class="no-data"><div class="no-data-icon">📊</div><div>No saved encounters yet</div></div>';
            } else {
                // Get unique classes from saved encounters
                const usedClasses = new Set();
                savedEncounters.forEach(enc => {
                    usedClasses.add(enc.player_class || 'Unassigned');
                });
                
                // Sort classes alphabetically, with Unassigned at the end
                const sortedClasses = Array.from(usedClasses).sort((a, b) => {
                    if (a === 'Unassigned') return 1;
                    if (b === 'Unassigned') return -1;
                    return a.localeCompare(b);
                });
                
                // Populate class filter dropdown
                classFilter.innerHTML = '<option value="">All Classes</option>' + 
                    sortedClasses.map(c => `<option value="${c}">${c} (${savedEncounters.filter(e => (e.player_class || 'Unassigned') === c).length})</option>`).join('');
                
                // Reset filter and render all
                classFilter.value = '';
                renderLoadEncounterList('');
            }
            
            document.getElementById('loadModal').classList.add('active');
        }
        
        function filterLoadEncountersByClass() {
            const selectedClass = document.getElementById('loadClassFilter').value;
            renderLoadEncounterList(selectedClass);
        }
        
        function renderLoadEncounterList(filterClass) {
            const container = document.getElementById('loadEncounterList');
            
            // Filter encounters by class
            let filtered = savedEncounters;
            if (filterClass) {
                filtered = savedEncounters.filter(enc => {
                    const encClass = enc.player_class || 'Unassigned';
                    return encClass === filterClass;
                });
            }
            
            if (filtered.length === 0) {
                container.innerHTML = '<div class="no-data"><div class="no-data-icon">📊</div><div>No encounters for this class</div></div>';
                return;
            }
            
            // Group by class for display
            const groupedByClass = {};
            filtered.forEach(enc => {
                const className = enc.player_class || 'Unassigned';
                if (!groupedByClass[className]) groupedByClass[className] = [];
                groupedByClass[className].push(enc);
            });
            
            // Sort class names
            const sortedClasses = Object.keys(groupedByClass).sort((a, b) => {
                if (a === 'Unassigned') return 1;
                if (b === 'Unassigned') return -1;
                return a.localeCompare(b);
            });
            
            let html = '';
            sortedClasses.forEach(className => {
                const classEncounters = groupedByClass[className];
                
                // Only show class header if showing all classes
                if (!filterClass) {
                    html += `
                        <div style="font-size: 0.8rem; font-weight: 600; color: #D96444; text-transform: uppercase; letter-spacing: 0.05em; margin: 16px 0 8px 0; padding-bottom: 4px; border-bottom: 1px solid rgba(217, 100, 68, 0.2);">
                            ${className} (${classEncounters.length})
                        </div>
                    `;
                }
                
                classEncounters.forEach(enc => {
                    const date = new Date(enc.timestamp);
                    const dateStr = date.toLocaleDateString() + ' ' + date.toLocaleTimeString();
                    html += `
                        <div class="load-encounter-item" onclick="loadEncounter('${enc.id}')">
                            <div class="header">
                                <span class="build-tag">${enc.build_tag}</span>
                                <span class="date">${dateStr}</span>
                            </div>
                            ${enc.notes ? `<div style="font-size: 0.8rem; color: #7A8CB8; margin: 4px 0; font-style: italic;">${enc.notes}</div>` : ''}
                            <div class="stats">
                                <span><strong>${formatNumber(Math.round(enc.first_60s?.dps || 0))}</strong> DPS (60s)</span>
                                <span><strong>${formatNumber(enc.overall?.total_damage || 0)}</strong> damage</span>
                                <span><strong>${formatDuration(enc.overall?.duration || 0)}</strong></span>
                                <span><strong>${(enc.first_60s?.crit_rate || 0).toFixed(1)}%</strong> crit</span>
                            </div>
                        </div>
                    `;
                });
            });
            
            container.innerHTML = html;
        }

        function closeLoadModal() {
            document.getElementById('loadModal').classList.remove('active');
        }

        function loadEncounter(id) {
            const enc = savedEncounters.find(e => e.id === id);
            if (!enc) {
                alert('Encounter not found');
                return;
            }
            
            // Save current live stats so we can restore later
            if (!isViewingLoadedEncounter && currentStats) {
                lastLiveStats = currentStats;
            }
            
            // Map saved encounter data to the format updateStats expects
            const overall = enc.overall || {};
            const first60s = enc.first_60s || {};
            
            // Calculate counts from hit_count and rates (estimates)
            const overallHitCount = overall.hit_count || 0;
            const estCritCount = Math.round(overallHitCount * (overall.crit_rate || 0) / 100);
            const estHeavyCount = Math.round(overallHitCount * (overall.heavy_rate || 0) / 100);
            const estCritHeavyCount = Math.round(overallHitCount * (overall.crit_heavy_rate || 0) / 100);
            const estNormalCount = Math.max(0, overallHitCount - estCritCount - estHeavyCount + estCritHeavyCount);
            
            const loadedData = {
                // Main stats
                dps: overall.dps || 0,
                dps_60s: first60s.dps || 0,
                damage_60s: first60s.total_damage || 0,
                total_damage: overall.total_damage || 0,
                duration: overall.duration || 0,
                duration_60s: first60s.duration || 60,
                
                // Hit counts
                hit_count: overall.hit_count || 0,
                hit_count_60s: first60s.hit_count || 0,
                
                // Estimated counts (for Full Encounter tab display)
                crit_count: estCritCount,
                heavy_count: estHeavyCount,
                crit_heavy_count: estCritHeavyCount,
                normal_count: estNormalCount,
                
                // Overall rates (for Full Encounter tab)
                normal_rate: 100 - (overall.crit_rate || 0) - (overall.heavy_rate || 0) + (overall.crit_heavy_rate || 0),
                normal_damage: Math.max(0, (overall.total_damage || 0) - (overall.crit_damage || 0) - (overall.heavy_damage || 0) + (overall.crit_heavy_damage || 0)),
                crit_rate: overall.crit_rate || 0,
                crit_damage: overall.crit_damage || 0,
                heavy_rate: overall.heavy_rate || 0,
                heavy_damage: overall.heavy_damage || 0,
                crit_heavy_rate: overall.crit_heavy_rate || 0,
                crit_heavy_damage: overall.crit_heavy_damage || 0,
                
                // Raw rates (same as regular for loaded encounters)
                raw_crit_rate: overall.crit_rate || 0,
                raw_heavy_rate: overall.heavy_rate || 0,
                raw_crit_heavy_rate: overall.crit_heavy_rate || 0,
                
                // 60s rates (for header stats)
                crit_rate_60s: first60s.crit_rate || 0,
                crit_damage_60s: first60s.crit_damage || 0,
                heavy_rate_60s: first60s.heavy_rate || 0,
                heavy_damage_60s: first60s.heavy_damage || 0,
                crit_heavy_rate_60s: first60s.crit_heavy_rate || 0,
                crit_heavy_damage_60s: first60s.crit_heavy_damage || 0,
                
                // Skills (use first_60s for detailed view since that's what we save)
                skills: overall.skills || first60s.skills || [],
                skills_60s: first60s.skills || [],  // For weapon breakdown (60s stats)
                
                // Top hits
                top_hits: overall.top_hits || first60s.top_hits || [],
                top_hits_60s: first60s.top_hits || [],
                
                // Rotation (only available in first_60s)
                rotation_60s: first60s.rotation || [],
                
                // Gap stats
                gap_stats: first60s.gap_stats || {},
                
                // Targets - use saved targets if available, otherwise empty
                targets: overall.targets || enc.targets || [],
                hit_log: first60s.rotation || [],
                
                // Primary target from saved encounter
                primary_target: enc.primary_target || 'Unknown',
                
                // Time display
                first_hit: new Date(enc.timestamp).toLocaleTimeString(),
                last_hit: '(loaded)'
            };
            
            // Compute timeline from rotation data for DPS chart
            const computedTimeline = [];
            for (let i = 0; i <= 60; i++) computedTimeline[i] = 0;
            (first60s.rotation || []).forEach(hit => {
                const second = Math.floor(hit.relative_time || 0);
                if (second >= 0 && second <= 60) {
                    computedTimeline[second] = (computedTimeline[second] || 0) + hit.damage;
                }
            });
            loadedData.timeline = computedTimeline;
            
            // Debug logging
            console.log('Loading encounter:', enc.build_tag);
            console.log('Targets in saved data:', overall.targets || 'none');
            
            // Set flag BEFORE updating UI to prevent race condition with WebSocket messages
            isViewingLoadedEncounter = true;
            console.log('isViewingLoadedEncounter set to:', isViewingLoadedEncounter);
            document.getElementById('loadedEncounterName').textContent = enc.build_tag;
            document.getElementById('loadedIndicator').classList.add('active');
            
            // Show sub-tab content (hide placeholders) since we're viewing data
            showSubtabContent(true);
            
            // Update Build Testing left panel to show loaded state
            document.getElementById('buildTestStatsPanel').style.display = 'block';
            document.getElementById('preTestInstructions').style.display = 'none';
            const statusEl = document.getElementById('buildTestStatus');
            if (statusEl) {
                statusEl.textContent = 'Viewing Saved';
                statusEl.style.color = '#5B92D4';
            }
            
            // Now update the UI with loaded encounter data
            updateStats(loadedData);
            
            // IMPORTANT: Keep Log tab showing live data (not loaded encounter data)
            // Refresh it immediately with the saved live stats
            if (lastLiveStats && lastLiveStats.hit_log) {
                updateCombatLog(lastLiveStats.hit_log);
            }
            
            // Close the modal
            closeLoadModal();
        }

        function clearLoadedEncounter() {
            isViewingLoadedEncounter = false;
            document.getElementById('loadedIndicator').classList.remove('active');
            
            // If no active test, hide sub-tab content and show placeholders
            if (!buildTestActive && !buildTestComplete) {
                showSubtabContent(false);
                document.getElementById('buildTestStatsPanel').style.display = 'none';
                document.getElementById('preTestInstructions').style.display = 'block';
                const statusEl = document.getElementById('buildTestStatus');
                if (statusEl) {
                    statusEl.textContent = 'Ready';
                    statusEl.style.color = '#7A8CB8';
                }
            }
            
            // Restore last live stats if available
            if (lastLiveStats) {
                updateStats(lastLiveStats);
            } else {
                // Clear to empty state
                document.getElementById('dpsValue').textContent = '0';
                document.getElementById('totalDamage').textContent = '0';
                document.getElementById('duration').textContent = '0s';
            }
        }

        function saveEncounter() {
            const buildTag   = document.getElementById('buildTagInput').value.trim();
            const notes      = document.getElementById('encounterNotes').value.trim();
            const classValue = document.getElementById('saveClassSelect').value;

            if (!buildTag) { alert('Please enter a build tag'); return; }

            selectedClass = classValue;
            const classInfo = TL_CLASSES.find(c => c.name === classValue);

            if (saveSource === 'encounter' && saveSourceEncounter) {
                const enc    = saveSourceEncounter;
                const pct    = parseFloat(document.getElementById('contributionPct').value) || null;
                const bossHp = pct ? Math.round(enc.total_damage / (pct / 100)) : null;

                // Encode contribution into notes prefix so backend stores it
                let fullNotes = notes;
                if (pct) {
                    fullNotes = `[CONTRIB:${pct}:${bossHp}]${notes ? ' ' + notes : ''}`;
                }

                // Store pending save data for after encounter_loaded fires
                pendingEncounterSave = {
                    buildTag, classValue, notes: fullNotes,
                    class_weapons: classInfo ? classInfo.weapons : ''
                };
                savingFromEncounterHistory = true;

                // Disable save button to prevent double-tap
                const saveBtn = document.querySelector('#saveModal .btn-primary');
                if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Loading…'; }

                // Step 1: load encounter into backend live buffer
                sendCommand('load_encounter_data', {
                    target_name: enc.target_name,
                    start_time:  enc.start_time
                });

            } else {
                // Normal Build Testing save
                sendCommand('save_encounter', {
                    build_tag:     buildTag,
                    notes:         notes,
                    player_class:  classValue,
                    class_weapons: classInfo ? classInfo.weapons : ''
                });
            }
        }

        function deleteEncounter(id, event) {
            event.stopPropagation();
            if (confirm('Delete this encounter?')) {
                sendCommand('delete_encounter', { id: id });
            }
        }

        function editEncounter(id, event) {
            event.stopPropagation();
            
            // Find the encounter
            const enc = savedEncounters.find(e => e.id === id);
            if (!enc) {
                alert('Encounter not found');
                return;
            }
            
            // Populate the edit modal
            document.getElementById('editEncounterId').value = id;
            document.getElementById('editBuildTagInput').value = enc.build_tag || '';
            document.getElementById('editEncounterNotes').value = enc.notes || '';
            
            // Populate class dropdown
            const classSelect = document.getElementById('editClassSelect');
            classSelect.innerHTML = '<option value="">-- Select Class --</option>' + 
                TL_CLASSES.map(c => `<option value="${c.name}">${c.name}: ${c.weapons}</option>`).join('');
            
            // Set current class if exists
            if (enc.player_class) {
                classSelect.value = enc.player_class;
            }
            
            // Show modal
            document.getElementById('editEncounterModal').classList.add('active');
        }

        function closeEditEncounterModal() {
            document.getElementById('editEncounterModal').classList.remove('active');
        }

