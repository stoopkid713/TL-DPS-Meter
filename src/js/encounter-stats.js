        function updateFullEncounter(data) {
            // These elements were removed when Full Encounter became Run Builder
            // Add null checks to prevent errors
            
            // Time range
            const timeRangeEl = document.getElementById('fullEncounterTimeRange');
            if (timeRangeEl) {
                if (data.first_hit && data.last_hit) {
                    timeRangeEl.innerHTML = `
                        <strong>${data.first_hit}</strong> → <strong>${data.last_hit}</strong> &nbsp;│&nbsp; Duration: <strong>${formatDuration(data.duration)}</strong>
                    `;
                } else {
                    timeRangeEl.textContent = 'No encounter data';
                }
            }

            // Main stats cards (null-safe)
            const fullDps = document.getElementById('fullDps');
            const fullDamage = document.getElementById('fullDamage');
            const fullHits = document.getElementById('fullHits');
            const fullDuration = document.getElementById('fullDuration');
            if (fullDps) fullDps.textContent = formatNumber(Math.round(data.dps || 0));
            if (fullDamage) fullDamage.textContent = formatNumber(data.total_damage || 0);
            if (fullHits) fullHits.textContent = formatNumber(data.hit_count || 0);
            if (fullDuration) fullDuration.textContent = formatDuration(data.duration || 0);

            // Rate cards (null-safe)
            const fullCritRate = document.getElementById('fullCritRate');
            const fullCritCount = document.getElementById('fullCritCount');
            const fullHeavyRate = document.getElementById('fullHeavyRate');
            const fullHeavyCount = document.getElementById('fullHeavyCount');
            const fullCritHeavyRate = document.getElementById('fullCritHeavyRate');
            const fullCritHeavyCount = document.getElementById('fullCritHeavyCount');
            const fullNormalRate = document.getElementById('fullNormalRate');
            const fullNormalCount = document.getElementById('fullNormalCount');
            
            if (fullCritRate) fullCritRate.textContent = (data.raw_crit_rate || data.crit_rate || 0).toFixed(1) + '%';
            if (fullCritCount) fullCritCount.textContent = (data.crit_count || 0) + ' crits';
            if (fullHeavyRate) fullHeavyRate.textContent = (data.raw_heavy_rate || data.heavy_rate || 0).toFixed(1) + '%';
            if (fullHeavyCount) fullHeavyCount.textContent = (data.heavy_count || 0) + ' heavies';
            if (fullCritHeavyRate) fullCritHeavyRate.textContent = (data.raw_crit_heavy_rate || data.crit_heavy_rate || 0).toFixed(1) + '%';
            if (fullCritHeavyCount) fullCritHeavyCount.textContent = (data.crit_heavy_count || 0) + ' hits';
            if (fullNormalRate) fullNormalRate.textContent = (data.normal_rate || 0).toFixed(1) + '%';
            if (fullNormalCount) fullNormalCount.textContent = (data.normal_count || 0) + ' hits';

            // Top 5 Skills (removed in Run Builder - skip if not found)
            const skillsContainer = document.getElementById('fullTopSkills');
            if (skillsContainer) {
                const skills = data.skills || [];
                if (skills.length === 0) {
                    skillsContainer.innerHTML = '<div class="no-data-small">No skills yet</div>';
                } else {
                    skillsContainer.innerHTML = skills.slice(0, 5).map(s => `
                        <div class="full-encounter-list-item">
                            <span class="item-name">${s.name}</span>
                            <span class="item-value">${formatNumber(s.damage)}</span>
                            <span class="item-percent">${s.percent}%</span>
                        </div>
                    `).join('');
                }
            }

            // Top 3 Biggest Hits (removed in Run Builder - skip if not found)
            const hitsContainer = document.getElementById('fullTopHits');
            if (hitsContainer) {
                const topHits = data.top_hits || [];
                const medals = ['🥇', '🥈', '🥉'];
                if (topHits.length === 0) {
                    hitsContainer.innerHTML = '<div class="no-data-small">No hits yet</div>';
                } else {
                    hitsContainer.innerHTML = topHits.slice(0, 3).map((hit, i) => `
                        <div class="full-encounter-hit">
                            <div class="hit-rank">${medals[i]}</div>
                            <div class="hit-info">
                                <div class="hit-skill">${hit.skill}</div>
                                <div class="hit-target">→ ${hit.target}</div>
                                <div class="hit-tags">
                                    ${hit.is_crit ? '<span class="tag crit">CRIT</span>' : ''}
                                    ${hit.is_heavy ? '<span class="tag heavy">HEAVY</span>' : ''}
                                </div>
                            </div>
                            <div class="hit-damage">${formatNumber(hit.damage)}</div>
                        </div>
                    `).join('');
                }
            }

            // Targets (removed in Run Builder - skip if not found)
            const targetsContainer = document.getElementById('fullTargetsList');
            if (targetsContainer) {
                const targets = data.targets || [];
                if (targets.length === 0) {
                    targetsContainer.innerHTML = '<div class="no-data-small">No targets yet</div>';
                } else {
                    targetsContainer.innerHTML = targets.map(t => `
                        <div class="full-encounter-list-item">
                            <span class="item-name">${t.name}</span>
                            <span class="item-value">${formatNumber(t.damage)}</span>
                            <span class="item-percent">${t.percent}%</span>
                        </div>
                    `).join('');
                }
            }
        }

        function updateTargets(targets) {
            // Track new targets for assignment (even if display container doesn't exist)
            if (targets && targets.length > 0) {
                targets.forEach(t => {
                    if (t.name) {
                        addTargetFromLog(t.name);
                    }
                });
            }
            
            const container = document.getElementById('targetList');
            
            // targetList was replaced by encounterTimelineList in sidebar - skip display if not found
            if (!container) return;
            
            if (!targets || targets.length === 0) {
                const isLoaded = isViewingLoadedEncounter;
                container.innerHTML = `<div style="padding: 20px; font-size: 0.85rem; color: #7A8CB8;">${isLoaded ? 'Not saved in this encounter' : 'No targets yet'}</div>`;
                return;
            }
            
            container.innerHTML = targets.map(t => `
                <div class="target-item">
                    <div class="target-name">${t.name}</div>
                    <div class="target-stats"><span>${formatNumber(t.damage)}</span> damage (${t.percent}%)</div>
                </div>
            `).join('');
        }

        function updateSkillsTable(skills, totalDamage) {
            const tbody = document.getElementById('skillsBody');
            if (!skills || skills.length === 0) {
                tbody.innerHTML = '<tr><td colspan="9" class="no-data">No data yet</td></tr>';
                return;
            }
            const maxDamage = Math.max(...skills.map(s => s.damage));
            tbody.innerHTML = skills.map(s => {
                const critRate = s.hits > 0 ? ((s.crits / s.hits) * 100).toFixed(1) : '0.0';
                const heavyRate = s.hits > 0 ? ((s.heavies / s.hits) * 100).toFixed(1) : '0.0';
                const barWidth = (s.damage / maxDamage) * 100;
                return `
                    <tr>
                        <td>${s.name}</td>
                        <td class="num cyan">${formatNumber(s.damage)}</td>
                        <td><div class="damage-bar-container"><div class="damage-bar" style="width: ${barWidth}%"></div></div></td>
                        <td class="num">${s.hits}</td>
                        <td class="num yellow">${s.crits}</td>
                        <td class="num yellow">${critRate}%</td>
                        <td class="num orange">${s.heavies}</td>
                        <td class="num orange">${heavyRate}%</td>
                        <td class="num purple">${s.percent}%</td>
                    </tr>
                `;
            }).join('');
        }

        function updateTopHits(topHits) {
            const container = document.getElementById('topHitsList');
            if (!container) return; // Element may not exist if Top Hits tab is not present
            
            if (!topHits || topHits.length === 0) {
                container.innerHTML = '<div class="no-data"><div class="no-data-icon">👥</div><div>No hits recorded yet</div></div>';
                return;
            }
            const medals = ['🥇', '🥈', '🥉'];
            container.innerHTML = topHits.map((hit, i) => `
                <div class="top-hit">
                    <div class="rank">${medals[i] || '#' + (i + 1)}</div>
                    <div class="info">
                        <div class="skill-name">${hit.skill}</div>
                        <div class="target">→ ${hit.target}</div>
                    </div>
                    <div class="tags">
                        ${hit.is_crit ? '<span class="tag crit">CRIT</span>' : ''}
                        ${hit.is_heavy ? '<span class="tag heavy">HEAVY</span>' : ''}
                    </div>
                    <div class="damage">${formatNumber(hit.damage)}</div>
                </div>
            `).join('');
        }

        function updateRotation(rotation, gapStats) {
            // console.log('updateRotation called with', rotation?.length || 0, 'hits, isViewingLoadedEncounter:', isViewingLoadedEncounter);
            
            // Handle empty state
            if (!rotation || rotation.length === 0) {
                const emptyMsg = isViewingLoadedEncounter 
                    ? '<div class="no-data" style="width:100%; height:100%; display:flex; align-items:center; justify-content:center; flex-direction: column; gap: 8px;"><div>No rotation data available</div><div style="font-size: 0.75rem; color: #7A8CB8;">This encounter may have been saved before rotation tracking was added</div></div>'
                    : '<div class="no-data" style="width:100%; height:100%; display:flex; align-items:center; justify-content:center;">No rotation data yet</div>';
                document.getElementById('rotationDpsChart').innerHTML = emptyMsg;
                document.getElementById('rotationSegments').innerHTML = '';
                document.getElementById('rotationInsights').innerHTML = '<div style="color: #7A8CB8; text-align: center; padding: 20px;">Start combat to see rotation analysis</div>';
                document.getElementById('rotationGapsSection').style.display = 'none';
                document.getElementById('rotationHitList').innerHTML = '<div class="no-data"><div class="no-data-icon">🔄</div><div>No rotation data yet</div></div>';
                return;
            }

            // Calculate DPS per second for the chart (bucket by second)
            const dpsPerSecond = {};
            const hitsPerSecond = {};
            for (let i = 0; i <= 60; i++) {
                dpsPerSecond[i] = 0;
                hitsPerSecond[i] = 0;
            }
            
            rotation.forEach(hit => {
                const sec = Math.floor(hit.relative_time || 0);
                if (sec <= 60) {
                    dpsPerSecond[sec] += hit.damage;
                    hitsPerSecond[sec]++;
                }
            });

            // Calculate 5-second rolling DPS to find burst windows
            const rollingDps = [];
            for (let i = 0; i <= 55; i++) {
                let sum = 0;
                for (let j = i; j < i + 5; j++) { sum += dpsPerSecond[j] || 0; }
                rollingDps.push({ start: i, dps: sum / 5 });
            }
            const peakWindow  = rollingDps.reduce((max, curr) => curr.dps > max.dps ? curr : max, { dps: 0, start: 0 });
            const firstHitTime = Math.floor(rotation[0]?.relative_time || 0);
            const lastHitTime  = Math.floor(rotation[rotation.length - 1]?.relative_time || 0);

            // === DPS Timeline Chart — shared stacked renderer ===
            lastRotationCache = { rotation, gapStats };
            renderBTStackedChart(rotation);

            // === Segment Analysis (4 quarters) ===
            const segments = [
                { label: '0-15s', start: 0, end: 15 },
                { label: '15-30s', start: 15, end: 30 },
                { label: '30-45s', start: 30, end: 45 },
                { label: '45-60s', start: 45, end: 60 }
            ];

            const segmentStats = segments.map(seg => {
                const segHits = rotation.filter(h => h.relative_time >= seg.start && h.relative_time < seg.end);
                const segDamage = segHits.reduce((sum, h) => sum + h.damage, 0);
                const segCrits = segHits.filter(h => h.is_crit).length;
                const segHeavies = segHits.filter(h => h.is_heavy).length;
                return {
                    ...seg,
                    damage: segDamage,
                    dps: segDamage / 15,
                    hits: segHits.length,
                    crits: segCrits,
                    heavies: segHeavies
                };
            });

            // Find best and worst segments (with hits)
            const activeSegments = segmentStats.filter(s => s.hits > 0);
            const bestSegment = activeSegments.reduce((max, s) => s.dps > max.dps ? s : max, { dps: 0 });
            const worstSegment = activeSegments.length > 0 ? activeSegments.reduce((min, s) => s.dps < min.dps ? s : min, { dps: Infinity }) : { dps: 0 };
            const maxSegmentDps = bestSegment.dps || 1;

            const segmentsContainer = document.getElementById('rotationSegments');
            segmentsContainer.innerHTML = segmentStats.map(seg => {
                let segClass = '';
                let badge = '';
                if (seg === bestSegment && seg.hits > 0) {
                    segClass = 'best';
                    badge = '<span class="rotation-segment-badge best">BEST</span>';
                } else if (seg === worstSegment && seg.hits > 0 && activeSegments.length > 1) {
                    segClass = 'worst';
                    badge = '<span class="rotation-segment-badge worst">WEAKEST</span>';
                }
                
                const barWidth = maxSegmentDps > 0 ? (seg.dps / maxSegmentDps * 100) : 0;
                
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

            // === Performance Insights ===
            const insights = [];
            const totalDamage = rotation.reduce((sum, h) => sum + h.damage, 0);
            const duration60 = Math.min(60, lastHitTime - firstHitTime + 1);
            const overallDps = duration60 > 0 ? totalDamage / duration60 : 0;

            // Activity rate
            const activeSeconds = Object.values(hitsPerSecond).filter((h, i) => h > 0 && i >= firstHitTime && i <= lastHitTime).length;
            const totalSeconds = Math.max(1, lastHitTime - firstHitTime + 1);
            const activityRate = (activeSeconds / totalSeconds * 100);

            // Hit type rates
            const totalHits = rotation.length;
            const critCount    = rotation.filter(h => h.is_crit).length;
            const heavyCount   = rotation.filter(h => h.is_heavy).length;
            const chCount      = rotation.filter(h => h.is_crit && h.is_heavy).length;
            const critRate     = totalHits > 0 ? critCount  / totalHits * 100 : 0;
            const heavyRate    = totalHits > 0 ? heavyCount / totalHits * 100 : 0;
            const chRate       = totalHits > 0 ? chCount    / totalHits * 100 : 0;

            // Skill damage map
            const skillDmgMap = {};
            const skillHitsMap = {};
            rotation.forEach(h => {
                const sk = h.skill || 'Unknown';
                skillDmgMap[sk]  = (skillDmgMap[sk]  || 0) + h.damage;
                skillHitsMap[sk] = (skillHitsMap[sk] || []);
                skillHitsMap[sk].push(h);
            });
            const skillsByDmg = Object.entries(skillDmgMap).sort((a,b) => b[1]-a[1]);

            // Cast interval helper (inline, no deps on Run Lab)
            function castIntervals(hits) {
                const sorted = [...hits].sort((a,b) => (a.relative_time||0)-(b.relative_time||0));
                const casts = [];
                let cur = null;
                sorted.forEach(h => {
                    const t = h.relative_time || 0;
                    if (!cur || t - cur.end > 0.15) { casts.push({start:t, end:t}); cur = casts[casts.length-1]; }
                    else cur.end = t;
                });
                if (casts.length < 2) return null;
                const gaps = [];
                for (let i = 1; i < casts.length; i++) gaps.push(casts[i].start - casts[i-1].start);
                const avg = gaps.reduce((s,g)=>s+g,0)/gaps.length;
                return { count: casts.length, avg, max: Math.max(...gaps), gaps };
            }

            // Segment consistency — coefficient of variation
            const segDpsVals = activeSegments.map(s => s.dps);
            const segMean = segDpsVals.length > 0 ? segDpsVals.reduce((a,b)=>a+b,0)/segDpsVals.length : 0;
            const segCV = segMean > 0
                ? Math.sqrt(segDpsVals.reduce((s,v)=>s+Math.pow(v-segMean,2),0)/segDpsVals.length) / segMean * 100
                : 0;

            // Top skill contribution
            const top3Dmg = skillsByDmg.slice(0,3).reduce((s,[,d])=>s+d,0);
            const top3Pct = totalDamage > 0 ? top3Dmg/totalDamage*100 : 0;

            // What was missing in the worst segment vs best?
            const worstSegHits = worstSegment.hits > 0
                ? rotation.filter(h => h.relative_time >= worstSegment.start && h.relative_time < worstSegment.end)
                : [];
            const worstSegSkills = new Set(worstSegHits.map(h => h.skill));
            const missingInWorst = skillsByDmg.slice(0,6)
                .map(([sk]) => sk)
                .filter(sk => !worstSegSkills.has(sk));

            // Dropped cast detection — skills whose max gap was noticeably longer than avg
            const droppedCasts = [];
            skillsByDmg.slice(0, 5).forEach(([sk]) => {
                const ci = castIntervals(skillHitsMap[sk] || []);
                if (!ci || ci.count < 3) return;
                if (ci.max > ci.avg * 1.6 && ci.max > 8) {
                    droppedCasts.push({ skill: sk, maxGap: ci.max, avgGap: ci.avg });
                }
            });

            // ── Build insights ──────────────────────────────────────

            // 1. Hit type summary — always shown
            insights.push({
                type: chRate >= 15 ? 'success' : chRate >= 8 ? 'warning' : 'neutral',
                icon: '⚡',
                text: `Hit types: <span class="rotation-insight-value">${critRate.toFixed(0)}% Crit</span> · <span class="rotation-insight-value">${heavyRate.toFixed(0)}% Heavy</span> · <span class="rotation-insight-value" style="color:#f472b6">${chRate.toFixed(0)}% C+H</span>`
            });

            // 2. Activity rate
            if (activityRate < 70) {
                insights.push({ type:'danger',  icon:'⏱️', text:`Low uptime: only <span class="rotation-insight-value">${activityRate.toFixed(0)}%</span> of seconds had damage — significant dead time` });
            } else if (activityRate < 85) {
                insights.push({ type:'warning', icon:'⏱️', text:`Uptime <span class="rotation-insight-value">${activityRate.toFixed(0)}%</span> — some gaps in the rotation` });
            } else {
                insights.push({ type:'success', icon:'✔',  text:`Solid uptime at <span class="rotation-insight-value">${activityRate.toFixed(0)}%</span>` });
            }

            // 3. Consistency across segments
            if (segCV > 30) {
                insights.push({ type:'warning', icon:'📊', text:`Inconsistent DPS: segments varied by <span class="rotation-insight-value">${segCV.toFixed(0)}%</span> — burst-heavy rotation` });
            } else if (segCV < 12 && segDpsVals.length >= 3) {
                insights.push({ type:'success', icon:'📊', text:`Consistent rotation — segment-to-segment variance only <span class="rotation-insight-value">${segCV.toFixed(0)}%</span>` });
            }

            // 4. Weak segment cause
            if (worstSegment.hits > 0 && activeSegments.length > 1 && missingInWorst.length > 0) {
                const missing = missingInWorst.slice(0,2).join(', ');
                insights.push({ type:'warning', icon:'🔍', text:`Weak window (${worstSegment.label}): <span class="rotation-insight-value">${missing}</span> absent — likely on cooldown` });
            } else if (worstSegment.hits > 0 && activeSegments.length > 1) {
                const dropOff = bestSegment.dps > 0 ? ((bestSegment.dps - worstSegment.dps) / bestSegment.dps * 100) : 0;
                if (dropOff > 20) {
                    insights.push({ type:'warning', icon:'📉', text:`Weakest window ${worstSegment.label} was <span class="rotation-insight-value">${dropOff.toFixed(0)}%</span> below peak — all skills present but lower proc luck` });
                }
            }

            // 5. Dropped casts on key skills
            droppedCasts.forEach(dc => {
                insights.push({ type:'warning', icon:'⏳', text:`<span class="rotation-insight-value">${dc.skill}</span> had a <span class="rotation-insight-value">${dc.maxGap.toFixed(1)}s</span> gap (avg is ${dc.avgGap.toFixed(1)}s) — possible dropped cast` });
            });

            // 6. Peak burst
            if (peakWindow.dps > 0) {
                insights.push({ type:'success', icon:'🔥', text:`Peak 5s window: <span class="rotation-insight-value">${formatNumber(Math.round(peakWindow.dps))} DPS</span> at ${peakWindow.start}–${peakWindow.start+5}s` });
            }

            // 7. Damage concentration
            if (skillsByDmg.length >= 3) {
                insights.push({ type:'neutral', icon:'⚔️', text:`Top 3 skills — <span class="rotation-insight-value">${skillsByDmg[0][0]}, ${skillsByDmg[1][0]}, ${skillsByDmg[2][0]}</span> — account for <span class="rotation-insight-value">${top3Pct.toFixed(0)}%</span> of damage` });
            }

            // 8. Front/back load
            const firstHalfDamage = segmentStats[0].damage + segmentStats[1].damage;
            const secondHalfDamage = segmentStats[2].damage + segmentStats[3].damage;
            if (firstHalfDamage > secondHalfDamage * 1.4) {
                insights.push({ type:'warning', icon:'⏳', text:`Front-loaded: <span class="rotation-insight-value">${((firstHalfDamage/(firstHalfDamage+secondHalfDamage))*100).toFixed(0)}%</span> of damage in first 30s` });
            } else if (secondHalfDamage > firstHalfDamage * 1.4) {
                insights.push({ type:'success', icon:'📈', text:`Back-loaded: damage ramped up — <span class="rotation-insight-value">${((secondHalfDamage/(firstHalfDamage+secondHalfDamage))*100).toFixed(0)}%</span> in second 30s` });
            }

            // 9. Major gaps from gapStats
            if (gapStats && gapStats.num_major_gaps > 0) {
                insights.push({ type:'warning', icon:'⚠️', text:`<span class="rotation-insight-value">${gapStats.num_major_gaps}</span> gap${gapStats.num_major_gaps>1?'s':''} over 2s — longest was <span class="rotation-insight-value">${gapStats.longest_gap.toFixed(1)}s</span>` });
            }

            const insightsContainer = document.getElementById('rotationInsights');
            insightsContainer.innerHTML = insights.length > 0 ? insights.map(i => `
                <div class="rotation-insight ${i.type}">
                    <span class="rotation-insight-icon">${i.icon}</span>
                    <span class="rotation-insight-text">${i.text}</span>
                </div>
            `).join('') : '<div style="color: #7A8CB8; text-align: center; padding: 20px;">No significant issues detected</div>';

            // === Gap Details ===
            const gapsSection = document.getElementById('rotationGapsSection');
            const gapsList = document.getElementById('rotationGapsList');
            
            // Calculate gaps from rotation data
            const majorGaps = [];
            for (let i = 1; i < rotation.length; i++) {
                const prevTime = rotation[i-1].relative_time || 0;
                const currTime = rotation[i].relative_time || 0;
                const gap = currTime - prevTime;
                if (gap >= 1.5) {
                    majorGaps.push({
                        time: prevTime,
                        duration: gap,
                        afterSkill: rotation[i-1].skill
                    });
                }
            }

            if (majorGaps.length > 0) {
                gapsSection.style.display = 'block';
                gapsList.innerHTML = majorGaps.sort((a, b) => b.duration - a.duration).slice(0, 5).map(g => `
                    <div class="rotation-gap-item">
                        <span class="gap-time">${g.time.toFixed(1)}s</span>
                        <span class="gap-duration">${g.duration.toFixed(1)}s gap</span>
                        <span class="gap-after">after "${g.afterSkill}"</span>
                    </div>
                `).join('');
            } else {
                gapsSection.style.display = 'none';
            }

            // === Update Summary Cards ===
            if (gapStats) {
                document.getElementById('rotationDeadTime').textContent = (gapStats.total_dead_time || 0).toFixed(1) + 's';
                document.getElementById('rotationMajorGaps').textContent = gapStats.num_major_gaps || 0;
                document.getElementById('rotationLongestGap').textContent = (gapStats.longest_gap || 0).toFixed(2) + 's';
                document.getElementById('rotationAvgGap').textContent = (gapStats.avg_time_between_hits || 0).toFixed(2) + 's';
            }
            document.getElementById('rotationActivityRate').textContent = activityRate.toFixed(0) + '%';
            document.getElementById('rotationPeakWindow').textContent = formatNumber(Math.round(peakWindow.dps));

            // === Hit Timeline ===
            document.getElementById('rotationHitCount').textContent = `${rotation.length} hits`;
            
            const hitListContainer = document.getElementById('rotationHitList');
            let hitHtml = '';
            
            for (let i = 0; i < rotation.length; i++) {
                const hit = rotation[i];
                
                // Calculate gap from previous hit
                if (i > 0) {
                    const prevTime = rotation[i-1].relative_time || 0;
                    const currTime = hit.relative_time || 0;
                    const gap = currTime - prevTime;
                    
                    if (gap > 1.0) {
                        let gapClass = gap > 2.0 ? 'danger' : 'warning';
                        let gapIcon = gap > 2.0 ? '⚠️' : '⋮';
                        hitHtml += `
                            <div class="rotation-gap ${gapClass}">
                                <div class="gap-line"></div>
                                <span class="gap-icon">${gapIcon}</span>
                                <span>${gap.toFixed(2)}s gap</span>
                                <div class="gap-line"></div>
                            </div>
                        `;
                    }
                }
                
                hitHtml += `
                    <div class="rotation-hit">
                        <div class="time">${(hit.relative_time || 0).toFixed(1)}s</div>
                        <div class="skill">${hit.skill}</div>
                        <div class="tags">
                            ${hit.is_crit ? '<span class="tag crit">CRIT</span>' : ''}
                            ${hit.is_heavy ? '<span class="tag heavy">HEAVY</span>' : ''}
                        </div>
                        <div class="damage">${formatNumber(hit.damage)}</div>
                    </div>
                `;
            }
            
            hitListContainer.innerHTML = hitHtml;
        }

        function updateTimeline(rotation, timeline, duration, avgDps, hitCount) {
            const pianoRoll = document.getElementById('pianoRoll');
            const chart = document.getElementById('timelineChart');
            
            // Elements may not exist if Timeline tab is not present
            if (!pianoRoll && !chart) return;
            
            // === PIANO ROLL ===
            if (pianoRoll) {
                if (!rotation || rotation.length === 0) {
                    pianoRoll.innerHTML = `
                        <div class="piano-roll-empty">
                            <div style="font-size: 1.5rem; margin-bottom: 8px;">🎹</div>
                            <div>Start combat to see skill timeline</div>
                        </div>
                    `;
                } else {
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
                
                // Build piano roll HTML
                let html = `
                    <div class="piano-roll-header">
                        <div class="piano-roll-time-markers">
                            <span>0s</span>
                            <span>15s</span>
                            <span>30s</span>
                            <span>45s</span>
                            <span>60s</span>
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
                        const leftPercent = (time / 60) * 100;
                        
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
                            <span>Crit + Heavy</span>
                        </div>
                    </div>
                `;
                
                pianoRoll.innerHTML = html;
                
                // Update skill count
                const skillCountEl = document.getElementById('timelineSkillCount');
                if (skillCountEl) skillCountEl.textContent = sortedSkills.length;
                }
            }
            
            // === DPS CHART (First 60 seconds only) ===
            if (chart) {
                if (!timeline || timeline.length === 0) {
                    chart.innerHTML = '<div class="no-data" style="width: 100%;">No timeline data yet</div>';
                    return;
                }
                
                // Limit to first 60 seconds
                const timeline60 = timeline.slice(0, 61);
                const maxDmg = Math.max(...timeline60.filter(Boolean), 1);
                
                // Calculate 60s specific stats
                const damage60 = timeline60.reduce((sum, d) => sum + (d || 0), 0);
                const dps60 = damage60 / Math.min(60, duration);
                
                const peakDpsEl = document.getElementById('peakDps');
                const avgDpsEl = document.getElementById('avgDps');
                const hitCountEl = document.getElementById('hitCount');
                
                if (peakDpsEl) peakDpsEl.textContent = formatNumber(maxDmg);
                if (avgDpsEl) avgDpsEl.textContent = formatNumber(Math.round(dps60));
                if (hitCountEl) hitCountEl.textContent = hitCount;

                // Generate bars for each second (0-60)
                const bars = [];
                for (let i = 0; i <= 60; i++) {
                    const dmg = timeline60[i] || 0;
                    const height = maxDmg > 0 ? (dmg / maxDmg * 100) : 0;
                    bars.push(`<div class="timeline-bar" style="height: ${Math.max(height, 1)}%"></div>`);
                }
                chart.innerHTML = bars.join('');
            }
        }

                // === COMBAT LOG ===
        let allHits = [];  // Current encounter hits (filtered by reset)
        let fullSessionLog = [];  // Full session log (never cleared by reset)
        let logSortField = 'time';
        let logSortAsc = false; // newest first by default
        
        function formatHitType(hitType) {
            // Clean up hit type strings from the game
            if (!hitType) return 'Normal';
            
            const typeMap = {
                'kMaxDamageByCriticalDecision': 'Max Crit',
                'kNormalHit': 'Normal',
                'kCriticalHit': 'Critical',
                'kHeavyAttack': 'Heavy',
                'kMaxDamageByHeavyAttack': 'Max Heavy',
                'kMaxDamageByBothCriticalAndHeavy': 'Max Crit+Heavy'
            };
            
            if (typeMap[hitType]) return typeMap[hitType];
            
            // Clean up other types: remove 'k' prefix and add spaces
            return hitType
                .replace(/^k/, '')
                .replace(/([A-Z])/g, ' $1')
                .trim();
        }
        
        function getHitTypeClass(hitType, isCrit, isHeavy) {
            if (isCrit && isHeavy) return 'hit-type-crit';
            if (isCrit) return 'hit-type-crit';
            if (isHeavy) return 'hit-type-heavy';
            return 'hit-type-normal';
        }
        
        function updateLogFilters() {
            // Populate skill and target dropdowns
            const skills = [...new Set(allHits.map(h => h.skill))].sort();
            const targets = [...new Set(allHits.map(h => h.target))].sort();
            
            const skillSelect = document.getElementById('logSkillFilter');
            const targetSelect = document.getElementById('logTargetFilter');
            
            const currentSkill = skillSelect.value;
            const currentTarget = targetSelect.value;
            
            skillSelect.innerHTML = '<option value="">All Skills</option>' + 
                skills.map(s => `<option value="${s}">${s}</option>`).join('');
            
            targetSelect.innerHTML = '<option value="">All Targets</option>' + 
                targets.map(t => `<option value="${t}">${t}</option>`).join('');
            
            // Restore selections
            if (skills.includes(currentSkill)) skillSelect.value = currentSkill;
            if (targets.includes(currentTarget)) targetSelect.value = currentTarget;
        }
        
        function getFilteredHits() {
            const search = document.getElementById('logSearch').value.toLowerCase();
            const skillFilter = document.getElementById('logSkillFilter').value;
            const targetFilter = document.getElementById('logTargetFilter').value;
            const critOnly = document.getElementById('logCritOnly').checked;
            const heavyOnly = document.getElementById('logHeavyOnly').checked;
            
            let filtered = allHits.filter(hit => {
                if (search && !hit.skill.toLowerCase().includes(search) && 
                    !hit.target.toLowerCase().includes(search)) {
                    return false;
                }
                if (skillFilter && hit.skill !== skillFilter) return false;
                if (targetFilter && hit.target !== targetFilter) return false;
                if (critOnly && !hit.is_crit) return false;
                if (heavyOnly && !hit.is_heavy) return false;
                return true;
            });
            
            // Sort
            filtered.sort((a, b) => {
                let aVal, bVal;
                switch (logSortField) {
                    case 'time':
                        aVal = a.relative_time;
                        bVal = b.relative_time;
                        break;
                    case 'skill':
                        aVal = a.skill.toLowerCase();
                        bVal = b.skill.toLowerCase();
                        break;
                    case 'target':
                        aVal = a.target.toLowerCase();
                        bVal = b.target.toLowerCase();
                        break;
                    case 'damage':
                        aVal = a.damage;
                        bVal = b.damage;
                        break;
                    default:
                        aVal = a.relative_time;
                        bVal = b.relative_time;
                }
                
                if (typeof aVal === 'string') {
                    return logSortAsc ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
                }
                return logSortAsc ? aVal - bVal : bVal - aVal;
            });
            
            return filtered;
        }
        
        function renderLogTable() {
            const filtered = getFilteredHits();
            const tbody = document.getElementById('logTableBody');
            const maxDamage = allHits.length > 0 ? Math.max(...allHits.map(h => h.damage)) : 1;
            
            // Update counts
            document.getElementById('logVisibleCount').textContent = filtered.length;
            document.getElementById('logTotalCount').textContent = allHits.length;
            
            if (filtered.length === 0) {
                tbody.innerHTML = `<tr><td colspan="6" class="log-empty">
                    <div class="log-empty-icon">📋</div>
                    <div>${allHits.length === 0 ? 'Waiting for combat data...' : 'No matching entries'}</div>
                </td></tr>`;
                return;
            }
            
            // Limit display for performance (500 entries)
            const displayLimit = 500;
            const displayHits = filtered.slice(0, displayLimit);
            const hiddenCount = filtered.length - displayHits.length;
            
            let html = displayHits.map(hit => {
                const barWidth = (hit.damage / maxDamage * 100).toFixed(1);
                const typeClass = getHitTypeClass(hit.hit_type, hit.is_crit, hit.is_heavy);
                
                return `
                    <tr>
                        <td class="col-time">
                            <span class="time-relative">${hit.relative_time.toFixed(1)}s</span>
                            <span class="time-absolute">${hit.time}</span>
                        </td>
                        <td class="col-skill">${hit.skill}</td>
                        <td class="col-target" title="${hit.target}">${hit.target}</td>
                        <td class="col-damage">
                            <span class="damage-value">${formatNumber(hit.damage)}</span>
                            <span class="damage-bar-mini">
                                <span class="damage-bar-mini-fill" style="width: ${barWidth}%"></span>
                            </span>
                        </td>
                        <td class="col-type">
                            <span class="hit-type-badge ${typeClass}">${formatHitType(hit.hit_type)}</span>
                        </td>
                        <td class="col-tags">
                            ${hit.is_crit ? '<span class="tag crit">CRIT</span>' : ''}
                            ${hit.is_heavy ? '<span class="tag heavy">HEAVY</span>' : ''}
                        </td>
                    </tr>
                `;
            }).join('');
            
            // Add message if entries were hidden
            if (hiddenCount > 0) {
                html += `<tr><td colspan="6" style="text-align: center; padding: 16px; color: #7A8CB8; font-size: 0.85rem;">
                    ... and ${hiddenCount.toLocaleString()} more entries. Use filters to narrow down or export full data.
                </td></tr>`;
            }
            
            tbody.innerHTML = html;
        }
        
        function updateCombatLog(hits) {
            // Append new hits to the full session log (never cleared by reset)
            const newHits = hits || [];
            
            // Create a set of existing hit keys for fast lookup
            const existingKeys = new Set(fullSessionLog.map(h => 
                `${h.time}_${h.skill}_${h.damage}_${h.target}`
            ));
            
            // Add only new hits
            newHits.forEach(hit => {
                const key = `${hit.time}_${hit.skill}_${hit.damage}_${hit.target}`;
                if (!existingKeys.has(key)) {
                    fullSessionLog.push(hit);
                    existingKeys.add(key);
                }
            });
            
            // Use full session log for display
            allHits = fullSessionLog;
            updateLogFilters();
            renderLogTable();
        }
        
        function clearFullSessionLog() {
            // Only called on purge or explicit clear
            fullSessionLog = [];
            allHits = [];
            updateLogFilters();
            renderLogTable();
        }
        
        function clearLogFilters() {
            document.getElementById('logSearch').value = '';
            document.getElementById('logSkillFilter').value = '';
            document.getElementById('logTargetFilter').value = '';
            document.getElementById('logCritOnly').checked = false;
            document.getElementById('logHeavyOnly').checked = false;
            document.getElementById('logCritToggle').classList.remove('active');
            document.getElementById('logHeavyToggle').classList.remove('active');
            renderLogTable();
        }
        
        function exportLogToCSV() {
            if (allHits.length === 0) {
                alert('No data to export');
                return;
            }
            
            const filtered = getFilteredHits();
            const headers = ['Time (s)', 'Absolute Time', 'Skill', 'Target', 'Damage', 'Type', 'Crit', 'Heavy'];
            const rows = filtered.map(h => [
                h.relative_time,
                h.time,
                h.skill,
                h.target,
                h.damage,
                formatHitType(h.hit_type),
                h.is_crit ? 'Yes' : 'No',
                h.is_heavy ? 'Yes' : 'No'
            ]);
            
            const csv = [headers, ...rows].map(row => 
                row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(',')
            ).join('\n');
            
            // Copy to clipboard
            navigator.clipboard.writeText(csv).then(() => {
                showExportToast();
            }).catch(() => {
                // Fallback: download as file
                const blob = new Blob([csv], { type: 'text/csv' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `combat-log-${new Date().toISOString().slice(0, 10)}.csv`;
                a.click();
                URL.revokeObjectURL(url);
            });
        }
        
