        function setRunLabSlot(slot, idx) {
            // Clear any previous assignment for this slot
            sessionQueue.forEach(item => {
                if (item.runLabSlot === slot) item.runLabSlot = null;
            });
            // Assign new
            if (sessionQueue[idx]) sessionQueue[idx].runLabSlot = slot;
            renderSessionQueue();
        }

        function openRunLab() {
            switchBuildTestSubtab('runlab');
            renderRunLab();
        }

        // Group rotation hits by skill name
        function groupBySkill(rotation) {
            const map = {};
            (rotation || []).forEach(hit => {
                const s = hit.skill || 'Unknown';
                if (!map[s]) map[s] = [];
                map[s].push(hit);
            });
            return map;
        }

        // Group a skill's hits into individual casts (hits within 150ms = same cast)
        function groupIntoCasts(hits) {
            if (!hits || hits.length === 0) return [];
            const sorted = [...hits].sort((a, b) => (a.relative_time || 0) - (b.relative_time || 0));
            const casts = [];
            let cur = null;

            sorted.forEach(hit => {
                const t = hit.relative_time || 0;
                if (!cur || (t - cur.endTime) > 0.15) {
                    if (cur) casts.push(cur);
                    cur = { startTime: t, endTime: t, totalDamage: hit.damage, hits: [hit], anyCrit: hit.is_crit, anyHeavy: hit.is_heavy };
                } else {
                    cur.endTime = t;
                    cur.totalDamage += hit.damage;
                    cur.hits.push(hit);
                    if (hit.is_crit) cur.anyCrit = true;
                    if (hit.is_heavy) cur.anyHeavy = true;
                }
            });
            if (cur) casts.push(cur);
            return casts;
        }

        function computeSkillMatrix(rotationA, rotationB) {
            const bySkillA = groupBySkill(rotationA);
            const bySkillB = groupBySkill(rotationB);
            const allSkills = new Set([...Object.keys(bySkillA), ...Object.keys(bySkillB)]);

            const rows = Array.from(allSkills).map(skill => {
                const hitsA = bySkillA[skill] || [];
                const hitsB = bySkillB[skill] || [];
                const castsA = groupIntoCasts(hitsA);
                const castsB = groupIntoCasts(hitsB);
                const totalDmgA = castsA.reduce((s, c) => s + c.totalDamage, 0);
                const totalDmgB = castsB.reduce((s, c) => s + c.totalDamage, 0);
                const avgA = castsA.length > 0 ? totalDmgA / castsA.length : 0;
                const avgB = castsB.length > 0 ? totalDmgB / castsB.length : 0;

                function rates(hits) {
                    if (!hits.length) return { crit: 0, heavy: 0, critHeavy: 0 };
                    const n = hits.length;
                    return {
                        crit:      hits.filter(h => h.is_crit).length / n * 100,
                        heavy:     hits.filter(h => h.is_heavy).length / n * 100,
                        critHeavy: hits.filter(h => h.is_crit && h.is_heavy).length / n * 100
                    };
                }

                const ratesA = rates(hitsA);
                const ratesB = rates(hitsB);

                const intervals = (casts) => {
                    if (casts.length < 2) return { avg: 0, min: 0, max: 0, all: [] };
                    const gaps = [];
                    for (let i = 1; i < casts.length; i++) gaps.push(casts[i].startTime - casts[i-1].startTime);
                    return { avg: gaps.reduce((s,g)=>s+g,0)/gaps.length, min: Math.min(...gaps), max: Math.max(...gaps), all: gaps };
                };

                return {
                    skill, castsA, castsB, totalDmgA, totalDmgB, avgA, avgB,
                    critA: ratesA.crit, heavyA: ratesA.heavy, critHeavyA: ratesA.critHeavy,
                    critB: ratesB.crit, heavyB: ratesB.heavy, critHeavyB: ratesB.critHeavy,
                    intervalsA: intervals(castsA), intervalsB: intervals(castsB), hitsA, hitsB
                };
            });

            return rows.sort((a, b) => (b.totalDmgA + b.totalDmgB) - (a.totalDmgA + a.totalDmgB));
        }

        let runLabMatrix = [];
        let runLabVisibleSkills = new Set();
        let runLabDrilldownSkill = null;

        function renderRunLab() {
            const runA = sessionQueue.find(i => i.runLabSlot === 'A');
            const runB = sessionQueue.find(i => i.runLabSlot === 'B');

            const placeholder = document.getElementById('runLabPlaceholder');
            const content = document.getElementById('runLabContent');

            if (!runA || !runB) {
                if (placeholder) placeholder.style.display = 'flex';
                if (content) content.style.display = 'none';
                return;
            }
            if (placeholder) placeholder.style.display = 'none';
            if (content) content.style.display = 'block';

            // Compute matrix
            runLabMatrix = computeSkillMatrix(runA.rotation, runB.rotation);

            // Default visible: top 7 by combined damage
            if (runLabVisibleSkills.size === 0) {
                runLabMatrix.slice(0, 7).forEach(r => runLabVisibleSkills.add(r.skill));
            }

            renderRunLabHeader(runA, runB);
            renderRunLabAnalysis(runA, runB);
            renderRunLabMatrix(runA, runB);
            renderRunLabToggles();
            renderRunLabPiano(runA, runB);
            if (runLabDrilldownSkill) renderRunLabDrilldown(runLabDrilldownSkill);
        }

        function renderRunLabHeader(runA, runB) {
            const dpsA = runA.dps, dpsB = runB.dps;
            const winner = dpsA >= dpsB ? 'A' : 'B';
            const delta = dpsA - dpsB;
            const deltaPct = dpsB > 0 ? (delta / dpsB * 100) : 0;

            function deltaClass(v) { return v > 0.5 ? 'positive' : v < -0.5 ? 'negative' : 'neutral'; }
            function sign(v) { return v > 0 ? '+' : ''; }

            function rateBlock(item) {
                return `<div style="display:flex; gap:10px; margin-top:6px; flex-wrap:wrap;">
                    <span style="font-size:0.68rem;" title="Crit only (max damage roll)">
                        <span style="color:#7A8CB8;">Crit </span><span style="color:#fbbf24; font-weight:600;">${item.critRate}%</span>
                    </span>
                    <span style="font-size:0.68rem;" title="Heavy only (2× damage)">
                        <span style="color:#7A8CB8;">Heavy </span><span style="color:#fb923c; font-weight:600;">${item.heavyRate}%</span>
                    </span>
                    <span style="font-size:0.68rem;" title="Crit+Heavy — max roll AND 2× damage">
                        <span style="color:#7A8CB8;">C+H </span><span style="color:#f472b6; font-weight:700;">${item.critHeavyRate || 0}%</span>
                    </span>
                </div>`;
            }

            document.getElementById('runLabHeader').innerHTML = `
                <div class="rl-run-card run-a ${winner==='A'?'winner':''}">
                    <div class="rl-run-label">Run A${winner==='A'?' 👑':''} — #${runA.runNumber}</div>
                    <div class="rl-run-dps">${formatNumber(dpsA)}</div>
                    <div class="rl-run-meta">${runA.finalTag || runA.target || '—'}</div>
                    ${rateBlock(runA)}
                </div>
                <div style="display:flex; flex-direction:column; gap:6px;">
                    <div class="rl-delta-card">
                        <div class="rl-delta-value ${deltaClass(delta)}">${sign(delta)}${formatNumber(Math.abs(Math.round(delta)))}</div>
                        <div class="rl-delta-label">DPS Δ</div>
                    </div>
                    <div class="rl-delta-card">
                        <div class="rl-delta-value ${deltaClass(delta)}">${sign(deltaPct)}${Math.abs(deltaPct).toFixed(1)}%</div>
                        <div class="rl-delta-label">% diff</div>
                    </div>
                </div>
                <div class="rl-run-card run-b ${winner==='B'?'winner':''}">
                    <div class="rl-run-label">Run B${winner==='B'?' 👑':''} — #${runB.runNumber}</div>
                    <div class="rl-run-dps">${formatNumber(dpsB)}</div>
                    <div class="rl-run-meta">${runB.finalTag || runB.target || '—'}</div>
                    ${rateBlock(runB)}
                </div>
            `;
        }

        function renderRunLabAnalysis(runA, runB) {
            const el = document.getElementById('runLabAnalysis');
            if (!el || !runLabMatrix.length) return;

            const winner = runA.dps >= runB.dps ? runA : runB;
            const loser  = runA.dps >= runB.dps ? runB : runA;
            const slotW  = runA.dps >= runB.dps ? 'A' : 'B';
            const slotL  = slotW === 'A' ? 'B' : 'A';
            const dpsDelta = Math.abs(runA.dps - runB.dps);
            const dpsDeltaPct = loser.dps > 0 ? (dpsDelta / loser.dps * 100) : 0;

            // Impact of cast count diff: extraCasts × winner's avg/cast
            // Impact of avg/cast diff: loser's castCount × avgDiff
            const findings = [];

            runLabMatrix.forEach(row => {
                const castsW  = slotW === 'A' ? row.castsA.length : row.castsB.length;
                const castsL  = slotW === 'A' ? row.castsB.length : row.castsA.length;
                const avgW    = slotW === 'A' ? row.avgA : row.avgB;
                const avgL    = slotW === 'A' ? row.avgB : row.avgA;
                const chW     = slotW === 'A' ? row.critHeavyA : row.critHeavyB;
                const chL     = slotW === 'A' ? row.critHeavyB : row.critHeavyA;
                const castDiff = castsW - castsL;
                const avgDiff  = avgW - avgL;
                const avgDiffPct = avgL > 0 ? (avgDiff / avgL * 100) : 0;
                const castImpact = castDiff > 0 ? castDiff * avgW : 0;
                const avgImpact  = castsL > 0 && Math.abs(avgDiffPct) > 8 ? Math.abs(avgDiff) * Math.min(castsW, castsL) : 0;

                if (castDiff > 0 && castImpact > 50000) {
                    findings.push({ type: 'cast', skill: row.skill, castDiff, impact: castImpact, avgW,
                        text: `<strong style="color:#F0EBE0">${row.skill}</strong>: Run ${slotW} landed <span style="color:#22c55e;font-weight:700;">+${castDiff} cast${castDiff>1?'s':''}</span> — approx <span style="color:#5B92D4;font-weight:700;">+${formatNumber(Math.round(castImpact))}</span> extra damage` });
                }
                if (Math.abs(avgDiffPct) > 10 && avgImpact > 50000 && castsL > 0) {
                    const dir = avgDiff > 0 ? 'higher' : 'lower';
                    const col = avgDiff > 0 ? '#22c55e' : '#ef4444';
                    findings.push({ type: 'avg', skill: row.skill, impact: avgImpact, avgDiffPct,
                        text: `<strong style="color:#F0EBE0">${row.skill}</strong>: avg/cast was <span style="color:${col};font-weight:700;">${Math.abs(avgDiffPct).toFixed(0)}% ${dir}</span> in Run ${slotW} — <span style="color:#5B92D4;font-weight:700;">~${formatNumber(Math.round(avgImpact))}</span> damage swing` });
                }
                if (chW - chL > 6 && castsW >= 3) {
                    findings.push({ type: 'ch', skill: row.skill, impact: (chW-chL)*avgW/100*castsW,
                        text: `<strong style="color:#F0EBE0">${row.skill}</strong>: C+H rate <span style="color:#f472b6;font-weight:700;">${chW.toFixed(0)}%</span> vs ${chL.toFixed(0)}% — more big-boy hits in Run ${slotW}` });
                }
            });

            // Sort findings by impact desc, keep top 5
            findings.sort((a,b) => b.impact - a.impact);
            const top = findings.slice(0, 5);

            // Hit type delta summary
            const chDelta = (winner.critHeavyRate || 0) - (loser.critHeavyRate || 0);
            const critDelta = winner.critRate - loser.critRate;
            const heavyDelta = winner.heavyRate - loser.heavyRate;

            const rateLines = [];
            if (Math.abs(chDelta) >= 2)    rateLines.push(`C+H <span style="color:#f472b6;font-weight:700;">${winner.critHeavyRate||0}%</span> vs ${loser.critHeavyRate||0}%`);
            if (Math.abs(critDelta) >= 2)  rateLines.push(`Crit <span style="color:#fbbf24;font-weight:700;">${winner.critRate}%</span> vs ${loser.critRate}%`);
            if (Math.abs(heavyDelta) >= 2) rateLines.push(`Heavy <span style="color:#fb923c;font-weight:700;">${winner.heavyRate}%</span> vs ${loser.heavyRate}%`);

            el.innerHTML = `
                <div style="background:rgba(21,32,53,0.5); border:1px solid #263956; border-radius:10px; padding:14px 16px; margin-bottom:16px;">
                    <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:10px;">
                        <div style="font-size:0.72rem; font-weight:700; color:#7A8CB8; text-transform:uppercase; letter-spacing:0.5px;">🔍 Key Findings</div>
                        <div style="font-size:0.72rem; color:#7A8CB8;">Run ${slotW} wins by <span style="color:${slotW==='A'?'#D96444':'#5B92D4'};font-weight:700;">${formatNumber(Math.round(dpsDelta))} DPS</span> (${dpsDeltaPct.toFixed(1)}%)</div>
                    </div>
                    ${top.length > 0
                        ? `<div style="display:flex; flex-direction:column; gap:6px; margin-bottom:${rateLines.length?'12px':'0'};">
                               ${top.map(f => `<div style="font-size:0.77rem; color:#7A8CB8; padding:5px 8px; background:rgba(21,32,53,0.4); border-radius:5px;">${f.text}</div>`).join('')}
                           </div>`
                        : `<div style="font-size:0.77rem; color:#7A8CB8; padding:6px 0;">Runs are very close — no single dominant factor. Check the skill matrix for fine details.</div>`
                    }
                    ${rateLines.length ? `<div style="font-size:0.72rem; color:#7A8CB8; padding-top:8px; border-top:1px solid #1D2F50;">
                        Hit rates (Run ${slotW} vs ${slotL}): ${rateLines.join(' &nbsp;·&nbsp; ')}
                    </div>` : ''}
                </div>`;
        }

        function renderRunLabMatrix(runA, runB) {
            if (!runLabMatrix.length) { document.getElementById('runLabMatrix').innerHTML = '<div style="color:#7A8CB8;padding:20px;text-align:center;">No skill data</div>'; return; }

            function dc(a, b) { const d = a - b; return d > 0.5 ? 'pos' : d < -0.5 ? 'neg' : 'zero'; }
            function sign(v) { return v > 0 ? '+' : ''; }

            // Stacked A/B cell — shows both runs' value for a rate metric
            function rateCell(vA, vB, colorA, colorB) {
                const d = vA - vB;
                const cls = dc(vA, vB);
                return `<span style="text-align:right; display:flex; flex-direction:column; align-items:flex-end; gap:1px; line-height:1.2;">
                    <span style="font-size:0.72rem; color:${colorA}; font-weight:600;">${vA.toFixed(0)}%</span>
                    <span style="font-size:0.66rem; color:${colorB};">${vB.toFixed(0)}%</span>
                </span>`;
            }

            document.getElementById('runLabMatrix').innerHTML = runLabMatrix.map(row => {
                const isSelected = runLabDrilldownSkill === row.skill;
                const castDelta = row.castsA.length - row.castsB.length;

                return `<div class="rl-matrix-row${isSelected?' selected':''}" onclick="drilldownSkill('${escapeHtml(row.skill)}')">
                    <span class="rl-skill-name" title="${escapeHtml(row.skill)}">${escapeHtml(row.skill)}</span>
                    <span style="text-align:right; display:flex; align-items:center; justify-content:flex-end; gap:3px;">
                        <span class="rl-cell-a">${row.castsA.length}</span>
                        <span style="color:#405A85;font-size:0.68rem;">/</span>
                        <span class="rl-cell-b">${row.castsB.length}</span>
                        <span class="rl-delta-cell ${dc(row.castsA.length,row.castsB.length)}">${sign(castDelta)}${castDelta}</span>
                    </span>
                    <span class="rl-cell-a" style="text-align:right;">${formatNumber(Math.round(row.avgA))}</span>
                    <span class="rl-cell-b" style="text-align:right;">${formatNumber(Math.round(row.avgB))}</span>
                    ${rateCell(row.critA, row.critB, '#fbbf24', '#b45309')}
                    ${rateCell(row.heavyA, row.heavyB, '#fb923c', '#c2410c')}
                    ${rateCell(row.critHeavyA, row.critHeavyB, '#f472b6', '#be185d')}
                </div>`;
            }).join('');
        }

        function renderRunLabToggles() {
            const hiddenSkills = new Set(runLabMatrix.filter(r=>!runLabVisibleSkills.has(r.skill)).map(r=>r.skill));
            const weaponGroups = renderWeaponGroupToggles(runLabMatrix.map(r=>r.skill), hiddenSkills, 'toggleRotationSkill', 'rotationShowAll');
            document.getElementById('runLabToggles').innerHTML =
                `<span class="rl-toggle-label">Show:</span>` +
                runLabMatrix.map(row =>
                    `<button class="rl-skill-toggle ${runLabVisibleSkills.has(row.skill)?'on':''}"
                             onclick="toggleRunLabSkill('${escapeHtml(row.skill)}')">${escapeHtml(row.skill)}</button>`
                ).join('') +
                `<span style="display:inline-block;width:1px;height:14px;background:#263956;margin:0 4px;vertical-align:middle;"></span>` +
                `<button class="rl-skill-toggle" onclick="runLabShowAll()" style="border-color:#22c55e;color:#22c55e;">All</button>
                 <button class="rl-skill-toggle" onclick="runLabShowNone()" style="border-color:#ef4444;color:#ef4444;">None</button>` +
                (weaponGroups ? `<span style="display:inline-block;width:1px;height:14px;background:#263956;margin:0 4px;vertical-align:middle;"></span>${weaponGroups}` : '');
        }

        function renderRunLabPiano(runA, runB) {
            const visible = runLabMatrix.filter(r => runLabVisibleSkills.has(r.skill));
            if (!visible.length) { document.getElementById('runLabPiano').innerHTML = '<div style="color:#7A8CB8;font-size:0.8rem;padding:12px 0;">No skills selected — use toggles above.</div>'; return; }

            function castType(cast) {
                if (cast.anyCrit && cast.anyHeavy) return 'crit-heavy';
                if (cast.anyCrit) return 'crit';
                if (cast.anyHeavy) return 'heavy';
                return 'normal';
            }

            function lane(casts, title) {
                const bars = casts.map(c => {
                    const pct = Math.min((c.startTime / 60) * 100, 99.5);
                    const type = castType(c);
                    return `<div class="rl-piano-cast ${type}" style="left:${pct}%"
                                 title="${c.startTime.toFixed(1)}s — ${formatNumber(c.totalDamage)}${c.anyCrit?' Crit':''}${c.anyHeavy?' Heavy':''}"></div>`;
                }).join('');
                return `<div class="rl-piano-skill-row">
                    <div class="rl-piano-run-tag ${title==='A'?'tag-a':'tag-b'}">${title}</div>
                    <div class="rl-piano-lane">${bars}</div>
                </div>`;
            }

            document.getElementById('runLabPiano').innerHTML = visible.map(row =>
                `<div class="rl-piano-skill-block">
                    <div style="display:flex; align-items:center; margin-bottom:1px;">
                        <div style="width:106px;"></div>
                        <div style="font-size:0.63rem;color:#7A8CB8;font-weight:600;">${escapeHtml(row.skill)}</div>
                    </div>
                    ${lane(row.castsA,'A')}${lane(row.castsB,'B')}
                    <div class="rl-piano-sep"></div>
                </div>`
            ).join('');
        }

        function drilldownSkill(skill) {
            runLabDrilldownSkill = runLabDrilldownSkill === skill ? null : skill;
            renderRunLabMatrix(
                sessionQueue.find(i=>i.runLabSlot==='A'),
                sessionQueue.find(i=>i.runLabSlot==='B')
            );
            const dd = document.getElementById('runLabDrilldown');
            if (!runLabDrilldownSkill) { dd.style.display = 'none'; return; }
            renderRunLabDrilldown(skill);
            dd.style.display = 'block';
            dd.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }

        function renderRunLabDrilldown(skill) {
            const row = runLabMatrix.find(r => r.skill === skill);
            if (!row) return;

            function castList(casts, colorClass) {
                if (!casts.length) return '<div style="color:#7A8CB8;font-size:0.75rem;padding:8px;">No casts in this run</div>';
                return casts.map(c => {
                    const isCritHeavy = c.anyCrit && c.anyHeavy;
                    const isCritOnly  = c.anyCrit && !c.anyHeavy;
                    const isHeavyOnly = c.anyHeavy && !c.anyCrit;
                    const tags = isCritHeavy
                        ? `<span class="rl-cast-tag" style="background:rgba(244,114,182,0.2);color:#f472b6;font-weight:700;">C+H</span>`
                        : [
                            isCritOnly  ? `<span class="rl-cast-tag c">C</span>` : '',
                            isHeavyOnly ? `<span class="rl-cast-tag h">H</span>` : ''
                          ].join('');
                    return `<div class="rl-cast-item">
                        <span class="rl-cast-time">${c.startTime.toFixed(1)}s</span>
                        <span class="rl-cast-dmg ${colorClass}">${formatNumber(c.totalDamage)}</span>
                        <span class="rl-cast-tags">${tags}</span>
                    </div>`;
                }).join('');
            }

            function intervalSection(intervals, casts, colorClass) {
                if (casts.length < 2) return '<div style="color:#7A8CB8;font-size:0.72rem;padding:4px 0;">Only one cast — no interval data</div>';
                const maxGap = Math.max(...intervals.all);
                return `
                    <div style="font-size:0.7rem;color:#7A8CB8;margin-bottom:8px;">
                        Avg <strong style="color:#F0EBE0;">${intervals.avg.toFixed(2)}s</strong>
                        &nbsp;·&nbsp; Min <strong style="color:#22c55e;">${intervals.min.toFixed(2)}s</strong>
                        &nbsp;·&nbsp; Max <strong style="color:#ef4444;">${intervals.max.toFixed(2)}s</strong>
                    </div>
                    ${intervals.all.map((g, i) => {
                        const pct = maxGap > 0 ? (g / maxGap * 100) : 0;
                        const color = g > intervals.avg * 1.2 ? '#ef4444' : g < intervals.avg * 0.8 ? '#22c55e' : colorClass;
                        return `<div class="rl-interval-row">
                            <span style="width:28px;color:#7A8CB8;font-variant-numeric:tabular-nums;">${i+1}</span>
                            <div class="rl-interval-fill" style="width:${Math.max(pct,2)}%; background:${color};"></div>
                            <span style="color:${color}; font-weight:600;">${g.toFixed(2)}s</span>
                        </div>`;
                    }).join('')}`;
            }

            document.getElementById('runLabDrilldown').innerHTML = `
                <div class="rl-drilldown-header">
                    <span class="rl-drilldown-title">🔍 ${escapeHtml(skill)} — Cast Drilldown</span>
                    <button class="rl-drilldown-close" onclick="drilldownSkill('${escapeHtml(skill)}')">✕ Close</button>
                </div>
                <div class="rl-drilldown-grid">
                    <div>
                        <div style="font-size:0.68rem;font-weight:700;color:#D96444;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;">
                            Run A — ${row.castsA.length} casts · avg ${formatNumber(Math.round(row.avgA))}/cast
                        </div>
                        <div class="rl-cast-list">${castList(row.castsA,'rl-cell-a')}</div>
                        <div style="margin-top:12px; font-size:0.68rem;font-weight:700;color:#7A8CB8;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;">Cast Intervals (A)</div>
                        ${intervalSection(row.intervalsA, row.castsA, '#D96444')}
                    </div>
                    <div>
                        <div style="font-size:0.68rem;font-weight:700;color:#5B92D4;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;">
                            Run B — ${row.castsB.length} casts · avg ${formatNumber(Math.round(row.avgB))}/cast
                        </div>
                        <div class="rl-cast-list">${castList(row.castsB,'rl-cell-b')}</div>
                        <div style="margin-top:12px; font-size:0.68rem;font-weight:700;color:#7A8CB8;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;">Cast Intervals (B)</div>
                        ${intervalSection(row.intervalsB, row.castsB, '#5B92D4')}
                    </div>
                </div>`;
        }

        function toggleRunLabSkill(skill) {
            if (runLabVisibleSkills.has(skill)) runLabVisibleSkills.delete(skill);
            else runLabVisibleSkills.add(skill);
            renderRunLabToggles();
            const runA = sessionQueue.find(i => i.runLabSlot === 'A');
            const runB = sessionQueue.find(i => i.runLabSlot === 'B');
            if (runA && runB) renderRunLabPiano(runA, runB);
        }

        function runLabShowAll() {
            runLabMatrix.forEach(r => runLabVisibleSkills.add(r.skill));
            renderRunLabToggles();
            const runA = sessionQueue.find(i => i.runLabSlot === 'A');
            const runB = sessionQueue.find(i => i.runLabSlot === 'B');
            if (runA && runB) renderRunLabPiano(runA, runB);
        }

        function runLabShowNone() {
            runLabVisibleSkills.clear();
            renderRunLabToggles();
            const runA = sessionQueue.find(i => i.runLabSlot === 'A');
            const runB = sessionQueue.find(i => i.runLabSlot === 'B');
            if (runA && runB) renderRunLabPiano(runA, runB);
        }
        
        // Build Testing sub-tab switching
        function switchBuildTestSubtab(subtab) {
            // Update button styles
            document.querySelectorAll('.bt-folder-tab').forEach(btn => {
                if (btn.dataset.subtab === subtab) {
                    btn.classList.add('active');
                } else {
                    btn.classList.remove('active');
                }
            });

            // Show/hide content
            document.querySelectorAll('.bt-subtab-content').forEach(content => {
                content.style.display = 'none';
            });
            const targetContent = document.getElementById('bt-' + subtab);
            if (targetContent) {
                targetContent.style.display = 'block';
            }

            // Re-render Run Lab when switching to it
            if (subtab === 'runlab') {
                runLabVisibleSkills = new Set(); // reset visibility on each open so top skills show
                runLabDrilldownSkill = null;
                renderRunLab();
            }
        }
        
        // === SUMMARY TAB UPDATE ===
        function updateSummaryTab(data) {
            // For live data, 60s stats are at top level with _60s suffix
            // For loaded encounters, they're in first_60s object
            const hasFirst60s = data.first_60s && typeof data.first_60s === 'object';
            
            // Get 60s stats - prioritize first_60s object, then _60s fields, then fall back to overall
            const dps60 = hasFirst60s ? (data.first_60s.dps || 0) : (data.dps_60s || 0);
            const damage60 = hasFirst60s ? (data.first_60s.total_damage || 0) : (data.damage_60s || 0);
            const hits60 = hasFirst60s ? (data.first_60s.hit_count || 0) : (data.hit_count_60s || 0);
            const critRate60 = hasFirst60s ? (data.first_60s.crit_rate || 0) : (data.crit_rate_60s || 0);
            const heavyRate60 = hasFirst60s ? (data.first_60s.heavy_rate || 0) : (data.heavy_rate_60s || 0);
            const critHeavyRate60 = hasFirst60s ? (data.first_60s.crit_heavy_rate || 0) : (data.crit_heavy_rate_60s || 0);
            
            // Update stats display
            document.getElementById('summaryDps').textContent = formatNumber(Math.round(dps60));
            document.getElementById('summaryDamage').textContent = formatNumber(damage60);
            document.getElementById('summaryHits').textContent = formatNumber(hits60);
            
            const avgHit = hits60 > 0 ? Math.round(damage60 / hits60) : 0;
            document.getElementById('summaryAvgHit').textContent = formatNumber(avgHit);
            
            // Rates
            const normalRate = Math.max(0, 100 - critRate60 - heavyRate60 + critHeavyRate60);
            
            document.getElementById('summaryNormal').textContent = normalRate.toFixed(1) + '%';
            document.getElementById('summaryCrit').textContent = critRate60.toFixed(1) + '%';
            document.getElementById('summaryHeavy').textContent = heavyRate60.toFixed(1) + '%';
            document.getElementById('summaryCritHeavy').textContent = critHeavyRate60.toFixed(1) + '%';
            
            // Top 5 Skills (from 60s data)
            const skills = data.skills_60s || (hasFirst60s ? data.first_60s.skills : null) || data.skills || [];
            const top5 = skills.slice(0, 5);
            const maxDamage = top5.length > 0 ? top5[0].damage : 1;
            
            const topSkillsHtml = top5.map((skill, i) => {
                const pct = (skill.damage / maxDamage) * 100;
                const colors = ['#5B92D4', '#D96444', '#fbbf24', '#22c55e', '#f472b6'];
                return `
                    <div style="display: flex; align-items: center; gap: 12px;">
                        <div style="width: 24px; text-align: center; font-size: 0.8rem; font-weight: 700; color: ${colors[i]};">#${i + 1}</div>
                        <div style="flex: 1;">
                            <div style="display: flex; justify-content: space-between; margin-bottom: 4px;">
                                <span style="font-size: 0.85rem; color: #F0EBE0;">${skill.name}</span>
                                <span style="font-size: 0.85rem; font-weight: 600; color: ${colors[i]};">${formatNumber(skill.damage)}</span>
                            </div>
                            <div style="height: 6px; background: rgba(21, 32, 53, 0.6); border-radius: 3px; overflow: hidden;">
                                <div style="height: 100%; width: ${pct}%; background: ${colors[i]}; border-radius: 3px;"></div>
                            </div>
                        </div>
                    </div>
                `;
            }).join('');
            
            document.getElementById('summaryTopSkills').innerHTML = topSkillsHtml || '<div style="color: #7A8CB8; text-align: center; padding: 20px;">No skills recorded</div>';
            
            // Piano Roll (reuse existing function but target summaryPianoRoll)
            updateSummaryPianoRoll(data.rotation_60s || []);
        }
        
        function updateSummaryPianoRoll(rotation) {
            const container = document.getElementById('summaryPianoRoll');
            if (!container) return;
            
            if (!rotation || rotation.length === 0) {
                container.innerHTML = `
                    <div class="piano-roll-empty">
                        <div style="font-size: 1.5rem; margin-bottom: 8px;">🎹</div>
                        <div>Start combat to see skill timeline</div>
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
            
            container.innerHTML = html;
        }
        
        // === GLOBAL BANNER LIBRARY COUNTS ===
        function updateLibraryCountsBanner() {
            const banner = document.getElementById('libraryCountsBanner');
            if (!banner) return;
            
            const testCount = savedEncounters ? savedEncounters.length : 0;
            const runCount = runSummaryData ? runSummaryData.length : 0;
            
            if (testCount === 0 && runCount === 0) {
                banner.textContent = 'Library: no saved data yet';
            } else {
                const parts = [];
                if (testCount > 0) parts.push(`${testCount} test${testCount !== 1 ? 's' : ''}`);
                if (runCount > 0) parts.push(`${runCount} run${runCount !== 1 ? 's' : ''}`);
                banner.textContent = 'Library: ' + parts.join(' • ');
            }
        }
        
        // === RUN SUMMARY TAB ===
        let runSummaryData = [];
        
        function loadRunSummary() {
            // Request saved runs for the summary tab
            if (!ws || ws.readyState !== WebSocket.OPEN) {
                document.getElementById('runSummaryContent').innerHTML = '<div style="color: #ef4444; text-align: center; padding: 40px;">Not connected</div>';
                return;
            }
            ws.send(JSON.stringify({ command: 'get_saved_runs' }));
        }
        
        function renderRunSummary(runs) {
            runSummaryData = runs || [];
            updateLibraryCountsBanner();
            updateDashboard();
            filterRunSummary(); // Apply filters and render
        }
        
        // Type color mapping
        const runSummaryTypeStyles = {
            'Co-op Dungeon': { color: '#3b82f6', icon: '🏰' },
            'Raid': { color: '#ec4899', icon: '⚔️' },
            'Field Boss': { color: '#5B92D4', icon: '🐉' },
            'Archboss': { color: '#fbbf24', icon: '👹' },
            'Custom': { color: '#7A8CB8', icon: '📦' }
        };
        
        // Track expanded states
        let expandedNavItems = new Set();
        let selectedNavPath = []; // e.g., ['Co-op Dungeon', 'Dimensional Trial', 'Crypt']
        let expandedRunTimelines = new Set();
        let expandedTiers = new Set(); // For tiers within detail panel
        
        // Helper to extract type from run data
        function getRunType(run) {
            // First try dungeon_info.type
            if (run.dungeon_info?.type) {
                return run.dungeon_info.type;
            }
            // Fallback: parse from dungeon_category (e.g., "Co-op Dungeon - Dimensional Circle T5")
            const category = run.dungeon_category || '';
            if (category.startsWith('Co-op Dungeon')) return 'Co-op Dungeon';
            if (category.startsWith('Raid')) return 'Raid';
            if (category.startsWith('Field Boss')) return 'Field Boss';
            if (category.startsWith('Archboss')) return 'Archboss';
            return 'Custom';
        }
        
        // Helper to extract mode from run data
        function getRunMode(run) {
            if (run.dungeon_info?.mode) {
                return run.dungeon_info.mode;
            }
            // Fallback: parse from dungeon_category
            const category = run.dungeon_category || '';
            if (category.includes('Dimensional Circle')) return 'Dimensional Circle';
            if (category.includes('Dimensional Trial')) return 'Dimensional Trial';
            if (category.includes('Normal')) return 'Normal';
            if (category.includes('Difficult')) return 'Difficult';
            if (category.includes('Nightmare')) return 'Nightmare';
            if (category.includes('Ascended')) return 'Ascended';
            return '';
        }
        
        // Helper to extract tier from run data
        function getRunTier(run) {
            if (run.dungeon_info?.tier) {
                return run.dungeon_info.tier;
            }
            // Fallback: parse from dungeon_category (look for T followed by number)
            const category = run.dungeon_category || '';
            const tierMatch = category.match(/T(\d+)/);
            return tierMatch ? tierMatch[1] : '';
        }
        
        // Helper to compute boss/adds damage from a run
        // Falls back to computing from encounters if stats don't have the breakdown
        function getRunDamageStats(run) {
            const stats = run.stats || {};
            const encounters = run.encounters || [];
            
            let bossDamage = stats.boss_damage || 0;
            let addsDamage = stats.trash_damage || 0;
            
            // If no breakdown in stats, compute from encounters
            if (bossDamage === 0 && addsDamage === 0 && encounters.length > 0) {
                const bossCategories = ['archboss', 'raid_boss', 'field_boss', 'dungeon_boss'];
                
                encounters.forEach(enc => {
                    const cat = enc.category || 'other';
                    const dmg = enc.total_damage || 0;
                    
                    if (bossCategories.includes(cat)) {
                        bossDamage += dmg;
                    } else if (cat === 'adds' || cat === 'dungeon_adds') {
                        addsDamage += dmg;
                    }
                });
                
                // If still no categorized damage, put all in "other" which we'll show as total
                if (bossDamage === 0 && addsDamage === 0) {
                    // Use total_damage as boss damage for display purposes
                    bossDamage = stats.total_damage || encounters.reduce((sum, e) => sum + (e.total_damage || 0), 0);
                }
            }
            
            return { bossDamage, addsDamage };
        }
        
        // Helper to aggregate damage stats for multiple runs
        function aggregateRunsDamage(runs) {
            let totalBoss = 0;
            let totalAdds = 0;
            runs.forEach(r => {
                const { bossDamage, addsDamage } = getRunDamageStats(r);
                totalBoss += bossDamage;
                totalAdds += addsDamage;
            });
            return { bossDamage: totalBoss, addsDamage: totalAdds };
        }
        
        // Build navigation tree structure from runs
        function buildRunNavTree(runs) {
            const tree = {};
            
            runs.forEach(run => {
                const type = getRunType(run);
                const mode = getRunMode(run);
                const dungeon = run.dungeon_info?.name || run.dungeon_name || 'Unknown';
                const tier = getRunTier(run);
                
                if (!tree[type]) tree[type] = {};
                
                if (type === 'Co-op Dungeon') {
                    // Co-op: Type → Mode (Dim Circle/Trial) → Dungeon
                    const coopMode = mode || 'Other';
                    if (!tree[type][coopMode]) tree[type][coopMode] = {};
                    if (!tree[type][coopMode][dungeon]) tree[type][coopMode][dungeon] = [];
                    tree[type][coopMode][dungeon].push(run);
                } else if (type === 'Raid') {
                    // Raid: Type → Raid Name → Difficulty
                    const difficulty = mode || 'Normal';
                    if (!tree[type][dungeon]) tree[type][dungeon] = {};
                    if (!tree[type][dungeon][difficulty]) tree[type][dungeon][difficulty] = [];
                    tree[type][dungeon][difficulty].push(run);
                } else if (type === 'Field Boss' || type === 'Archboss') {
                    // Field/Arch: Type → Difficulty → Boss
                    const difficulty = mode || 'Normal';
                    if (!tree[type][difficulty]) tree[type][difficulty] = {};
                    if (!tree[type][difficulty][dungeon]) tree[type][difficulty][dungeon] = [];
                    tree[type][difficulty][dungeon].push(run);
                } else {
                    // Custom/Other: Type → Dungeon
                    if (!tree[type][dungeon]) tree[type][dungeon] = [];
                    if (Array.isArray(tree[type][dungeon])) {
                        tree[type][dungeon].push(run);
                    }
                }
            });
            
            return tree;
        }
        
        // Type styles for nav items
        const navTypeStyles = {
            'Co-op Dungeon': { icon: '🏰', color: '#3b82f6' },
            'Raid': { icon: '⚔️', color: '#ec4899' },
            'Field Boss': { icon: '🐉', color: '#5B92D4' },
            'Archboss': { icon: '👹', color: '#fbbf24' },
            'Custom': { icon: '📦', color: '#7A8CB8' }
        };
        
        function filterRunSummary() {
            renderRunSummaryNav();
            renderRunSummaryDetail();
        }
        
        function renderRunSummaryNav() {
            const navContainer = document.getElementById('runSummaryNavTree');
            if (!navContainer) return;
            
            if (runSummaryData.length === 0) {
                navContainer.innerHTML = `
                    <div style="color: #7A8CB8; text-align: center; padding: 40px 16px;">
                        <div style="font-size: 2.5rem; margin-bottom: 12px; opacity: 0.4;">📁</div>
                        <div style="font-size: 0.85rem; margin-bottom: 4px;">No saved runs yet</div>
                        <div style="font-size: 0.75rem; opacity: 0.7;">Use Run Builder to save runs</div>
                    </div>
                `;
                return;
            }
            
            const tree = buildRunNavTree(runSummaryData);
            let html = '';
            
            // Define type order
            const typeOrder = ['Co-op Dungeon', 'Raid', 'Field Boss', 'Archboss', 'Custom'];
            const sortedTypes = Object.keys(tree).sort((a, b) => {
                const ia = typeOrder.indexOf(a);
                const ib = typeOrder.indexOf(b);
                if (ia === -1 && ib === -1) return a.localeCompare(b);
                if (ia === -1) return 1;
                if (ib === -1) return -1;
                return ia - ib;
            });
            
            sortedTypes.forEach(type => {
                const style = navTypeStyles[type] || navTypeStyles['Custom'];
                const typeKey = type;
                const isTypeExpanded = expandedNavItems.has(typeKey);
                const isTypeSelected = selectedNavPath[0] === type && selectedNavPath.length === 1;
                
                // Count total runs under this type
                let typeRunCount = 0;
                const countRuns = (obj) => {
                    if (Array.isArray(obj)) return obj.length;
                    return Object.values(obj).reduce((sum, v) => sum + countRuns(v), 0);
                };
                typeRunCount = countRuns(tree[type]);
                const typeKeyEsc = typeKey.replace(/'/g, "\\'");
                
                // Main type folder - large card style
                html += `
                    <div class="nav-folder" style="margin-bottom: 8px;">
                        <div onclick="toggleNavItem('${typeKeyEsc}')" 
                             style="display: flex; align-items: center; gap: 12px; padding: 14px 16px; 
                                    background: linear-gradient(135deg, ${style.color}15 0%, ${style.color}08 100%);
                                    border: 1px solid ${isTypeExpanded ? style.color + '50' : style.color + '25'}; 
                                    border-radius: 10px; cursor: pointer; 
                                    transition: all 0.2s ease;
                                    ${isTypeExpanded ? `box-shadow: 0 4px 12px ${style.color}20;` : ''}">
                            <div style="width: 42px; height: 42px; background: ${style.color}25; border-radius: 10px; 
                                        display: flex; align-items: center; justify-content: center; font-size: 1.4rem;
                                        border: 1px solid ${style.color}30;">
                                ${style.icon}
                            </div>
                            <div style="flex: 1;">
                                <div style="color: #F0EBE0; font-size: 1rem; font-weight: 700; margin-bottom: 2px;">
                                    ${type === 'Co-op Dungeon' ? 'Co-op Dungeons' : type}
                                </div>
                                <div style="color: ${style.color}; font-size: 0.75rem;">
                                    ${typeRunCount} run${typeRunCount !== 1 ? 's' : ''} saved
                                </div>
                            </div>
                            <span style="color: ${isTypeExpanded ? style.color : '#7A8CB8'}; font-size: 1rem; 
                                         transition: transform 0.2s; ${isTypeExpanded ? 'transform: rotate(90deg);' : ''}">▸</span>
                        </div>
                `;
                
                // Expanded type content
                if (isTypeExpanded) {
                    html += `<div style="margin: 8px 0 0 8px; padding-left: 12px; border-left: 2px solid ${style.color}30;">`;
                    html += renderNavLevel2(type, tree[type], style);
                    html += `</div>`;
                }
                
                html += `</div>`;
            });
            
            // Add Loot Summary tab at the bottom
            const lootDropCount = runSummaryData.filter(r => r.got_loot === true).length;
            const isLootSelected = selectedNavPath[0] === 'LootSummary';
            
            html += `
                <div style="margin-top: 16px; padding-top: 12px; border-top: 1px solid #263956;">
                    <div onclick="selectNavItem('LootSummary')" 
                         style="display: flex; align-items: center; gap: 12px; padding: 14px 16px; 
                                background: linear-gradient(135deg, ${isLootSelected ? '#22c55e30' : '#22c55e15'} 0%, ${isLootSelected ? '#22c55e20' : '#22c55e08'} 100%);
                                border: 1px solid ${isLootSelected ? '#22c55e50' : '#22c55e25'}; 
                                border-radius: 10px; cursor: pointer; 
                                transition: all 0.2s ease;
                                ${isLootSelected ? 'box-shadow: 0 4px 12px rgba(34, 197, 94, 0.2);' : ''}">
                        <div style="width: 42px; height: 42px; background: #22c55e25; border-radius: 10px; 
                                    display: flex; align-items: center; justify-content: center; font-size: 1.4rem;
                                    border: 1px solid #22c55e30;">
                            🎁
                        </div>
                        <div style="flex: 1;">
                            <div style="color: #F0EBE0; font-size: 1rem; font-weight: 700; margin-bottom: 2px;">
                                Loot Summary
                            </div>
                            <div style="color: #22c55e; font-size: 0.75rem;">
                                ${lootDropCount} drop${lootDropCount !== 1 ? 's' : ''} recorded
                            </div>
                        </div>
                    </div>
                </div>
            `;
            
            navContainer.innerHTML = html;
        }
        
        // Icons for level 2/3 items
        const navSubIcons = {
            // Co-op modes
            'Dimensional Circle': '🔵',
            'Dimensional Trial': '🔴',
            // Raid difficulties  
            'Normal': '⚪',
            'Difficult': '🟡',
            'Nightmare': '🔴',
            // Boss difficulties
            'Ascended': '⭐',
            // Default dungeon/boss
            'dungeon': '🏛️',
            'boss': '💀'
        };
        
        function renderNavLevel2(type, level2Data, style) {
            let html = '';
            const level2Keys = Object.keys(level2Data).sort();
            
            level2Keys.forEach(level2Key => {
                const navKey = `${type}|${level2Key}`;
                const isExpanded = expandedNavItems.has(navKey);
                const isSelected = selectedNavPath[0] === type && selectedNavPath[1] === level2Key && selectedNavPath.length === 2;
                const level2Value = level2Data[level2Key];
                
                // Escape for onclick
                const typeEsc = type.replace(/'/g, "\\'");
                const level2Esc = level2Key.replace(/'/g, "\\'");
                const navKeyEsc = navKey.replace(/'/g, "\\'");
                
                // Check if this is a leaf (array of runs) or has more levels
                const isLeaf = Array.isArray(level2Value);
                const runCount = isLeaf ? level2Value.length : Object.values(level2Value).reduce((sum, v) => {
                    if (Array.isArray(v)) return sum + v.length;
                    return sum + Object.values(v).reduce((s, arr) => s + (Array.isArray(arr) ? arr.length : 0), 0);
                }, 0);
                
                // Get icon for this level
                const level2Icon = navSubIcons[level2Key] || (type === 'Raid' ? '🏯' : navSubIcons['dungeon']);
                
                html += `
                    <div style="margin-bottom: 6px;">
                        <div onclick="${isLeaf ? `selectNavItem('${typeEsc}', '${level2Esc}')` : `toggleNavItem('${navKeyEsc}')`}" 
                             style="display: flex; align-items: center; gap: 10px; padding: 10px 12px; 
                                    background: ${isExpanded || isSelected ? 'rgba(217, 100, 68, 0.12)' : 'rgba(29, 47, 80, 0.4)'}; 
                                    border-radius: 8px; cursor: pointer; 
                                    border: 1px solid ${isExpanded || isSelected ? 'rgba(217, 100, 68, 0.3)' : 'transparent'};
                                    transition: all 0.15s ease;">
                            <div style="width: 28px; height: 28px; background: ${isExpanded || isSelected ? 'rgba(217, 100, 68, 0.2)' : 'rgba(38, 57, 86, 0.6)'}; 
                                        border-radius: 6px; display: flex; align-items: center; justify-content: center; font-size: 0.9rem;">
                                ${level2Icon}
                            </div>
                            <div style="flex: 1;">
                                <div style="color: ${isExpanded || isSelected ? '#D96444' : '#F0EBE0'}; font-size: 0.9rem; font-weight: ${isExpanded || isSelected ? '600' : '500'};">
                                    ${escapeHtml(level2Key)}
                                </div>
                            </div>
                            <span style="font-size: 0.7rem; color: #7A8CB8; background: rgba(122, 140, 184, 0.2); padding: 2px 8px; border-radius: 10px;">
                                ${runCount}
                            </span>
                            ${!isLeaf ? `<span style="color: ${isExpanded ? '#D96444' : '#405A85'}; font-size: 0.8rem; transition: transform 0.2s; ${isExpanded ? 'transform: rotate(90deg);' : ''}">▸</span>` : ''}
                        </div>
                `;
                
                // Level 3 (dungeons/difficulties/bosses)
                if (!isLeaf && isExpanded) {
                    html += `<div style="margin: 6px 0 0 20px; padding-left: 12px; border-left: 2px solid rgba(217, 100, 68, 0.2);">`;
                    const level3Keys = Object.keys(level2Value).sort();
                    
                    level3Keys.forEach(level3Key => {
                        const level3NavKey = `${type}|${level2Key}|${level3Key}`;
                        const level3Value = level2Value[level3Key];
                        const isLevel3Leaf = Array.isArray(level3Value);
                        const isLevel3Selected = selectedNavPath[0] === type && selectedNavPath[1] === level2Key && selectedNavPath[2] === level3Key;
                        const level3Esc = level3Key.replace(/'/g, "\\'");
                        
                        const level3RunCount = isLevel3Leaf ? level3Value.length : Object.values(level3Value).reduce((sum, arr) => sum + (Array.isArray(arr) ? arr.length : 0), 0);
                        
                        // Icon for level 3 - dungeons get dungeon icon, bosses get boss icon
                        const level3Icon = navSubIcons[level3Key] || (type === 'Field Boss' || type === 'Archboss' ? '💀' : '🏛️');
                        
                        html += `
                            <div onclick="selectNavItem('${typeEsc}', '${level2Esc}', '${level3Esc}')" 
                                 style="display: flex; align-items: center; gap: 8px; padding: 8px 10px; margin-bottom: 4px;
                                        background: ${isLevel3Selected ? 'rgba(91, 146, 212, 0.15)' : 'transparent'}; 
                                        border-radius: 6px; cursor: pointer; 
                                        border: 1px solid ${isLevel3Selected ? 'rgba(91, 146, 212, 0.3)' : 'transparent'};
                                        transition: all 0.15s ease;">
                                <span style="font-size: 0.85rem;">${level3Icon}</span>
                                <span style="flex: 1; color: ${isLevel3Selected ? '#5B92D4' : '#F0EBE0'}; font-size: 0.85rem; font-weight: ${isLevel3Selected ? '600' : '400'};">
                                    ${escapeHtml(level3Key)}
                                </span>
                                <span style="font-size: 0.65rem; color: #7A8CB8; background: rgba(122, 140, 184, 0.15); padding: 1px 6px; border-radius: 8px;">
                                    ${level3RunCount}
                                </span>
                            </div>
                        `;
                    });
                    
                    html += `</div>`;
                }
                
                html += `</div>`;
            });
            
            return html;
        }
        
        function toggleNavItem(navKey) {
            if (expandedNavItems.has(navKey)) {
                expandedNavItems.delete(navKey);
            } else {
                expandedNavItems.add(navKey);
            }
            // Also update selected path to show summary stats
            const parts = navKey.split('|');
            selectedNavPath = parts;
            renderRunSummaryNav();
            renderRunSummaryDetail();
        }
        
        function selectNavItem(type, level2, level3) {
            if (level3) {
                selectedNavPath = [type, level2, level3];
            } else if (level2) {
                selectedNavPath = [type, level2];
            } else {
                selectedNavPath = [type];
            }
            renderRunSummaryNav();
            renderRunSummaryDetail();
        }
        
        // Helper to collect all runs from a tree node (recursively)
        function collectRunsFromNode(node) {
            if (Array.isArray(node)) return node;
            let runs = [];
            Object.values(node).forEach(child => {
                runs = runs.concat(collectRunsFromNode(child));
            });
            return runs;
        }
        
        function renderRunSummaryDetail() {
            const detailContainer = document.getElementById('runSummaryDetail');
            if (!detailContainer) return;
            
            if (selectedNavPath.length === 0) {
                detailContainer.innerHTML = `
                    <div style="color: #7A8CB8; text-align: center; padding: 60px 20px;">
                        <div style="font-size: 2rem; margin-bottom: 12px; opacity: 0.5;">👈</div>
                        <div style="font-size: 0.9rem;">Select a category to view runs</div>
                    </div>
                `;
                return;
            }
            
            // Handle Loot Summary special case
            if (selectedNavPath[0] === 'LootSummary') {
                renderLootSummaryDetail(detailContainer);
                return;
            }
            
            const tree = buildRunNavTree(runSummaryData);
            const [type, level2, level3] = selectedNavPath;
            const style = navTypeStyles[type] || navTypeStyles['Custom'];
            
            // Navigate to the selected node and collect runs
            let runs = [];
            let title = '';
            let subtitle = '';
            let icon = style.icon;
            let hasTiers = false;
            let isLeafLevel = false;
            let childBreakdown = []; // For showing sub-category stats
            
            if (!tree[type]) {
                detailContainer.innerHTML = `
                    <div style="color: #7A8CB8; text-align: center; padding: 60px 20px;">
                        <div style="font-size: 2rem; margin-bottom: 12px; opacity: 0.5;">📭</div>
                        <div style="font-size: 0.9rem;">No runs found</div>
                    </div>
                `;
                return;
            }
            
            if (type && !level2) {
                // Type level only (e.g., "Co-op Dungeon")
                runs = collectRunsFromNode(tree[type]);
                title = type === 'Co-op Dungeon' ? 'Co-op Dungeons' : type;
                subtitle = 'All runs';
                // Build child breakdown
                Object.keys(tree[type]).forEach(childKey => {
                    const childRuns = collectRunsFromNode(tree[type][childKey]);
                    const { bossDamage, addsDamage } = aggregateRunsDamage(childRuns);
                    childBreakdown.push({
                        name: childKey,
                        runCount: childRuns.length,
                        bossDamage,
                        addsDamage,
                        icon: navSubIcons[childKey] || '📁'
                    });
                });
            } else if (type && level2 && !level3) {
                // Level 2 (e.g., "Dimensional Trial" or "Normal")
                const level2Node = tree[type]?.[level2];
                if (level2Node) {
                    runs = collectRunsFromNode(level2Node);
                    title = level2;
                    subtitle = type === 'Co-op Dungeon' ? 'Co-op' : type;
                    icon = navSubIcons[level2] || style.icon;
                    // Build child breakdown
                    if (!Array.isArray(level2Node)) {
                        Object.keys(level2Node).forEach(childKey => {
                            const childRuns = collectRunsFromNode(level2Node[childKey]);
                            const { bossDamage, addsDamage } = aggregateRunsDamage(childRuns);
                            childBreakdown.push({
                                name: childKey,
                                runCount: childRuns.length,
                                bossDamage,
                                addsDamage,
                                icon: navSubIcons[childKey] || (type === 'Field Boss' || type === 'Archboss' ? '💀' : '🏛️')
                            });
                        });
                    }
                }
            } else if (type === 'Co-op Dungeon' && level2 && level3) {
                // Co-op → Mode → Dungeon (leaf)
                runs = tree[type]?.[level2]?.[level3] || [];
                title = level3;
                subtitle = level2;
                icon = '🏛️';
                hasTiers = level2 === 'Dimensional Trial';
                isLeafLevel = true;
            } else if (type === 'Raid' && level2 && level3) {
                // Raid → Raid Name → Difficulty (leaf)
                runs = tree[type]?.[level2]?.[level3] || [];
                title = level2;
                subtitle = level3;
                icon = navSubIcons[level3] || '⚔️';
                isLeafLevel = true;
            } else if ((type === 'Field Boss' || type === 'Archboss') && level2 && level3) {
                // Field/Arch → Difficulty → Boss (leaf)
                runs = tree[type]?.[level2]?.[level3] || [];
                title = level3;
                subtitle = `${type} · ${level2}`;
                icon = '💀';
                isLeafLevel = true;
            } else if (type === 'Custom' && level2) {
                runs = tree[type]?.[level2] || [];
                title = level2;
                subtitle = 'Custom';
                isLeafLevel = true;
            }
            
            if (runs.length === 0) {
                detailContainer.innerHTML = `
                    <div style="color: #7A8CB8; text-align: center; padding: 60px 20px;">
                        <div style="font-size: 2rem; margin-bottom: 12px; opacity: 0.5;">📭</div>
                        <div style="font-size: 0.9rem;">No runs found</div>
                    </div>
                `;
                return;
            }
            
            const { bossDamage: totalBoss, addsDamage: totalAdds } = aggregateRunsDamage(runs);
            
            // Calculate average DPS across all runs
            const totalDuration = runs.reduce((sum, r) => sum + (r.stats?.duration || 0), 0);
            const avgDps = totalDuration > 0 ? Math.round((totalBoss + totalAdds) / totalDuration) : 0;
            
            let html = `
                <div style="margin-bottom: 20px; padding-bottom: 20px; border-bottom: 1px solid #263956;">
                    <div style="display: flex; align-items: center; gap: 14px; margin-bottom: 12px;">
                        <div style="width: 52px; height: 52px; background: ${style.color}20; border-radius: 12px; 
                                    display: flex; align-items: center; justify-content: center; font-size: 1.8rem;
                                    border: 1px solid ${style.color}30;">
                            ${icon}
                        </div>
                        <div>
                            <h3 style="margin: 0; color: #F0EBE0; font-size: 1.3rem; font-weight: 700;">${escapeHtml(title)}</h3>
                            <div style="color: ${style.color}; font-size: 0.85rem;">${escapeHtml(subtitle)}</div>
                        </div>
                    </div>
                    
                    <!-- Stats Cards -->
                    <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px;">
                        <div style="background: rgba(29, 47, 80, 0.5); padding: 12px; border-radius: 8px; text-align: center;">
                            <div style="font-size: 0.7rem; color: #7A8CB8; text-transform: uppercase; margin-bottom: 4px;">Runs</div>
                            <div style="font-size: 1.4rem; font-weight: 700; color: #F0EBE0;">${runs.length}</div>
                        </div>
                        <div style="background: rgba(59, 130, 246, 0.1); padding: 12px; border-radius: 8px; text-align: center; border: 1px solid rgba(59, 130, 246, 0.2);">
                            <div style="font-size: 0.7rem; color: #3b82f6; text-transform: uppercase; margin-bottom: 4px;">⚔️ Boss Damage</div>
                            <div style="font-size: 1.4rem; font-weight: 700; color: #3b82f6;">${formatCompactNumber(totalBoss)}</div>
                        </div>
                        <div style="background: rgba(239, 68, 68, 0.1); padding: 12px; border-radius: 8px; text-align: center; border: 1px solid rgba(239, 68, 68, 0.2);">
                            <div style="font-size: 0.7rem; color: #ef4444; text-transform: uppercase; margin-bottom: 4px;">💀 Adds Damage</div>
                            <div style="font-size: 1.4rem; font-weight: 700; color: #ef4444;">${formatCompactNumber(totalAdds)}</div>
                        </div>
                        <div style="background: rgba(91, 146, 212, 0.1); padding: 12px; border-radius: 8px; text-align: center; border: 1px solid rgba(91, 146, 212, 0.2);">
                            <div style="font-size: 0.7rem; color: #5B92D4; text-transform: uppercase; margin-bottom: 4px;">📊 Avg DPS</div>
                            <div style="font-size: 1.4rem; font-weight: 700; color: #5B92D4;">${formatCompactNumber(avgDps)}</div>
                        </div>
                    </div>
                </div>
            `;
            
            // If not at leaf level, show child breakdown cards
            if (!isLeafLevel && childBreakdown.length > 0) {
                html += `
                    <div style="margin-bottom: 16px;">
                        <div style="font-size: 0.8rem; color: #7A8CB8; text-transform: uppercase; margin-bottom: 12px;">Breakdown</div>
                        <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 10px;">
                `;
                
                // Sort by run count descending
                childBreakdown.sort((a, b) => b.runCount - a.runCount);
                
                childBreakdown.forEach(child => {
                    const childTotal = child.bossDamage + child.addsDamage;
                    html += `
                        <div style="background: rgba(29, 47, 80, 0.5); padding: 12px 14px; border-radius: 8px; border: 1px solid #263956;">
                            <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 8px;">
                                <span style="font-size: 1.1rem;">${child.icon}</span>
                                <span style="flex: 1; color: #F0EBE0; font-size: 0.9rem; font-weight: 600;">${escapeHtml(child.name)}</span>
                                <span style="font-size: 0.7rem; color: #7A8CB8; background: rgba(122, 140, 184, 0.2); padding: 2px 6px; border-radius: 8px;">${child.runCount}</span>
                            </div>
                            <div style="display: flex; gap: 12px; font-size: 0.75rem;">
                                <span style="color: #3b82f6;">⚔️ ${formatCompactNumber(child.bossDamage)}</span>
                                <span style="color: #ef4444;">💀 ${formatCompactNumber(child.addsDamage)}</span>
                            </div>
                        </div>
                    `;
                });
                
                html += `</div></div>`;
                
                // Also show recent runs preview
                html += `
                    <div style="margin-top: 16px;">
                        <div style="font-size: 0.8rem; color: #7A8CB8; text-transform: uppercase; margin-bottom: 12px;">Recent Runs</div>
                `;
                // Show last 5 runs with context (tier/difficulty)
                const recentRuns = [...runs].sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, 5);
                html += renderRunsList(recentRuns, true);
                if (runs.length > 5) {
                    html += `<div style="color: #7A8CB8; font-size: 0.8rem; text-align: center; margin-top: 8px;">+ ${runs.length - 5} more runs</div>`;
                }
                html += `</div>`;
            } else if (hasTiers) {
                // Render runs grouped by tier for Dim Trial
                const tierGroups = {};
                runs.forEach(run => {
                    const tier = getRunTier(run) || 'Untiered';
                    if (!tierGroups[tier]) tierGroups[tier] = [];
                    tierGroups[tier].push(run);
                });
                
                // Sort tiers descending
                const tierKeys = Object.keys(tierGroups).sort((a, b) => {
                    if (a === 'Untiered') return 1;
                    if (b === 'Untiered') return -1;
                    return parseInt(b) - parseInt(a);
                });
                
                tierKeys.forEach(tierKey => {
                    const tierRuns = tierGroups[tierKey];
                    const tierExpandKey = `tier_${tierKey}`;
                    const isTierExpanded = expandedTiers.has(tierExpandKey);
                    const { bossDamage: tierBoss, addsDamage: tierAdds } = aggregateRunsDamage(tierRuns);
                    
                    html += `
                        <div style="margin-bottom: 8px;">
                            <div onclick="toggleDetailTier('${tierExpandKey}')" style="display: flex; align-items: center; gap: 8px; padding: 10px 12px; background: ${isTierExpanded ? 'rgba(217, 100, 68, 0.1)' : 'rgba(29, 47, 80, 0.5)'}; border-radius: 6px; cursor: pointer; border: 1px solid ${isTierExpanded ? 'rgba(217, 100, 68, 0.2)' : 'transparent'};">
                                <span style="color: ${isTierExpanded ? '#D96444' : '#7A8CB8'}; font-size: 0.75rem;">${isTierExpanded ? '▾' : '▸'}</span>
                                <span style="font-weight: 600; color: #F0EBE0; font-size: 0.9rem; flex: 1;">Tier ${tierKey} <span style="color: #7A8CB8; font-weight: 400;">(${tierRuns.length})</span></span>
                                <span style="font-size: 0.7rem; color: #3b82f6;">⚔️ ${formatCompactNumber(tierBoss)}</span>
                                <span style="font-size: 0.7rem; color: #ef4444; margin-left: 8px;">💀 ${formatCompactNumber(tierAdds)}</span>
                            </div>
                    `;
                    
                    if (isTierExpanded) {
                        html += `<div style="margin-left: 16px; margin-top: 8px; border-left: 2px solid #263956; padding-left: 12px;">`;
                        html += renderRunsList(tierRuns);
                        html += `</div>`;
                    }
                    
                    html += `</div>`;
                });
            } else {
                // Leaf level - render all runs directly
                html += renderRunsList(runs);
            }
            
            detailContainer.innerHTML = html;
        }
        
        function toggleDetailTier(tierKey) {
            if (expandedTiers.has(tierKey)) {
                expandedTiers.delete(tierKey);
            } else {
                expandedTiers.add(tierKey);
            }
            renderRunSummaryDetail();
        }
        
        // Helper function to render a list of runs
        // showContext: if true, shows tier/difficulty/dungeon context badge
        function renderRunsList(runs, showContext = false) {
            // Sort runs by date descending (newest first)
            const sortedRuns = [...runs].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
            
            let html = '';
            sortedRuns.forEach((run) => {
                const runExpandKey = run.run_id;
                const isRunExpanded = expandedRunTimelines.has(runExpandKey);
                const stats = run.stats || {};
                const date = new Date(run.created_at);
                const dateStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
                const { bossDamage, addsDamage } = getRunDamageStats(run);
                const playerClass = run.player_class || '';
                const buildTag = run.build_tag || '';
                const classDisplay = playerClass ? playerClass.split(':')[0] : '';
                
                // Get contribution and loot info
                const type = getRunType(run);
                const contributionPercent = run.contribution_percent;
                const gotLoot = run.got_loot === true;
                
                // Build contribution badge (only for Field Boss/Archboss with value entered)
                let contributionBadge = '';
                if ((type === 'Field Boss' || type === 'Archboss') && contributionPercent != null) {
                    contributionBadge = `<span style="font-size: 0.7rem; color: #fbbf24; background: rgba(251, 191, 36, 0.15); padding: 2px 6px; border-radius: 3px;" title="Contribution">📊 ${contributionPercent.toFixed(1)}%</span>`;
                }
                
                // Build loot badge
                let lootBadge = '';
                if (gotLoot) {
                    lootBadge = `<span style="font-size: 0.7rem; color: #22c55e; background: rgba(34, 197, 94, 0.15); padding: 2px 6px; border-radius: 3px;" title="${run.loot_item ? escapeHtml(run.loot_item) : 'Got loot'}">🎁</span>`;
                }
                
                // Build context badge (tier, difficulty, dungeon name)
                let contextBadge = '';
                if (showContext) {
                    const mode = getRunMode(run);
                    const tier = getRunTier(run);
                    const dungeon = run.dungeon_info?.name || run.dungeon_name || '';
                    
                    let contextParts = [];
                    
                    if (type === 'Co-op Dungeon') {
                        // Dimensional Trial: just show tier
                        if (mode === 'Dimensional Trial' && tier) {
                            contextParts.push(`T${tier}`);
                        }
                        // Dimensional Circle: no label needed
                    } else if (type === 'Raid') {
                        // Raid: show difficulty + raid name
                        if (mode) {
                            const modeIcon = mode === 'Nightmare' ? '🔴' : mode === 'Difficult' ? '🟡' : '⚪';
                            contextParts.push(`${modeIcon} ${mode}`);
                        }
                        if (dungeon) {
                            const shortName = dungeon.length > 15 ? dungeon.substring(0, 15) + '...' : dungeon;
                            contextParts.push(shortName);
                        }
                    } else if (type === 'Field Boss' || type === 'Archboss') {
                        // Boss: show difficulty + boss name
                        if (mode) {
                            const modeIcon = mode === 'Ascended' ? '⭐' : '⚪';
                            contextParts.push(`${modeIcon} ${mode}`);
                        }
                        if (dungeon) {
                            const shortName = dungeon.length > 15 ? dungeon.substring(0, 15) + '...' : dungeon;
                            contextParts.push(shortName);
                        }
                    }
                    
                    if (contextParts.length > 0) {
                        contextBadge = `<span style="font-size: 0.7rem; color: #D96444; background: rgba(217, 100, 68, 0.15); padding: 2px 6px; border-radius: 3px; white-space: nowrap;">${contextParts.join(' · ')}</span>`;
                    }
                }
                
                html += `
                    <div style="margin-bottom: 6px;">
                        <div style="display: flex; align-items: center; gap: 10px; padding: 10px 12px; background: ${isRunExpanded ? 'rgba(91, 146, 212, 0.1)' : 'rgba(29, 47, 80, 0.3)'}; border-radius: 6px; border: 1px solid ${isRunExpanded ? 'rgba(91, 146, 212, 0.2)' : 'transparent'};">
                            <span onclick="toggleRunTimeline('${runExpandKey}')" style="color: ${isRunExpanded ? '#5B92D4' : '#405A85'}; font-size: 0.8rem; cursor: pointer; padding: 4px;">${isRunExpanded ? '▾' : '▸'}</span>
                            <span onclick="toggleRunTimeline('${runExpandKey}')" style="color: #7A8CB8; font-size: 0.9rem; width: 65px; cursor: pointer;">${dateStr}</span>
                            <span onclick="toggleRunTimeline('${runExpandKey}')" style="flex: 1; color: #F0EBE0; font-size: 0.95rem; font-weight: 500; cursor: pointer; display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
                                ${escapeHtml(run.run_name || 'Untitled')}
                                ${contextBadge}
                                ${contributionBadge}
                                ${lootBadge}
                                ${classDisplay ? `<span style="font-size: 0.7rem; color: #5B92D4; background: rgba(91, 146, 212, 0.15); padding: 2px 6px; border-radius: 3px;">${escapeHtml(classDisplay)}</span>` : ''}
                                ${buildTag ? `<span style="font-size: 0.7rem; color: #7A8CB8;">${escapeHtml(buildTag)}</span>` : ''}
                            </span>
                            <span style="font-size: 0.8rem; color: #3b82f6;" title="Boss damage">⚔️${formatCompactNumber(bossDamage)}</span>
                            <span style="font-size: 0.8rem; color: #ef4444;" title="Adds damage">💀${formatCompactNumber(addsDamage)}</span>
                            <span style="font-size: 0.8rem; color: #7A8CB8;">${formatDuration(stats.duration || 0)}</span>
                            <button onclick="event.stopPropagation(); openEditRunModal('${run.run_id}')" style="padding: 4px 10px; background: #263956; border: none; color: #7A8CB8; border-radius: 4px; cursor: pointer; font-size: 0.7rem;" title="Edit run metadata">✏️</button>
                        </div>
                `;
                
                // Expanded run: timeline
                if (isRunExpanded) {
                    html += `<div style="margin-left: 32px; margin-top: 6px; margin-bottom: 8px; padding: 12px; background: rgba(0, 0, 0, 0.2); border-radius: 6px; border-left: 3px solid #5B92D4;">`;
                    html += renderRunTimeline(run);
                    html += `</div>`;
                }
                
                html += `</div>`;
            });
            
            return html;
        }
        
        function toggleRunTimeline(runId) {
            if (expandedRunTimelines.has(runId)) {
                expandedRunTimelines.delete(runId);
            } else {
                expandedRunTimelines.add(runId);
            }
            renderRunSummaryDetail();
        }
        
        // Keep old toggle functions for compatibility but they won't be used
        function toggleSummaryCard(cardKey) { }
        function toggleSummaryTier(tierKey) { }
        function toggleSummaryRun(runId) { }
        
        // Render Loot Summary detail panel
        function renderLootSummaryDetail(container) {
            const lootRuns = runSummaryData.filter(r => r.got_loot === true);
            const totalRuns = runSummaryData.length;
            const lootDropCount = lootRuns.length;
            const dropRate = totalRuns > 0 ? ((lootDropCount / totalRuns) * 100).toFixed(1) : 0;
            
            // Group loot by type, then by boss/dungeon
            const lootByType = {};
            
            lootRuns.forEach(run => {
                const type = getRunType(run);
                const dungeon = run.dungeon_info?.name || run.dungeon_name || 'Unknown';
                
                if (!lootByType[type]) {
                    lootByType[type] = {};
                }
                if (!lootByType[type][dungeon]) {
                    lootByType[type][dungeon] = [];
                }
                lootByType[type][dungeon].push(run);
            });
            
            let html = `
                <div style="margin-bottom: 20px; padding-bottom: 20px; border-bottom: 1px solid #263956;">
                    <div style="display: flex; align-items: center; gap: 14px; margin-bottom: 12px;">
                        <div style="width: 52px; height: 52px; background: rgba(34, 197, 94, 0.2); border-radius: 12px; 
                                    display: flex; align-items: center; justify-content: center; font-size: 1.8rem;
                                    border: 1px solid rgba(34, 197, 94, 0.3);">
                            🎁
                        </div>
                        <div>
                            <h3 style="margin: 0; color: #F0EBE0; font-size: 1.3rem; font-weight: 700;">Loot Summary</h3>
                            <div style="color: #22c55e; font-size: 0.85rem;">All recorded drops</div>
                        </div>
                    </div>
                    
                    <!-- Stats Cards -->
                    <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px;">
                        <div style="background: rgba(34, 197, 94, 0.1); padding: 12px; border-radius: 8px; text-align: center; border: 1px solid rgba(34, 197, 94, 0.2);">
                            <div style="font-size: 0.7rem; color: #22c55e; text-transform: uppercase; margin-bottom: 4px;">🎁 Total Drops</div>
                            <div style="font-size: 1.4rem; font-weight: 700; color: #22c55e;">${lootDropCount}</div>
                        </div>
                        <div style="background: rgba(29, 47, 80, 0.5); padding: 12px; border-radius: 8px; text-align: center;">
                            <div style="font-size: 0.7rem; color: #7A8CB8; text-transform: uppercase; margin-bottom: 4px;">Total Runs</div>
                            <div style="font-size: 1.4rem; font-weight: 700; color: #F0EBE0;">${totalRuns}</div>
                        </div>
                        <div style="background: rgba(91, 146, 212, 0.1); padding: 12px; border-radius: 8px; text-align: center; border: 1px solid rgba(91, 146, 212, 0.2);">
                            <div style="font-size: 0.7rem; color: #5B92D4; text-transform: uppercase; margin-bottom: 4px;">📊 Drop Rate</div>
                            <div style="font-size: 1.4rem; font-weight: 700; color: #5B92D4;">${dropRate}%</div>
                        </div>
                    </div>
                </div>
            `;
            
            if (lootDropCount === 0) {
                html += `
                    <div style="color: #7A8CB8; text-align: center; padding: 40px 20px;">
                        <div style="font-size: 2rem; margin-bottom: 12px; opacity: 0.5;">📭</div>
                        <div style="font-size: 0.9rem;">No loot recorded yet</div>
                        <div style="font-size: 0.8rem; margin-top: 4px; opacity: 0.7;">Mark "Got Loot" when saving runs to track drops</div>
                    </div>
                `;
                container.innerHTML = html;
                return;
            }
            
            // Define type order for display
            const typeOrder = ['Archboss', 'Field Boss', 'Raid', 'Co-op Dungeon', 'Custom'];
            const sortedTypes = Object.keys(lootByType).sort((a, b) => {
                const ia = typeOrder.indexOf(a);
                const ib = typeOrder.indexOf(b);
                if (ia === -1 && ib === -1) return a.localeCompare(b);
                if (ia === -1) return 1;
                if (ib === -1) return -1;
                return ia - ib;
            });
            
            sortedTypes.forEach(type => {
                const style = navTypeStyles[type] || navTypeStyles['Custom'];
                const typeData = lootByType[type];
                const typeDropCount = Object.values(typeData).reduce((sum, arr) => sum + arr.length, 0);
                
                html += `
                    <div style="margin-bottom: 20px;">
                        <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 12px; padding-bottom: 8px; border-bottom: 1px solid #263956;">
                            <span style="font-size: 1.2rem;">${style.icon}</span>
                            <span style="flex: 1; font-size: 1rem; font-weight: 700; color: #F0EBE0;">${type === 'Co-op Dungeon' ? 'CO-OP DUNGEON' : type.toUpperCase()}</span>
                            <span style="font-size: 0.8rem; color: #22c55e; background: rgba(34, 197, 94, 0.15); padding: 3px 10px; border-radius: 12px;">${typeDropCount} drop${typeDropCount !== 1 ? 's' : ''}</span>
                        </div>
                `;
                
                // Sort dungeons/bosses by drop count descending
                const sortedDungeons = Object.keys(typeData).sort((a, b) => typeData[b].length - typeData[a].length);
                
                sortedDungeons.forEach(dungeon => {
                    const dungeonDrops = typeData[dungeon];
                    const dungeonDropCount = dungeonDrops.length;
                    
                    html += `
                        <div style="margin-bottom: 12px; margin-left: 8px;">
                            <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
                                <span style="font-size: 0.9rem;">${type === 'Field Boss' || type === 'Archboss' ? '💀' : '🏛️'}</span>
                                <span style="font-weight: 600; color: #F0EBE0; font-size: 0.9rem;">${escapeHtml(dungeon)}</span>
                                <span style="font-size: 0.7rem; color: #7A8CB8;">(${dungeonDropCount})</span>
                            </div>
                            <div style="margin-left: 24px; border-left: 2px solid #263956; padding-left: 12px;">
                    `;
                    
                    // Sort drops by date descending
                    const sortedDrops = [...dungeonDrops].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
                    
                    sortedDrops.forEach(run => {
                        const date = new Date(run.created_at);
                        const dateStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
                        const mode = getRunMode(run);
                        const tier = getRunTier(run);
                        const contribution = run.contribution_percent;
                        const lootItem = run.loot_item || 'Unknown Item';
                        
                        // Build mode/tier badge
                        let modeBadge = '';
                        if (type === 'Co-op Dungeon' && tier) {
                            modeBadge = `<span style="font-size: 0.65rem; color: #D96444; background: rgba(217, 100, 68, 0.15); padding: 2px 6px; border-radius: 3px;">T${tier}</span>`;
                        } else if (mode) {
                            const modeIcon = mode === 'Nightmare' ? '🔴' : mode === 'Difficult' ? '🟡' : mode === 'Ascended' ? '⭐' : '⚪';
                            modeBadge = `<span style="font-size: 0.65rem; color: #7A8CB8; background: rgba(122, 140, 184, 0.15); padding: 2px 6px; border-radius: 3px;">${modeIcon} ${mode}</span>`;
                        }
                        
                        // Contribution badge (only for Field Boss/Archboss)
                        let contributionBadge = '';
                        if ((type === 'Field Boss' || type === 'Archboss') && contribution != null) {
                            contributionBadge = `<span style="font-size: 0.65rem; color: #fbbf24; background: rgba(251, 191, 36, 0.15); padding: 2px 6px; border-radius: 3px;">📊 ${contribution.toFixed(1)}%</span>`;
                        }
                        
                        html += `
                            <div style="display: flex; align-items: center; gap: 8px; padding: 8px 10px; background: rgba(34, 197, 94, 0.08); border-radius: 6px; margin-bottom: 4px; border: 1px solid rgba(34, 197, 94, 0.15);">
                                <span style="color: #7A8CB8; font-size: 0.75rem; width: 55px;">${dateStr}</span>
                                ${modeBadge}
                                ${contributionBadge}
                                <span style="flex: 1; color: #22c55e; font-size: 0.85rem; font-weight: 500;">🎁 ${escapeHtml(lootItem)}</span>
                                <button onclick="openEditRunModal('${run.run_id}')" style="padding: 2px 6px; background: #263956; border: none; color: #7A8CB8; border-radius: 3px; cursor: pointer; font-size: 0.6rem;" title="Edit run">✏️</button>
                            </div>
                        `;
                    });
                    
                    html += `</div></div>`;
                });
                
                html += `</div>`;
            });
            
            container.innerHTML = html;
        }
        
        // === EDIT RUN MODAL ===
        let editingRunData = null;
        
        function openEditRunModal(runId) {
            // Find the run
            editingRunData = runSummaryData.find(r => r.run_id === runId);
            if (!editingRunData) {
                console.error('[RunSummary] Run not found:', runId);
                return;
            }
            
            document.getElementById('editRunId').value = runId;
            document.getElementById('editRunName').value = editingRunData.run_name || '';
            
            // Get current values using helper functions
            const currentType = getRunType(editingRunData);
            const currentMode = getRunMode(editingRunData);
            const currentTier = getRunTier(editingRunData);
            const currentDungeon = editingRunData.dungeon_info?.name || editingRunData.dungeon_name || '';
            
            // Set type
            document.getElementById('editRunType').value = currentType;
            onEditRunTypeChange();
            
            // Set mode after type change has updated the options
            setTimeout(() => {
                document.getElementById('editRunMode').value = currentMode;
                onEditRunModeChange();
                
                // Set tier and dungeon after mode change
                setTimeout(() => {
                    document.getElementById('editRunTier').value = currentTier;
                    document.getElementById('editRunDungeon').value = currentDungeon;
                }, 10);
            }, 10);
            
            // Populate class dropdown
            const classSelect = document.getElementById('editRunClass');
            classSelect.innerHTML = '<option value="">-- Class --</option>' + 
                TL_CLASSES.map(c => `<option value="${c.name}">${c.name}: ${c.weapons}</option>`).join('');
            classSelect.value = editingRunData.player_class || '';
            
            // Set build tag
            document.getElementById('editRunBuildTag').value = editingRunData.build_tag || '';
            
            // Handle loot section visibility and values
            const runType = editingRunData.dungeon_info?.type || getRunType(editingRunData);
            const editLootSection = document.getElementById('editLootSection');
            const editContributionContainer = document.getElementById('editContributionContainer');
            
            // Show loot section for all main types
            if (runType === 'Co-op Dungeon' || runType === 'Raid' || runType === 'Field Boss' || runType === 'Archboss') {
                editLootSection.style.display = 'block';
                
                // Contribution only for Field Boss and Archboss
                if (runType === 'Field Boss' || runType === 'Archboss') {
                    editContributionContainer.style.display = 'block';
                    document.getElementById('editContribution').value = editingRunData.contribution_percent ?? '';
                } else {
                    editContributionContainer.style.display = 'none';
                }
                
                // Set loot values
                const gotLoot = editingRunData.got_loot === true;
                document.querySelector(`input[name="editGotLoot"][value="${gotLoot ? 'yes' : 'no'}"]`).checked = true;
                document.getElementById('editLootItem').value = editingRunData.loot_item || '';
                document.getElementById('editLootItemContainer').style.display = gotLoot ? 'block' : 'none';
            } else {
                editLootSection.style.display = 'none';
            }
            
            document.getElementById('editRunModal').classList.add('active');
        }
        
        function onEditLootChange() {
            const gotLoot = document.querySelector('input[name="editGotLoot"]:checked')?.value === 'yes';
            const lootItemContainer = document.getElementById('editLootItemContainer');
            lootItemContainer.style.display = gotLoot ? 'block' : 'none';
            if (!gotLoot) {
                document.getElementById('editLootItem').value = '';
            }
        }
        
        function closeEditRunModal() {
            document.getElementById('editRunModal').classList.remove('active');
            editingRunData = null;
        }
        
