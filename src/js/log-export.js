        function showExportToast() {
            const toast = document.createElement('div');
            toast.className = 'export-toast';
            toast.textContent = '✔ Copied to clipboard!';
            document.body.appendChild(toast);
            setTimeout(() => toast.remove(), 2500);
        }

        // === SAVED ENCOUNTERS ===

        function updateSavedEncountersList() {
            const container = document.getElementById('savedEncountersList');
            const filterClass = document.getElementById('filterClass').value;
            const filterBuild = document.getElementById('filterBuild').value;
            
            let filtered = savedEncounters;
            
            // Filter by class
            if (filterClass) {
                filtered = filtered.filter(e => {
                    const encClass = e.player_class || 'Unassigned';
                    return encClass === filterClass;
                });
            }
            
            // Filter by build
            if (filterBuild) {
                filtered = filtered.filter(e => e.build_tag === filterBuild);
            }
            
            document.getElementById('savedCount').textContent = `${filtered.length} saved encounter${filtered.length !== 1 ? 's' : ''}`;
            
            if (filtered.length === 0) {
                const msg = filterClass || filterBuild ? 'No encounters match filters' : 'No saved encounters yet';
                container.innerHTML = `<div class="no-data"><div class="no-data-icon">📊</div><div>${msg}</div></div>`;
                return;
            }
            
            // Group encounters by class
            const groupedByClass = {};
            filtered.forEach(enc => {
                const className = enc.player_class || 'Unassigned';
                if (!groupedByClass[className]) groupedByClass[className] = [];
                groupedByClass[className].push(enc);
            });
            
            // Sort class names (Unassigned last)
            const sortedClasses = Object.keys(groupedByClass).sort((a, b) => {
                if (a === 'Unassigned') return 1;
                if (b === 'Unassigned') return -1;
                return a.localeCompare(b);
            });
            
            let html = '';
            sortedClasses.forEach(className => {
                const classEncounters = groupedByClass[className];
                
                // Only show class header if not filtering by a specific class
                const showHeader = !filterClass;
                
                html += `
                    <div class="saved-class-group">
                        ${showHeader ? `
                            <div class="saved-class-header">
                                <span class="saved-class-name">${className}</span>
                                <span class="saved-class-count">${classEncounters.length}</span>
                            </div>
                        ` : ''}
                        ${classEncounters.map(enc => {
                            // Normalize dual schema (BT saves vs Encounter saves)
                            const isBTSave  = !!enc.first_60s;
                            const dps       = isBTSave ? (enc.first_60s?.dps || 0)          : (enc.dps || 0);
                            const totalDmg  = isBTSave ? (enc.overall?.total_damage || 0)   : (enc.total_damage || 0);
                            const duration  = isBTSave ? (enc.overall?.duration || 0)       : (enc.duration || 0);
                            const critRate  = isBTSave ? (enc.first_60s?.crit_rate || 0)    : (enc.crit_rate || 0);
                            const target    = isBTSave ? (enc.primary_target || '--')       : (enc.target_name || '--');
                            const dpsLabel  = isBTSave ? '1-Min DPS' : 'DPS';
                            const cat       = enc.category || (isBTSave ? 'training' : '');
                            const catLabel  = cat.replace(/_/g,' ').replace(/\b\w/g,c=>c.toUpperCase());
                            const catColor  = cat.includes('arch') ? '#ef4444' : cat.includes('field') ? '#fbbf24' : cat.includes('raid') ? '#f472b6' : '#64748b';
                            // Parse contribution info out of notes
                            const { contribPct, bossHp, cleanNotes } = parseContribNotes(enc.notes);
                            const contribHtml = contribPct
                                ? `<div class="encounter-stat" style="color:#5B92D4;">
                                       <strong>${contribPct.toFixed(1)}%</strong> contribution
                                       ${bossHp ? `<span style="color:#64748b;font-size:0.72rem;"> · Boss HP ≈ ${formatNumber(bossHp)}</span>` : ''}
                                   </div>` : '';
                            return `
                            <div class="encounter-item" data-id="${enc.id}">
                                <div class="encounter-header">
                                    <span class="encounter-build">${enc.build_tag}</span>
                                    ${catLabel ? `<span style="font-size:0.62rem;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;padding:2px 6px;border-radius:3px;background:${catColor}22;color:${catColor};border:1px solid ${catColor}44;margin-left:6px;">${catLabel}</span>` : ''}
                                    <span class="encounter-date" style="margin-left: auto;">${formatDate(enc.timestamp)}</span>
                                </div>
                                ${cleanNotes ? `<div style="font-size: 0.8rem; color: #94a3b8; margin: 4px 0 8px 0; font-style: italic; padding-left: 8px; border-left: 2px solid #334155;">${cleanNotes}</div>` : ''}
                                <div class="encounter-stats">
                                    <div class="encounter-stat highlight">
                                        <strong>${formatNumber(Math.round(dps))}</strong> ${dpsLabel}
                                    </div>
                                    <div class="encounter-stat">
                                        <strong>${formatNumber(totalDmg)}</strong> total
                                    </div>
                                    <div class="encounter-stat">
                                        <strong>${formatDuration(duration)}</strong>
                                    </div>
                                    <div class="encounter-stat">
                                        <strong>${critRate.toFixed(1)}%</strong> crit
                                    </div>
                                    ${contribHtml}
                                </div>
                                <div class="encounter-target">⚖️ ${target}</div>
                                <div class="encounter-actions">
                                    <button class="btn btn-small" onclick="editEncounter('${enc.id}', event)">✏️ Edit</button>
                                    <button class="btn btn-small btn-danger" onclick="deleteEncounter('${enc.id}', event)">🗑️ Delete</button>
                                </div>
                            </div>`}).join('')}
                    </div>
                `;
            });
            
            container.innerHTML = html;
        }

        function updateClassFilters() {
            const filterSelect = document.getElementById('filterClass');
            const currentValue = filterSelect.value;
            
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
            
            filterSelect.innerHTML = '<option value="">All Classes</option>' +
                sortedClasses.map(c => {
                    const count = savedEncounters.filter(e => (e.player_class || 'Unassigned') === c).length;
                    return `<option value="${c}">${c} (${count})</option>`;
                }).join('');
            
            // Restore previous selection if still valid
            if (usedClasses.has(currentValue)) {
                filterSelect.value = currentValue;
            }
        }

        function updateBuildFilters() {
            const filterSelect = document.getElementById('filterBuild');
            const currentValue = filterSelect.value;
            const visible = visibleBuildTags();

            filterSelect.innerHTML = '<option value="">All Builds</option>' +
                visible.map(tag => `<option value="${tag}">${tag}</option>`).join('');

            if (visible.includes(currentValue)) {
                filterSelect.value = currentValue;
            }
        }

        // === COMPARISON - BUILD-BASED ===
        
        // State: Track which encounters are assigned to each build
        let buildAssignments = {
            A: [],  // Array of encounter IDs
            B: [],
            C: []
        };
        
        function addRunToBuild(buildLetter) {
            if (savedEncounters.length === 0) {
                alert('No saved encounters available. Save an encounter first!');
                return;
            }
            
            // Create modal for selecting encounter
            const modal = document.createElement('div');
            modal.style.cssText = `
                position: fixed;
                top: 0;
                left: 0;
                right: 0;
                bottom: 0;
                background: rgba(0, 0, 0, 0.8);
                display: flex;
                align-items: center;
                justify-content: center;
                z-index: 10000;
            `;
            
            const dialog = document.createElement('div');
            dialog.style.cssText = `
                background: #1e293b;
                border: 1px solid #334155;
                border-radius: 12px;
                padding: 24px;
                max-width: 600px;
                max-height: 80vh;
                overflow-y: auto;
                width: 90%;
            `;
            
            // Filter out already assigned encounters to this build
            const assignedIds = buildAssignments[buildLetter];
            const availableEncounters = savedEncounters.filter(enc => !assignedIds.includes(enc.id));
            
            if (availableEncounters.length === 0) {
                alert(`All encounters already added to Build ${buildLetter}!`);
                return;
            }
            
            // Group encounters by class
            const groupedByClass = {};
            availableEncounters.forEach(enc => {
                const className = enc.player_class || 'Unassigned';
                if (!groupedByClass[className]) groupedByClass[className] = [];
                groupedByClass[className].push(enc);
            });
            
            // Sort class names (Unassigned last)
            const sortedClasses = Object.keys(groupedByClass).sort((a, b) => {
                if (a === 'Unassigned') return 1;
                if (b === 'Unassigned') return -1;
                return a.localeCompare(b);
            });
            
            let encountersHtml = '';
            sortedClasses.forEach(className => {
                const classEncounters = groupedByClass[className];
                encountersHtml += `
                    <div style="margin-top: 12px;">
                        <div style="font-size: 0.8rem; font-weight: 600; color: #D96444; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 8px; padding-bottom: 4px; border-bottom: 1px solid rgba(217, 100, 68, 0.2);">
                            ${className} (${classEncounters.length})
                        </div>
                        ${classEncounters.map(enc => `
                            <div class="encounter-select-item" data-id="${enc.id}" style="
                                background: rgba(30, 41, 59, 0.5);
                                border: 1px solid #334155;
                                border-radius: 8px;
                                padding: 12px;
                                margin-bottom: 8px;
                                cursor: pointer;
                                transition: all 0.2s;
                            ">
                                <div style="font-weight: 600; color: #e2e8f0; margin-bottom: 4px;">${enc.build_tag}</div>
                                <div style="display: flex; gap: 16px; font-size: 0.85rem;">
                                    <span style="color: #D96444; font-weight: 600;">${formatNumber(Math.round(enc.first_60s.dps))} DPS</span>
                                    <span style="color: #94a3b8;">${formatNumber(enc.first_60s.total_damage)} dmg</span>
                                    <span style="color: #64748b;">${formatDate(enc.timestamp)}</span>
                                </div>
                                ${enc.notes ? `<div style="font-size: 0.8rem; color: #94a3b8; margin-top: 6px; font-style: italic; padding-left: 8px; border-left: 2px solid #334155;">${enc.notes}</div>` : ''}
                            </div>
                        `).join('')}
                    </div>
                `;
            });
            
            dialog.innerHTML = `
                <h3 style="color: #5B92D4; margin-bottom: 16px;">Select Encounter for Build ${buildLetter}</h3>
                <div style="display: flex; flex-direction: column;">
                    ${encountersHtml}
                </div>
                <button onclick="this.closest('[style*=fixed]').remove()" style="
                    margin-top: 16px;
                    padding: 8px 16px;
                    background: rgba(239, 68, 68, 0.2);
                    border: 1px solid #ef4444;
                    color: #ef4444;
                    border-radius: 6px;
                    cursor: pointer;
                    width: 100%;
                ">Cancel</button>
            `;
            
            // Add click handlers
            dialog.querySelectorAll('.encounter-select-item').forEach(item => {
                item.addEventListener('mouseenter', () => {
                    item.style.borderColor = '#D96444';
                    item.style.background = 'rgba(217, 100, 68, 0.1)';
                });
                item.addEventListener('mouseleave', () => {
                    item.style.borderColor = '#334155';
                    item.style.background = 'rgba(30, 41, 59, 0.5)';
                });
                item.addEventListener('click', () => {
                    const encId = item.getAttribute('data-id');
                    buildAssignments[buildLetter].push(encId);
                    modal.remove();
                    updateBuildDisplay();
                    updateComparison();
                });
            });
            
            modal.appendChild(dialog);
            document.body.appendChild(modal);
            
            // Close on backdrop click
            modal.addEventListener('click', (e) => {
                if (e.target === modal) modal.remove();
            });
        }
        
        function removeRunFromBuild(buildLetter, encId) {
            buildAssignments[buildLetter] = buildAssignments[buildLetter].filter(id => id !== encId);
            updateBuildDisplay();
            updateComparison();
        }
        
        function clearCompareBuilds() {
            // Confirm if there are any assignments
            const totalAssigned = buildAssignments.A.length + buildAssignments.B.length + buildAssignments.C.length;
            
            if (totalAssigned === 0) {
                return; // Nothing to clear
            }
            
            if (!confirm('Clear all builds from comparison?')) {
                return;
            }
            
            // Reset all build assignments
            buildAssignments = {
                A: [],
                B: [],
                C: []
            };
            
            // Update UI
            updateBuildDisplay();
            updateComparison();
            
            // Switch to Select Builds section
            switchCompareSection('select');
        }
        
        function updateBuildDisplay() {
            // First, calculate all build averages for cross-build comparison
            const buildAverages = {};
            ['A', 'B', 'C'].forEach(letter => {
                const encIds = buildAssignments[letter];
                if (encIds.length === 0) {
                    buildAverages[letter] = null;
                    return;
                }
                
                const encounters = encIds.map(id => savedEncounters.find(e => e.id === id)).filter(Boolean);
                const count = encounters.length;
                
                // Calculate burst for each encounter
                const burstValues = encounters.map(e => calculate5SecBurst(e.first_60s.rotation || []));
                
                buildAverages[letter] = {
                    dps: encounters.reduce((sum, e) => sum + e.first_60s.dps, 0) / count,
                    damage: encounters.reduce((sum, e) => sum + e.first_60s.total_damage, 0) / count,
                    hits: encounters.reduce((sum, e) => sum + e.first_60s.hit_count, 0) / count,
                    critRate: encounters.reduce((sum, e) => sum + e.first_60s.crit_rate, 0) / count,
                    heavyRate: encounters.reduce((sum, e) => sum + e.first_60s.heavy_rate, 0) / count,
                    burst5s: burstValues.reduce((sum, b) => sum + b, 0) / count
                };
            });
            
            // Find highest averages across all builds
            const validAverages = Object.values(buildAverages).filter(Boolean);
            const maxAvgDps = validAverages.length > 0 ? Math.max(...validAverages.map(a => a.dps)) : 0;
            const maxAvgDamage = validAverages.length > 0 ? Math.max(...validAverages.map(a => a.damage)) : 0;
            const maxAvgHits = validAverages.length > 0 ? Math.max(...validAverages.map(a => a.hits)) : 0;
            const maxAvgCritRate = validAverages.length > 0 ? Math.max(...validAverages.map(a => a.critRate)) : 0;
            const maxAvgHeavyRate = validAverages.length > 0 ? Math.max(...validAverages.map(a => a.heavyRate)) : 0;
            const maxAvgBurst5s = validAverages.length > 0 ? Math.max(...validAverages.map(a => a.burst5s)) : 0;
            
            // Check for DPS ties
            const dpsWinners = ['A', 'B', 'C'].filter(letter => {
                const avg = buildAverages[letter];
                return avg && avg.dps === maxAvgDps;
            });
            const isDpsTied = dpsWinners.length > 1;
            
            ['A', 'B', 'C'].forEach(letter => {
                const container = document.getElementById(`build${letter}-runs`);
                const column = document.querySelector(`#build${letter}-runs`).closest('.compare-build-column');
                const encIds = buildAssignments[letter];
                
                if (encIds.length === 0) {
                    container.innerHTML = '<div class="compare-empty-state">No runs selected</div>';
                    // Remove any winner styling
                    if (column) {
                        column.classList.remove('winner-build', 'tied-build');
                    }
                    return;
                }
                
                const encounters = encIds.map(id => savedEncounters.find(e => e.id === id)).filter(Boolean);
                const bestDps = Math.max(...encounters.map(e => e.first_60s.dps));
                const avg = buildAverages[letter];
                
                // Apply winner/tied styling to the entire build column
                if (column) {
                    column.classList.remove('winner-build', 'tied-build');
                    if (avg.dps === maxAvgDps) {
                        if (isDpsTied) {
                            column.classList.add('tied-build');
                        } else {
                            column.classList.add('winner-build');
                        }
                    }
                }
                
                // Individual runs
                let runsHtml = encounters.map(enc => {
                    const stats = enc.first_60s;
                    const isBest = stats.dps === bestDps;
                    
                    return `
                        <div class="compare-run-item ${isBest ? 'best-run' : ''}">
                            ${isBest ? '<div class="compare-run-best-badge">BEST</div>' : ''}
                            <div class="compare-run-remove" onclick="removeRunFromBuild('${letter}', '${enc.id}')" title="Remove">×</div>
                            <div class="compare-run-tag">${enc.build_tag}</div>
                            <div class="compare-run-stats-grid">
                                <div class="run-stat">
                                    <div class="run-stat-label">DPS</div>
                                    <div class="run-stat-value highlight">${formatNumber(Math.round(stats.dps))}</div>
                                </div>
                                <div class="run-stat">
                                    <div class="run-stat-label">Damage</div>
                                    <div class="run-stat-value">${formatNumber(stats.total_damage)}</div>
                                </div>
                                <div class="run-stat">
                                    <div class="run-stat-label">Hits</div>
                                    <div class="run-stat-value">${stats.hit_count}</div>
                                </div>
                                <div class="run-stat">
                                    <div class="run-stat-label">Crit %</div>
                                    <div class="run-stat-value">${stats.crit_rate.toFixed(1)}%</div>
                                </div>
                                <div class="run-stat">
                                    <div class="run-stat-label">Heavy %</div>
                                    <div class="run-stat-value">${stats.heavy_rate.toFixed(1)}%</div>
                                </div>
                            </div>
                        </div>
                    `;
                }).join('');
                
                // Build average summary (no crown emojis here)
                const isDpsHighest = avg.dps === maxAvgDps;
                const isDamageHighest = avg.damage === maxAvgDamage;
                const isHitsHighest = avg.hits === maxAvgHits;
                const isCritRateHighest = avg.critRate === maxAvgCritRate;
                const isHeavyRateHighest = avg.heavyRate === maxAvgHeavyRate;
                const isBurst5sHighest = avg.burst5s === maxAvgBurst5s;
                
                const averageHtml = `
                    <div class="compare-build-average">
                        <div class="compare-build-average-header">
                            <span class="average-icon">📊</span>
                            <span class="average-title">Build Average</span>
                            <span class="average-count">${encounters.length} run${encounters.length !== 1 ? 's' : ''}</span>
                        </div>
                        <div class="compare-build-average-stats">
                            <div class="avg-stat ${isDpsHighest ? 'highest-dps' : ''}">
                                <div class="avg-stat-label">Avg DPS</div>
                                <div class="avg-stat-value">${formatNumber(Math.round(avg.dps))}</div>
                            </div>
                            <div class="avg-stat ${isBurst5sHighest ? 'highest-burst' : ''}">
                                <div class="avg-stat-label">Avg 5s Burst</div>
                                <div class="avg-stat-value">${formatNumber(Math.round(avg.burst5s))}</div>
                            </div>
                            <div class="avg-stat ${isDamageHighest ? 'highest' : ''}">
                                <div class="avg-stat-label">Avg Damage</div>
                                <div class="avg-stat-value">${formatNumber(Math.round(avg.damage))}</div>
                            </div>
                            <div class="avg-stat ${isHitsHighest ? 'highest' : ''}">
                                <div class="avg-stat-label">Avg Hits</div>
                                <div class="avg-stat-value">${Math.round(avg.hits)}</div>
                            </div>
                            <div class="avg-stat ${isCritRateHighest ? 'highest' : ''}">
                                <div class="avg-stat-label">Avg Crit %</div>
                                <div class="avg-stat-value">${avg.critRate.toFixed(1)}%</div>
                            </div>
                            <div class="avg-stat ${isHeavyRateHighest ? 'highest' : ''}">
                                <div class="avg-stat-label">Avg Heavy %</div>
                                <div class="avg-stat-value">${avg.heavyRate.toFixed(1)}%</div>
                            </div>
                        </div>
                    </div>
                `;
                
                container.innerHTML = runsHtml + averageHtml;
            });
        }

        // Filter out internal session queue placeholder tags from any UI
        function visibleBuildTags() {
            return buildTags.filter(t => !/^__sq_/.test(t));
        }

        function updateRecentBuildTags() {
            const container = document.getElementById('recentBuildTags');
            const visible = visibleBuildTags();
            if (visible.length === 0) {
                container.innerHTML = '';
                return;
            }
            container.innerHTML = visible.slice(0, 8).map(tag =>
                `<span class="build-tag" onclick="selectBuildTag('${tag}')">${tag}</span>`
            ).join('');
        }

        function selectBuildTag(tag) {
            document.getElementById('buildTagInput').value = tag;
            document.querySelectorAll('.build-tag').forEach(el => {
                el.classList.toggle('selected', el.textContent === tag);
            });
        }

        // === COMPARISON ===
        
        // Helper function to calculate peak 5-second burst DPS from rotation data
        function calculate5SecBurst(rotation) {
            if (!rotation || rotation.length === 0) return 0;
            
            // Build damage per second
            const dpsPerSecond = {};
            rotation.forEach(hit => {
                const sec = Math.floor(hit.relative_time);
                if (sec <= 60) {
                    dpsPerSecond[sec] = (dpsPerSecond[sec] || 0) + hit.damage;
                }
            });
            
            // Calculate 5-second rolling DPS (positions 0-55)
            let peakBurst = 0;
            for (let i = 0; i <= 55; i++) {
                let sum = 0;
                for (let j = i; j < i + 5; j++) {
                    sum += dpsPerSecond[j] || 0;
                }
                const avgDps = sum / 5;
                if (avgDps > peakBurst) {
                    peakBurst = avgDps;
                }
            }
            
            return peakBurst;
        }
        
        function switchCompareSection(section) {
            // Update sidebar tabs
            document.querySelectorAll('.compare-sidebar-tab').forEach(tab => {
                tab.classList.toggle('active', tab.dataset.section === section);
            });
            
            // Update content sections
            document.querySelectorAll('.compare-section').forEach(sec => {
                sec.classList.remove('active');
            });
            document.getElementById(`compare-section-${section}`).classList.add('active');
        }

        function updateComparison() {
            const rankingContainer = document.getElementById('compareRankingPreview');
            const skillsContainer = document.getElementById('compareSkillsContent');
            const timelineContainer = document.getElementById('compareTimelineContent');
            const rotationContainer = document.getElementById('compareRotationContent');
            
            // Get builds that have at least one encounter
            const buildsWithData = ['A', 'B', 'C'].filter(letter => buildAssignments[letter].length > 0);
            
            // Need at least 2 builds
            if (buildsWithData.length < 2) {
                rankingContainer.innerHTML = '<div class="no-data"><div class="no-data-icon">⚖️</div><div>Select encounters for at least two builds to compare</div></div>';
                skillsContainer.innerHTML = '<div class="no-data"><div class="no-data-icon">💥</div><div>Select builds first to see skill breakdown</div></div>';
                timelineContainer.innerHTML = '<div class="no-data"><div class="no-data-icon">🎹</div><div>Select builds first to see skill timeline</div></div>';
                rotationContainer.innerHTML = '<div class="no-data"><div class="no-data-icon">📊</div><div>Select builds first to see rotation analysis</div></div>';
                return;
            }
            
            // Get all encounters for each build
            const buildsData = buildsWithData.map(letter => {
                const encIds = buildAssignments[letter];
                const encounters = encIds.map(id => savedEncounters.find(e => e.id === id)).filter(Boolean);
                
                // Find best encounter (highest DPS)
                const bestEnc = encounters.reduce((best, enc) => 
                    enc.first_60s.dps > best.first_60s.dps ? enc : best
                , encounters[0]);
                
                return {
                    label: `Build ${letter}`,
                    letter: letter,
                    allEncounters: encounters,
                    bestEncounter: bestEnc,
                    stats: bestEnc.first_60s
                };
            });
            
            // For backward compatibility with existing comparison rendering
            const encounters = buildsData.map(build => ({
                label: build.label,
                enc: build.bestEncounter,
                stats: build.stats
            }));
            
            const encA = encounters[0]?.enc;
            const encB = encounters[1]?.enc;
            
            // Sort by DPS (descending) to determine ranking
            const ranked = [...encounters].sort((a, b) => b.stats.dps - a.stats.dps);
            const topDps = ranked[0].stats.dps;
            const maxDps = topDps || 1;
            
            // Determine actual ranks accounting for ties
            // Encounters with the same DPS get the same rank
            let currentRank = 1;
            let previousDps = null;
            const ranksWithTies = ranked.map((data, idx) => {
                if (previousDps !== null && data.stats.dps < previousDps) {
                    currentRank = idx + 1;  // Skip to actual position
                }
                previousDps = data.stats.dps;
                return { ...data, rank: currentRank };
            });
            
            // Find all winners (those tied for first place)
            const winners = ranksWithTies.filter(d => d.rank === 1);
            const isTied = winners.length > 1;
            const winnerLabels = winners.map(w => w.label);
            
            // For backward compatibility
            const winnerLabel = ranked[0].label;
            const winnerEnc = ranked[0].enc;
            
            // === HELPER FUNCTIONS ===
            
            function calculateRotationStats(rotation) {
                if (!rotation || rotation.length === 0) return null;
                
                const dpsPerSecond = {};
                for (let i = 0; i <= 60; i++) dpsPerSecond[i] = 0;
                
                rotation.forEach(hit => {
                    const sec = Math.floor(hit.relative_time || 0);
                    if (sec <= 60) dpsPerSecond[sec] += hit.damage;
                });
                
                const segments = [
                    { label: '0-15s', start: 0, end: 15 },
                    { label: '15-30s', start: 15, end: 30 },
                    { label: '30-45s', start: 30, end: 45 },
                    { label: '45-60s', start: 45, end: 60 }
                ];
                
                const segmentStats = segments.map(seg => {
                    const segHits = rotation.filter(h => h.relative_time >= seg.start && h.relative_time < seg.end);
                    const segDamage = segHits.reduce((sum, h) => sum + h.damage, 0);
                    return { ...seg, damage: segDamage, dps: segDamage / 15, hits: segHits.length };
                });
                
                const firstHitTime = Math.floor(rotation[0]?.relative_time || 0);
                const lastHitTime = Math.floor(rotation[rotation.length - 1]?.relative_time || 0);
                const activeSeconds = Object.entries(dpsPerSecond)
                    .filter(([i, d]) => d > 0 && parseInt(i) >= firstHitTime && parseInt(i) <= lastHitTime).length;
                const totalSeconds = Math.max(1, lastHitTime - firstHitTime + 1);
                const activityRate = (activeSeconds / totalSeconds * 100);
                
                const rollingDps = [];
                for (let i = 0; i <= 55; i++) {
                    let sum = 0;
                    for (let j = i; j < i + 5; j++) sum += dpsPerSecond[j] || 0;
                    rollingDps.push(sum / 5);
                }
                const peakDps = Math.max(...rollingDps);
                
                return { dpsPerSecond, segmentStats, activityRate, peakDps, firstHitTime, lastHitTime };
            }
            
            // Calculate rotation stats for all encounters
            const rotationData = encounters.map(e => ({
                ...e,
                rotationStats: calculateRotationStats(e.stats.rotation || [])
            }));
            
            // Find max chart DPS for scaling
            let maxChartDps = 1;
            rotationData.forEach(e => {
                if (e.rotationStats) {
                    maxChartDps = Math.max(maxChartDps, ...Object.values(e.rotationStats.dpsPerSecond));
                }
            });
            
            function renderRotationChart(data, isWinner) {
                const { label, enc, rotationStats: stats } = data;
                if (!stats) {
                    return `<div class="compare-rotation-chart-wrapper">
                        <div class="compare-rotation-chart-label">
                            <span class="build-name">${label}: ${enc.build_tag}</span>
                        </div>
                        <div style="text-align: center; color: #64748b; padding: 20px;">No rotation data saved</div>
                    </div>`;
                }
                
                let barsHtml = '';
                for (let i = 0; i <= 60; i++) {
                    const damage = stats.dpsPerSecond[i] || 0;
                    const height = maxChartDps > 0 ? (damage / maxChartDps * 100) : 0;
                    let barClass = 'normal';
                    if (damage === 0 && i >= stats.firstHitTime && i <= stats.lastHitTime) barClass = 'gap-zone';
                    barsHtml += `<div class="compare-rotation-bar ${barClass}" style="height: ${Math.max(height, 1)}%"></div>`;
                }
                
                return `
                    <div class="compare-rotation-chart-wrapper ${isWinner ? 'winner' : ''}">
                        <div class="compare-rotation-chart-label">
                            <span class="build-name">${label}: ${enc.build_tag} ${isWinner ? '👑' : ''}</span>
                            <div class="build-stats">
                                <span>Activity: <span class="value">${stats.activityRate.toFixed(0)}%</span></span>
                                <span>Peak 5s: <span class="value">${formatNumber(Math.round(stats.peakDps))}</span></span>
                            </div>
                        </div>
                        <div class="compare-rotation-mini-chart">${barsHtml}</div>
                        <div class="compare-rotation-xaxis">
                            <span>0s</span><span>15s</span><span>30s</span><span>45s</span><span>60s</span>
                        </div>
                    </div>
                `;
            }
            
            function renderComparePianoRoll(data, isWinner) {
                const { label, enc, stats } = data;
                const rotation = stats.rotation || [];
                
                if (rotation.length === 0) {
                    return `
                        <div class="compare-piano-wrapper">
                            <div class="compare-piano-label">
                                <span class="build-name">${label}: ${enc.build_tag}</span>
                            </div>
                            <div style="text-align: center; color: #64748b; padding: 20px; font-size: 0.8rem;">
                                No rotation data saved
                            </div>
                        </div>
                    `;
                }
                
                const skillHits = {};
                const skillDamage = {};
                
                rotation.forEach(hit => {
                    const skill = hit.skill || 'Unknown';
                    if (!skillHits[skill]) { skillHits[skill] = []; skillDamage[skill] = 0; }
                    skillHits[skill].push(hit);
                    skillDamage[skill] += hit.damage;
                });
                
                const sortedSkills = Object.keys(skillHits).sort((a, b) => skillDamage[b] - skillDamage[a]);
                
                let rowsHtml = '';
                sortedSkills.forEach(skill => {
                    const hits = skillHits[skill];
                    const damage = skillDamage[skill];
                    const hitCount = hits.length;
                    
                    let hitsHtml = '';
                    hits.forEach(hit => {
                        const leftPercent = ((hit.relative_time || 0) / 60) * 100;
                        let hitClass = 'normal';
                        if (hit.is_crit && hit.is_heavy) hitClass = 'crit-heavy';
                        else if (hit.is_crit) hitClass = 'crit';
                        else if (hit.is_heavy) hitClass = 'heavy';
                        hitsHtml += `<div class="compare-piano-hit ${hitClass}" style="left: ${leftPercent}%"></div>`;
                    });
                    
                    rowsHtml += `
                        <div class="compare-piano-row">
                            <div class="compare-piano-skill" title="${skill} (${hitCount} hits)">
                                <span class="skill-name">${skill}</span>
                                <span class="skill-hit-count">${hitCount}</span>
                            </div>
                            <div class="compare-piano-lane">${hitsHtml}</div>
                            <div class="compare-piano-damage">${formatNumber(damage)}</div>
                        </div>
                    `;
                });
                
                return `
                    <div class="compare-piano-wrapper ${isWinner ? 'winner' : ''}">
                        <div class="compare-piano-label">
                            <span class="build-name">${label}: ${enc.build_tag} ${isWinner ? '👑' : ''}</span>
                            <span class="skill-count">${sortedSkills.length} skills</span>
                        </div>
                        <div class="compare-piano-roll">${rowsHtml}</div>
                        <div class="compare-piano-time-axis">
                            <span>0s</span><span>15s</span><span>30s</span><span>45s</span><span>60s</span>
                        </div>
                    </div>
                `;
            }
            
            function renderSegmentComparison() {
                const segments = ['0-15s', '15-30s', '30-45s', '45-60s'];
                let html = '<div class="compare-segments-grid">';
                
                segments.forEach((segLabel, idx) => {
                    const segData = rotationData.map(e => ({
                        label: e.label,
                        dps: e.rotationStats?.segmentStats[idx]?.dps || 0
                    }));
                    const maxSegDps = Math.max(...segData.map(s => s.dps), 1);
                    
                    html += `<div class="compare-segment-pair"><div class="segment-label">${segLabel}</div>`;
                    segData.forEach(s => {
                        const isWinner = s.dps === maxSegDps && s.dps > 0;
                        const isLoser = s.dps < maxSegDps && maxSegDps > 0;
                        const barClass = s.label.toLowerCase();  // 'a', 'b', 'c', 'd'
                        html += `
                            <div class="compare-segment-row">
                                <span class="build-tag">${s.label}</span>
                                <div class="dps-bar">
                                    <div class="dps-bar-fill ${barClass}" style="width: ${(s.dps / maxSegDps * 100)}%"></div>
                                </div>
                                <span class="dps-value ${isWinner ? 'winner' : isLoser ? 'loser' : ''}">${formatNumber(Math.round(s.dps))}</span>
                            </div>
                        `;
                    });
                    html += '</div>';
                });
                
                html += '</div>';
                return html;
            }
            
            function renderActivityComparison() {
                let html = '<div class="compare-activity-section">';
                
                rotationData.forEach(e => {
                    const act = e.rotationStats?.activityRate || 0;
                    const actClass = act >= 85 ? '' : act >= 70 ? 'warning' : 'danger';
                    
                    html += `
                        <div class="compare-activity-card">
                            <div class="label">${e.label}: Activity</div>
                            <div class="value ${actClass}">${act.toFixed(0)}%</div>
                        </div>
                    `;
                });
                
                const maxPeak = Math.max(...rotationData.map(r => r.rotationStats?.peakDps || 0));
                rotationData.forEach(e => {
                    const peak = e.rotationStats?.peakDps || 0;
                    const isTop = peak === maxPeak && peak > 0;
                    
                    html += `
                        <div class="compare-activity-card">
                            <div class="label">${e.label}: Peak 5s</div>
                            <div class="value" style="color: ${isTop ? '#22c55e' : '#64748b'}">${formatNumber(Math.round(peak))}</div>
                        </div>
                    `;
                });
                
                html += '</div>';
                return html;
            }
            
            function renderEncounterPanel(data, allEncounters, isWinner) {
                const { label, enc, stats } = data;
                
                // Determine best values for highlighting
                const allDamage = allEncounters.map(e => e.stats.total_damage);
                const allCrit = allEncounters.map(e => e.stats.crit_rate);
                const allHeavy = allEncounters.map(e => e.stats.heavy_rate);
                
                const maxDamage = Math.max(...allDamage);
                const maxCrit = Math.max(...allCrit);
                const maxHeavy = Math.max(...allHeavy);
                const minDamage = Math.min(...allDamage);
                const minCrit = Math.min(...allCrit);
                const minHeavy = Math.min(...allHeavy);
                
                // Build skill comparison map
                const allSkillNames = new Set();
                allEncounters.forEach(e => {
                    e.stats.skills.forEach(s => allSkillNames.add(s.name));
                });
                
                // For each skill, find max/min damage across all encounters that have it
                const skillDamageMap = {};
                allSkillNames.forEach(skillName => {
                    const encountersWithSkill = allEncounters.filter(e => 
                        e.stats.skills.some(s => s.name === skillName)
                    );
                    
                    if (encountersWithSkill.length > 0) {
                        const damages = encountersWithSkill.map(e => {
                            const skill = e.stats.skills.find(s => s.name === skillName);
                            return skill ? skill.damage : 0;
                        });
                        
                        skillDamageMap[skillName] = {
                            max: Math.max(...damages),
                            min: Math.min(...damages),
                            count: encountersWithSkill.length
                        };
                    }
                });
                
                return `
                    <div class="compare-panel ${isWinner ? 'winner-panel' : ''}">
                        <h3>${label}: ${enc.build_tag} ${isWinner ? '👑' : ''}</h3>
                        <div class="date">${formatDate(enc.timestamp)}</div>
                        <div class="compare-dps-display">
                            <div class="compare-dps-value">${formatNumber(Math.round(stats.dps))}</div>
                            <div style="font-size: 0.8rem; color: #64748b;">1-Min DPS</div>
                            <div class="compare-dps-bar">
                                <div class="compare-dps-fill" style="width: ${(stats.dps / maxDps * 100)}%"></div>
                            </div>
                        </div>
                        <div class="compare-stat-row">
                            <span class="compare-stat-label">Damage (60s)</span>
                            <span class="compare-stat-value ${stats.total_damage === maxDamage ? 'winner' : stats.total_damage === minDamage ? 'loser' : ''}">${formatNumber(stats.total_damage)}</span>
                        </div>
                        <div class="compare-stat-row">
                            <span class="compare-stat-label">Hits</span>
                            <span class="compare-stat-value">${stats.hit_count}</span>
                        </div>
                        <div class="compare-stat-row">
                            <span class="compare-stat-label">Crit Rate</span>
                            <span class="compare-stat-value ${stats.crit_rate === maxCrit ? 'winner' : stats.crit_rate === minCrit ? 'loser' : ''}">${stats.crit_rate.toFixed(1)}%</span>
                        </div>
                        <div class="compare-stat-row">
                            <span class="compare-stat-label">Heavy Rate</span>
                            <span class="compare-stat-value ${stats.heavy_rate === maxHeavy ? 'winner' : stats.heavy_rate === minHeavy ? 'loser' : ''}">${stats.heavy_rate.toFixed(1)}%</span>
                        </div>
                        
                        <div class="compare-skills-header">All Skills</div>
                        ${stats.skills.map(s => {
                            const skillInfo = skillDamageMap[s.name];
                            const isUnique = skillInfo && skillInfo.count === 1;
                            const isBest = skillInfo && s.damage === skillInfo.max && skillInfo.count > 1;
                            const isWorst = skillInfo && s.damage === skillInfo.min && skillInfo.count > 1 && skillInfo.max !== skillInfo.min;
                            
                            return `
                                <div class="compare-stat-row">
                                    <span class="compare-stat-label ${isUnique ? 'skill-unique' : ''}">${s.name}</span>
                                    <span class="compare-stat-value ${isBest ? 'skill-better' : isWorst ? 'skill-worse' : ''}">${formatNumber(s.damage)} (${s.percent}%)</span>
                                </div>
                            `;
                        }).join('')}
                    </div>
                `;
            }
            
            // === RENDER OUTPUT ===
            
            const medals = ['🥇', '🥈', '🥉', '4️⃣'];
            const numEncounters = encounters.length;
            const colClass = `cols-${numEncounters}`;
            
            // Generate ranking HTML using ranksWithTies for proper tie handling
            let rankingHtml = '<div class="compare-ranking">';
            ranksWithTies.forEach((data, idx) => {
                const diff = topDps - data.stats.dps;
                const diffPercent = topDps > 0 ? ((diff / topDps) * 100).toFixed(1) : 0;
                
                // Determine the medal/position based on actual rank (not array index)
                const medal = medals[data.rank - 1] || data.rank;
                
                // Determine status text
                let statusText;
                if (data.rank === 1) {
                    statusText = isTied ? '🤝 Tied!' : '🏆 Winner!';
                } else {
                    statusText = `-${formatNumber(Math.round(diff))} (${diffPercent}%)`;
                }
                
                rankingHtml += `
                    <div class="compare-rank-card rank-${data.rank}">
                        <div class="rank-position">${medal}</div>
                        <div class="rank-info">
                            <div class="rank-build">${data.label}: ${data.enc.build_tag}</div>
                            <div class="rank-dps">${formatNumber(Math.round(data.stats.dps))} DPS</div>
                            <div class="rank-diff">${statusText}</div>
                        </div>
                    </div>
                `;
            });
            rankingHtml += '</div>';
            
            // Populate the ranking preview in Select Builds section
            rankingContainer.innerHTML = `
                <div class="compare-major-separator" style="margin-top: 24px;">
                    <div class="separator-line"></div>
                    <div class="separator-content">
                        <div class="separator-icon">🏆</div>
                        <div class="separator-text">
                            <div class="separator-title">RANKING</div>
                            <div class="separator-subtitle">Based on Best Run From Each Build</div>
                        </div>
                    </div>
                    <div class="separator-line"></div>
                </div>
                ${rankingHtml}
                ${buildsData.length >= 2 ? renderCompareKeyFindings(buildsData) : ''}
            `;

            // Populate Skills Breakdown section — upgraded cross-build matrix
            skillsContainer.innerHTML = `
                <div class="compare-section-header">
                    <h3>💥 Skill Breakdown</h3>
                    <p class="section-description">Damage, casts, avg/cast and C+H% per skill across all builds.</p>
                </div>
                ${renderCrossSkillMatrix(buildsData)}
            `;
            
            // Populate Skill Timeline section
            timelineContainer.innerHTML = `
                <div class="compare-section-header">
                    <h3>🎹 Skill Timeline Comparison</h3>
                    <p class="section-description">Visual timeline of when each skill was used during the 60-second window.</p>
                </div>
                
                <div class="compare-piano-section">
                    ${encounters.map(e => renderComparePianoRoll(e, winnerLabels.includes(e.label))).join('')}
                    <div class="compare-piano-legend">
                        <div class="compare-piano-legend-item">
                            <div class="compare-piano-legend-dot" style="background: #D96444;"></div>
                            <span>Normal</span>
                        </div>
                        <div class="compare-piano-legend-item">
                            <div class="compare-piano-legend-dot" style="background: #fbbf24;"></div>
                            <span>Crit</span>
                        </div>
                        <div class="compare-piano-legend-item">
                            <div class="compare-piano-legend-dot" style="background: #fb923c;"></div>
                            <span>Heavy</span>
                        </div>
                        <div class="compare-piano-legend-item">
                            <div class="compare-piano-legend-dot" style="background: #f472b6;"></div>
                            <span>Crit+Heavy</span>
                        </div>
                    </div>
                </div>
            `;
            
            // Populate Rotation section — stacked skill charts per build
            compareRotationData = {}; // reset
            buildsData.forEach(b => {
                compareRotationData[b.label] = b.bestEncounter?.first_60s?.rotation || [];
            });
            // Reset hidden skills for removed builds (compareRotationData is keyed by label)
            if (!compareRotationData['Build A']) compareHiddenSkillsA.clear();
            if (!compareRotationData['Build B']) compareHiddenSkillsB.clear();
            if (!compareRotationData['Build C']) compareHiddenSkillsC.clear();

            const rotChartHtml = buildsData.map(b => `
                <div data-compare-build="${b.label}" style="margin-bottom:20px;background:rgba(15,23,42,0.4);border:1px solid #1e293b;border-radius:10px;padding:14px 16px;">
                    <div style="font-size:0.77rem;font-weight:700;color:#94a3b8;margin-bottom:10px;">${b.label}: ${b.enc?.build_tag||''} ${winnerLabels.includes(b.label)?'👑':''}</div>
                    <div style="display:flex;gap:4px;margin-bottom:2px;">
                        <div id="compareRotYAxis_${b.label}" style="position:relative;width:36px;flex-shrink:0;"></div>
                        <div id="compareRotChart_${b.label}" class="rotation-dps-chart" style="flex:1;height:100px;display:flex;align-items:flex-end;gap:1px;background:rgba(0,0,0,0.2);border-radius:4px;padding:4px 4px 0;position:relative;overflow:hidden;"></div>
                    </div>
                    <div style="font-size:0.65rem;color:#475569;display:flex;justify-content:space-between;padding:0 0 6px 40px;">
                        <span>0s</span><span>15s</span><span>30s</span><span>45s</span><span>60s</span>
                    </div>
                    <div id="compareRotToggles_${b.label}" class="rotation-skill-toggles" style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:6px;"></div>
                    <div id="compareRotLegend_${b.label}" style="display:flex;flex-wrap:wrap;gap:6px;"></div>
                </div>
            `).join('');

            rotationContainer.innerHTML = `
                <div class="compare-section-header">
                    <h3>📊 Rotation Analysis</h3>
                    <p class="section-description">Stacked skill DPS chart per build. Use toggles to filter skills.</p>
                </div>
                ${rotChartHtml}
                <div class="compare-section-header" style="margin-top:16px;">
                    <h3>📈 Segment Breakdown</h3>
                    <p class="section-description">DPS across four 15-second segments.</p>
                </div>
                <div class="compare-rotation-section">${renderSegmentComparison()}</div>
            `;

            // Render stacked charts after DOM update
            setTimeout(() => {
                buildsData.forEach(b => refreshCompareRotationChart(b.label));
            }, 50);
        }
        
        function toggleUnassignedTargets() {
            const controlsEl = document.getElementById('unassignedControls');
            const listEl = document.getElementById('unassignedTargetsList');
            const toggleEl = document.getElementById('unassignedToggle');
            
            const isCollapsed = controlsEl.style.display === 'none';
            
            controlsEl.style.display = isCollapsed ? 'flex' : 'none';
            listEl.style.display = isCollapsed ? 'flex' : 'none';
            toggleEl.textContent = isCollapsed ? '▼' : '▶';
            toggleEl.classList.toggle('collapsed', !isCollapsed);
        }
        
