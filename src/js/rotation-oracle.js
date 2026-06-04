        function encRotationShowAll() {
            encRotationHiddenSkills.clear();
            if (lastEncRotationCache) renderEncStackedChart(lastEncRotationCache.rotation, lastEncRotationCache.duration);
        }

        function renderStackedDpsChart(rotation, maxSec, hiddenSkills, chartId, yAxisId, togglesId, legendId, toggleFn, showAllFn) {
            const chart   = document.getElementById(chartId);
            const yAxis   = document.getElementById(yAxisId);
            const toggles = document.getElementById(togglesId);
            const legend  = document.getElementById(legendId);
            if (!chart) return;

            const skillDmgTotals = {};
            rotation.forEach(h => { const sk=h.skill||'Unknown'; skillDmgTotals[sk]=(skillDmgTotals[sk]||0)+(h.damage||0); });
            const sortedSkills = Object.keys(skillDmgTotals).sort((a,b)=>skillDmgTotals[b]-skillDmgTotals[a]);

            const secDmgAll = {};
            for (let i=0; i<=maxSec; i++) secDmgAll[i]=0;
            rotation.forEach(h => { const sec=Math.floor(h.relative_time||0); if(sec<=maxSec) secDmgAll[sec]=(secDmgAll[sec]||0)+(h.damage||0); });
            const maxDpsAll = Math.max(...Object.values(secDmgAll),1);

            const secSkillDmg = {};
            for (let i=0; i<=maxSec; i++) secSkillDmg[i]={};
            rotation.forEach(h => {
                const sec=Math.floor(h.relative_time||0), sk=h.skill||'Unknown';
                if (sec<=maxSec && !hiddenSkills.has(sk)) secSkillDmg[sec][sk]=(secSkillDmg[sec][sk]||0)+(h.damage||0);
            });

            const hitTimes = rotation.map(h=>Math.floor(h.relative_time||0));
            const firstHit = Math.min(...hitTimes), lastHit = Math.max(...hitTimes);

            const rollingDps = [];
            for (let i=0; i<=maxSec-5; i++) { let s=0; for(let j=i;j<i+5;j++) s+=secDmgAll[j]||0; rollingDps.push({start:i,dps:s/5}); }
            const peakWindow = rollingDps.length ? rollingDps.reduce((m,c)=>c.dps>m.dps?c:m,{dps:0,start:0}) : {dps:0,start:0};

            function niceYTicks(maxVal,n) {
                if(!maxVal) return [0,100000];
                const rough=maxVal/n, mag=Math.pow(10,Math.floor(Math.log10(rough)));
                const norm=rough/mag, nice=norm<=1?1:norm<=2?2:norm<=2.5?2.5:norm<=5?5:10;
                const step=nice*mag, ticks=[];
                for(let t=0;t<=maxVal+step;t+=step) ticks.push(Math.round(t));
                return ticks;
            }
            const yTicks=niceYTicks(maxDpsAll,4), chartMax=yTicks[yTicks.length-1]||1;

            if (yAxis) yAxis.innerHTML = yTicks.map(t => {
                const pct=(t/chartMax)*100;
                return `<div style="position:absolute;bottom:${pct}%;right:5px;transform:translateY(50%);font-size:0.58rem;color:#7A8CB8;white-space:nowrap;">${formatNumber(t)}</div>`;
            }).join('');

            let html = yTicks.map(t => {
                const pct=(t/chartMax)*100;
                return `<div style="position:absolute;bottom:${pct}%;left:0;right:0;height:1px;background:rgba(255,255,255,${t===0?'0.1':'0.05'});pointer-events:none;z-index:0;"></div>`;
            }).join('');

            const numBars = Math.min(maxSec+1,120);
            for (let i=0; i<=numBars; i++) {
                const sec=Math.floor(i*(maxSec/numBars));
                const totalDmg=secDmgAll[sec]||0;
                const isGap=totalDmg===0&&sec>=firstHit&&sec<=lastHit;
                const isBurst=sec>=peakWindow.start&&sec<peakWindow.start+5&&totalDmg>0;

                if (isGap) { html+=`<div class="rotation-dps-bar gap-zone" style="height:2%;z-index:1;" title="${sec}s: gap"></div>`; continue; }
                if (totalDmg===0) { html+=`<div style="flex:1;min-width:2px;"></div>`; continue; }

                const secFiltered=secSkillDmg[sec]||{};
                const filteredTotal=Object.values(secFiltered).reduce((s,v)=>s+v,0);
                const barPct=chartMax>0?(filteredTotal/chartMax)*100:0;

                if (filteredTotal===0) { html+=`<div style="flex:1;min-width:2px;"></div>`; continue; }

                const segs=Object.entries(secFiltered).sort((a,b)=>b[1]-a[1]);
                const segHtml=segs.map(([sk,dmg])=>`<div style="width:100%;height:${(dmg/filteredTotal)*100}%;background:${skillColor(sk)};flex-shrink:0;min-height:${dmg>0?'1px':'0'};" title="${sk}: ${formatNumber(dmg)}"></div>`).join('');
                const outline=isBurst?'box-shadow:0 0 0 1px rgba(34,197,94,0.8);':'';
                html+=`<div class="rotation-dps-bar" style="height:${Math.max(barPct,1)}%;display:flex;flex-direction:column-reverse;background:none;padding:0;gap:0;overflow:hidden;z-index:1;${outline}" title="${sec}s: ${formatNumber(filteredTotal)}">${segHtml}</div>`;
            }
            chart.innerHTML = html;

            if (toggles) {
                const weaponGroups = renderWeaponGroupToggles(sortedSkills, hiddenSkills, toggleFn, showAllFn);
                toggles.innerHTML =
                    `<span class="rl-toggle-label">Skills:</span>` +
                    sortedSkills.map(sk=>`<button class="rl-skill-toggle ${!hiddenSkills.has(sk)?'on':''}" onclick="${toggleFn}('${escapeHtml(sk)}')">${escapeHtml(sk)}</button>`).join('') +
                    `<span style="display:inline-block;width:1px;height:14px;background:#263956;margin:0 4px;vertical-align:middle;"></span>` +
                    `<button class="rl-skill-toggle" onclick="${showAllFn}()" style="border-color:#22c55e;color:#22c55e;">All</button>` +
                    `<button class="rl-skill-toggle" onclick="stackedChartHideAll('${toggleFn}',${JSON.stringify(sortedSkills)})" style="border-color:#ef4444;color:#ef4444;">None</button>` +
                    (weaponGroups ? `<span style="display:inline-block;width:1px;height:14px;background:#263956;margin:0 4px;vertical-align:middle;"></span>${weaponGroups}` : '');
            }

            if (legend) legend.innerHTML = sortedSkills.map(sk=>
                `<div style="display:flex;align-items:center;gap:5px;padding:2px 0;opacity:${hiddenSkills.has(sk)?'0.35':'1'}">
                     <div style="width:10px;height:10px;border-radius:2px;background:${skillColor(sk)};flex-shrink:0;"></div>
                     <span style="font-size:0.68rem;color:#7A8CB8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${sk}</span>
                 </div>`
            ).join('');
        }

        // ── Weapon group toggle helper ─────────────────────────────────────────
        function renderWeaponGroupToggles(sortedSkills, hiddenSkills, toggleFn, showAllFn) {
            const WEAPON_LABELS = {
                orb:'Orb', wand:'Wand', staff:'Staff', crossbow:'Crossbow',
                longbow:'Longbow', spear:'Spear', dagger:'Daggers',
                greatsword:'Greatsword', sword:'Sword & Shield', mastery:'Mastery', other:'Other'
            };
            const assignments = weaponConfig?.skillAssignments || {};
            const groups = {};
            sortedSkills.forEach(sk => {
                const wt = assignments[sk] || 'other';
                if (!groups[wt]) groups[wt] = [];
                groups[wt].push(sk);
            });
            const usefulGroups = Object.entries(groups).filter(([,sks]) => sks.length >= 2);
            if (!usefulGroups.length) return '';
            return usefulGroups.map(([wt, sks]) => {
                const allVisible = sks.every(sk => !hiddenSkills.has(sk));
                const label = WEAPON_LABELS[wt] || wt;
                const skJson = escapeHtml(JSON.stringify(sks));
                return `<button class="rl-skill-toggle ${allVisible?'on':''}"
                    onclick="toggleWeaponGroupByName('${toggleFn}','${showAllFn}','${wt}',this)"
                    data-weapon-skills="${skJson}"
                    style="border-color:${allVisible?'#f472b6':'#263956'};color:${allVisible?'#f472b6':'#7A8CB8'};"
                    title="Toggle all ${label} skills">${label}</button>`;
            }).join('');
        }

        function toggleWeaponGroupByName(toggleFn, showAllFn, weaponType, btn) {
            const sks = JSON.parse(btn.dataset.weaponSkills || '[]');
            if (!sks.length) return;
            // Determine context
            const isRunLab = !!btn.closest('#runLabToggles');
            const isBT = !!btn.closest('#rotationSkillToggles');
            const isEnc = !!btn.closest('#encRotationSkillToggles');
            const compareBuildEl = btn.closest('[data-compare-build]');

            if (isRunLab) {
                const allOn = sks.every(sk => runLabVisibleSkills.has(sk));
                sks.forEach(sk => { if (allOn) runLabVisibleSkills.delete(sk); else runLabVisibleSkills.add(sk); });
                renderRunLabToggles();
                const runA = sessionQueue.find(i=>i.runLabSlot==='A');
                const runB = sessionQueue.find(i=>i.runLabSlot==='B');
                if (runA && runB) renderRunLabPiano(runA, runB);
                return;
            }
            if (isBT) {
                const allVisible = sks.every(sk => !rotationHiddenSkills.has(sk));
                sks.forEach(sk => { if (allVisible) rotationHiddenSkills.add(sk); else rotationHiddenSkills.delete(sk); });
                if (lastRotationCache) renderBTStackedChart(lastRotationCache.rotation);
                return;
            }
            if (isEnc) {
                const allVisible = sks.every(sk => !encRotationHiddenSkills.has(sk));
                sks.forEach(sk => { if (allVisible) encRotationHiddenSkills.add(sk); else encRotationHiddenSkills.delete(sk); });
                if (lastEncRotationCache) renderEncStackedChart(lastEncRotationCache.rotation, lastEncRotationCache.duration);
                return;
            }
            if (compareBuildEl) {
                const build = compareBuildEl.dataset.compareBuild;
                const map = {A:compareHiddenSkillsA, B:compareHiddenSkillsB, C:compareHiddenSkillsC};
                const hiddenSet = map[build];
                if (!hiddenSet) return;
                const allVisible = sks.every(sk => !hiddenSet.has(sk));
                sks.forEach(sk => { if (allVisible) hiddenSet.add(sk); else hiddenSet.delete(sk); });
                refreshCompareRotationChart(build);
                return;
            }
        }

        // ── Compare key findings helper ────────────────────────────────────────
        function computeComparePairFindings(rotW, rotL, slotW, slotL) {
            if (!rotW || !rotL || !rotW.length || !rotL.length) return [];
            const matrixW = {}, matrixL = {};
            function buildMap(rot, map) {
                rot.forEach(h => {
                    const sk = h.skill||'Unknown';
                    if (!map[sk]) map[sk] = {dmg:0,hits:0,crits:0,heavies:0,ch:0,times:[]};
                    map[sk].dmg += h.damage||0;
                    map[sk].hits++;
                    if (h.is_crit && h.is_heavy) map[sk].ch++;
                    else if (h.is_crit) map[sk].crits++;
                    else if (h.is_heavy) map[sk].heavies++;
                    map[sk].times.push(h.relative_time||0);
                });
            }
            buildMap(rotW, matrixW); buildMap(rotL, matrixL);
            function casts(times) {
                const s = [...times].sort((a,b)=>a-b); let c=1;
                for (let i=1;i<s.length;i++) if (s[i]-s[i-1]>0.15) c++;
                return c;
            }
            const allSkills = new Set([...Object.keys(matrixW),...Object.keys(matrixL)]);
            const findings = [];
            allSkills.forEach(sk => {
                const w = matrixW[sk], l = matrixL[sk];
                if (!w || !l) return;
                const castsW = casts(w.times), castsL = casts(l.times);
                const avgW = w.dmg/castsW, avgL = l.dmg/castsL;
                const chW = w.ch/w.hits*100, chL = l.ch/l.hits*100;
                const castDiff = castsW - castsL;
                const avgDiff = avgW - avgL;
                const avgDiffPct = avgL>0?(avgDiff/avgL*100):0;
                const castImpact = castDiff>0 ? castDiff*avgW : 0;
                const avgImpact = Math.abs(avgDiffPct)>8 && castsL>0 ? Math.abs(avgDiff)*Math.min(castsW,castsL) : 0;
                if (castDiff>0 && castImpact>50000)
                    findings.push({impact:castImpact, text:`<strong style="color:#F0EBE0">${sk}</strong>: ${slotW} landed <span style="color:#22c55e;font-weight:700">+${castDiff} cast${castDiff>1?'s':''}</span> — ~<span style="color:#5B92D4;font-weight:700">+${formatNumber(Math.round(castImpact))}</span> extra damage`});
                if (Math.abs(avgDiffPct)>10 && avgImpact>50000 && castsL>0) {
                    const dir=avgDiff>0?'higher':'lower', col=avgDiff>0?'#22c55e':'#ef4444';
                    findings.push({impact:avgImpact, text:`<strong style="color:#F0EBE0">${sk}</strong>: avg/cast <span style="color:${col};font-weight:700">${Math.abs(avgDiffPct).toFixed(0)}% ${dir}</span> in ${slotW} — ~<span style="color:#5B92D4;font-weight:700">${formatNumber(Math.round(avgImpact))}</span> swing`});
                }
                if (chW-chL>6 && castsW>=3)
                    findings.push({impact:(chW-chL)*avgW/100*castsW, text:`<strong style="color:#F0EBE0">${sk}</strong>: C+H rate <span style="color:#f472b6;font-weight:700">${chW.toFixed(0)}%</span> vs ${chL.toFixed(0)}% — more big hits in ${slotW}`});
            });
            return findings.sort((a,b)=>b.impact-a.impact).slice(0,4);
        }

        function renderCompareKeyFindings(buildsData) {
            const winner = buildsData.reduce((w,b) => b.stats.dps>w.stats.dps?b:w, buildsData[0]);
            const others = buildsData.filter(b => b.label!==winner.label);
            const dpsDiff = winner.stats.dps - (others[0]?.stats.dps||0);
            const dpsDiffPct = others[0]?.stats.dps>0 ? (dpsDiff/others[0].stats.dps*100).toFixed(1) : 0;

            const pairHtml = others.map(other => {
                const findings = computeComparePairFindings(
                    winner.bestEncounter?.first_60s?.rotation || [],
                    other.bestEncounter?.first_60s?.rotation || [],
                    winner.label, other.label
                );
                const diff = winner.stats.dps - other.stats.dps;
                const pct = other.stats.dps>0 ? (diff/other.stats.dps*100).toFixed(1) : 0;
                return `<div style="margin-bottom:10px;">
                    <div style="font-size:0.7rem;color:#7A8CB8;margin-bottom:5px;">${winner.label} vs ${other.label} — <span style="color:#D96444;font-weight:700">+${formatNumber(Math.round(diff))} DPS (${pct}%)</span></div>
                    ${findings.length
                        ? findings.map(f=>`<div style="font-size:0.77rem;color:#7A8CB8;padding:5px 8px;background:rgba(21,32,53,0.4);border-radius:5px;margin-bottom:3px;">${f.text}</div>`).join('')
                        : `<div style="font-size:0.77rem;color:#7A8CB8;padding:5px 0;">Runs are very close — check the skill matrix for fine details.</div>`}
                </div>`;
            }).join('');

            return `<div style="background:rgba(21,32,53,0.5);border:1px solid #263956;border-radius:10px;padding:14px 16px;margin-bottom:16px;">
                <div style="font-size:0.72rem;font-weight:700;color:#7A8CB8;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:10px;">🔍 Key Findings — ${winner.label} wins (${winner.enc?.build_tag||''})</div>
                ${pairHtml}
            </div>`;
        }

        // ── Compare cross-build skill matrix ───────────────────────────────────
        function renderCrossSkillMatrix(buildsData) {
            const allSkills = new Set();
            const buildMaps = {};
            buildsData.forEach(b => {
                const map = {}; buildMaps[b.label] = map;
                const rot = b.bestEncounter?.first_60s?.rotation || [];
                rot.forEach(h => {
                    const sk=h.skill||'Unknown';
                    if (!map[sk]) map[sk]={dmg:0,hits:0,crits:0,heavies:0,ch:0,times:[]};
                    map[sk].dmg+=h.damage||0; map[sk].hits++;
                    if(h.is_crit&&h.is_heavy) map[sk].ch++;
                    else if(h.is_crit) map[sk].crits++;
                    else if(h.is_heavy) map[sk].heavies++;
                    map[sk].times.push(h.relative_time||0);
                    allSkills.add(sk);
                });
            });
            function casts(times){const s=[...times].sort((a,b)=>a-b);let c=1;for(let i=1;i<s.length;i++)if(s[i]-s[i-1]>0.15)c++;return c;}
            const skillTotals = {};
            allSkills.forEach(sk => {
                buildsData.forEach(b => { const m=buildMaps[b.label][sk]; if(m) skillTotals[sk]=(skillTotals[sk]||0)+m.dmg; });
            });
            const sorted = [...allSkills].sort((a,b)=>(skillTotals[b]||0)-(skillTotals[a]||0));
            const letters = buildsData.map(b=>b.label);

            const headerCols = letters.map(l=>`<th style="color:#D96444;font-weight:700;font-size:0.7rem;padding:0 6px 7px;text-align:right;">${l}</th>`).join('');

            const rows = sorted.map(sk => {
                const vals = letters.map(l => {
                    const m = buildMaps[l][sk];
                    if (!m) return {dmg:0,c:0,avg:0,crit:0,heavy:0,ch:0};
                    const c=casts(m.times);
                    return {dmg:m.dmg,c,avg:m.dmg/c,crit:m.crits/m.hits*100,heavy:m.heavies/m.hits*100,ch:m.ch/m.hits*100};
                });
                const maxDmg = Math.max(...vals.map(v=>v.dmg));
                const dmgCells = vals.map(v=>
                    `<td style="text-align:right;font-size:0.77rem;padding:5px 6px;color:${v.dmg===maxDmg&&maxDmg>0?'#22c55e':'#7A8CB8'};font-variant-numeric:tabular-nums;">${v.dmg>0?formatNumber(v.dmg):'—'}</td>`
                ).join('');
                const castCells = vals.map(v=>
                    `<td style="text-align:right;font-size:0.77rem;padding:5px 6px;color:#7A8CB8;font-variant-numeric:tabular-nums;">${v.c||'—'}</td>`
                ).join('');
                const avgCells = vals.map(v=>
                    `<td style="text-align:right;font-size:0.77rem;padding:5px 6px;color:#7A8CB8;font-variant-numeric:tabular-nums;">${v.avg>0?formatNumber(Math.round(v.avg)):'—'}</td>`
                ).join('');
                const chCells = vals.map(v=>
                    `<td style="text-align:right;font-size:0.72rem;padding:5px 6px;color:#f472b6;font-variant-numeric:tabular-nums;">${v.ch>0?v.ch.toFixed(0)+'%':'—'}</td>`
                ).join('');

                return `<tr style="border-top:1px solid rgba(255,255,255,0.05);">
                    <td style="font-size:0.77rem;color:#F0EBE0;padding:5px 8px;display:flex;align-items:center;gap:5px;">
                        <div style="width:6px;height:6px;border-radius:50%;background:${skillColor(sk)};flex-shrink:0;"></div>${sk}
                    </td>
                    ${dmgCells}${castCells}${avgCells}${chCells}
                </tr>`;
            }).join('');

            const subHeaderCols = ['DAMAGE','CASTS','AVG/CAST','C+H%'].map(h=>
                letters.map(()=>`<th style="font-size:0.65rem;color:#405A85;font-weight:400;padding:0 6px 5px;text-align:right;">${h}</th>`).join('')
            ).join('');

            return `<div style="overflow-x:auto;">
                <table style="width:100%;border-collapse:collapse;">
                    <thead>
                        <tr><th style="font-size:0.7rem;color:#7A8CB8;padding:0 8px 7px;text-align:left;">SKILL</th>${headerCols.repeat(4)}</tr>
                        <tr><th></th>${subHeaderCols}</tr>
                    </thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>`;
        }

        // ── Compare rotation chart toggle functions ────────────────────────────
        let compareRotationData = {}; // stores rotation per build for refresh

        function toggleCompareRotationSkill(build, skill) {
            const map = {A:compareHiddenSkillsA, B:compareHiddenSkillsB, C:compareHiddenSkillsC};
            const s = map[build.replace('Build ', '')];  // map is keyed by bare letter, build is "Build A"
            if (!s) return;
            if (s.has(skill)) s.delete(skill); else s.add(skill);
            refreshCompareRotationChart(build);
        }

        function compareRotationShowAll(build) {
            const map = {A:compareHiddenSkillsA, B:compareHiddenSkillsB, C:compareHiddenSkillsC};
            const s = map[build.replace('Build ', '')]; if(s) s.clear();
            refreshCompareRotationChart(build);
        }

        function refreshCompareRotationChart(build) {
            const rot = compareRotationData[build];
            if (!rot) return;
            const map = {A:compareHiddenSkillsA, B:compareHiddenSkillsB, C:compareHiddenSkillsC};
            // hiddenSkills map is keyed by the bare letter ("A"); `build` is the label ("Build A").
            // Element IDs below stay keyed by the full label (matches the DOM IDs built at render).
            renderStackedDpsChart(rot, 60, map[build.replace('Build ', '')] || new Set(),
                `compareRotChart_${build}`, `compareRotYAxis_${build}`,
                `compareRotToggles_${build}`, `compareRotLegend_${build}`,
                `toggleCompareRotationSkill.bind(null,'${build}')`,
                `compareRotationShowAll.bind(null,'${build}')`);
        }

        function stackedChartHideAll(toggleFn, skills) {
            // Hide all skills by calling the toggle fn for each visible skill
            if (toggleFn === 'toggleRotationSkill') {
                skills.forEach(sk => rotationHiddenSkills.add(sk));
                if (lastRotationCache) renderBTStackedChart(lastRotationCache.rotation);
            } else if (toggleFn === 'toggleEncRotationSkill') {
                skills.forEach(sk => encRotationHiddenSkills.add(sk));
                if (lastEncRotationCache) renderEncStackedChart(lastEncRotationCache.rotation, lastEncRotationCache.duration);
            }
        }

        function renderBTStackedChart(rotation) {
            renderStackedDpsChart(rotation, 60, rotationHiddenSkills,
                'rotationDpsChart','rotationYAxis','rotationSkillToggles','rotationSkillLegend',
                'toggleRotationSkill','rotationShowAll');
        }

        function renderEncStackedChart(rotation, duration) {
            const maxSec = Math.min(Math.ceil(duration||60),120);
            renderStackedDpsChart(rotation, maxSec, encRotationHiddenSkills,
                'encRotationDpsChart','encRotationYAxis','encRotationSkillToggles','encRotationSkillLegend',
                'toggleEncRotationSkill','encRotationShowAll');
        }

        function renderEncInsightsRich(data, rotation, duration) {
            const container = document.getElementById('encRotationInsights');
            if (!container || !rotation || !rotation.length) {
                if (container) container.innerHTML = '<div style="color:#7A8CB8;text-align:center;padding:20px;">No rotation data to analyze</div>';
                return;
            }
            const insights = [];
            const totalDamage=rotation.reduce((s,h)=>s+h.damage,0);
            const totalHits=rotation.length;
            const critRate=totalHits>0?rotation.filter(h=>h.is_crit).length/totalHits*100:0;
            const heavyRate=totalHits>0?rotation.filter(h=>h.is_heavy).length/totalHits*100:0;
            const chRate=totalHits>0?rotation.filter(h=>h.is_crit&&h.is_heavy).length/totalHits*100:0;

            insights.push({type:chRate>=15?'success':chRate>=8?'warning':'neutral',icon:'⚡',
                text:`Hit types: <span class="rotation-insight-value">${critRate.toFixed(0)}% Crit</span> · <span class="rotation-insight-value">${heavyRate.toFixed(0)}% Heavy</span> · <span class="rotation-insight-value" style="color:#f472b6">${chRate.toFixed(0)}% C+H</span>`});

            const secDmg={}, hitTimes=rotation.map(h=>Math.floor(h.relative_time||0));
            rotation.forEach(h=>{const s=Math.floor(h.relative_time||0);secDmg[s]=(secDmg[s]||0)+h.damage;});
            const firstHit=Math.min(...hitTimes),lastHit=Math.max(...hitTimes);
            const activeSecs=Object.keys(secDmg).filter(s=>parseInt(s)>=firstHit&&parseInt(s)<=lastHit).length;
            const actRate=activeSecs/Math.max(1,lastHit-firstHit+1)*100;
            if(actRate<70) insights.push({type:'danger',icon:'⏱️',text:`Low uptime: <span class="rotation-insight-value">${actRate.toFixed(0)}%</span>`});
            else if(actRate<85) insights.push({type:'warning',icon:'⏱️',text:`Uptime <span class="rotation-insight-value">${actRate.toFixed(0)}%</span> — some gaps`});
            else insights.push({type:'success',icon:'✔',text:`Solid uptime at <span class="rotation-insight-value">${actRate.toFixed(0)}%</span>`});

            let peakDps=0,peakStart=0,maxSec=Math.ceil(duration||60);
            for(let i=0;i<=maxSec-5;i++){let s=0;for(let j=i;j<i+5;j++)s+=secDmg[j]||0;if(s/5>peakDps){peakDps=s/5;peakStart=i;}}
            if(peakDps>0) insights.push({type:'success',icon:'🔥',text:`Peak 5s burst: <span class="rotation-insight-value">${formatNumber(Math.round(peakDps))} DPS</span> at ${peakStart}–${peakStart+5}s`});

            const skillDmg={};
            rotation.forEach(h=>{const sk=h.skill||'Unknown';skillDmg[sk]=(skillDmg[sk]||0)+h.damage;});
            const skillsByDmg=Object.entries(skillDmg).sort((a,b)=>b[1]-a[1]);
            if(skillsByDmg.length>=3){
                const top3=skillsByDmg.slice(0,3).reduce((s,[,d])=>s+d,0);
                insights.push({type:'neutral',icon:'⚔️',text:`Top 3 skills — <span class="rotation-insight-value">${skillsByDmg[0][0]}, ${skillsByDmg[1][0]}, ${skillsByDmg[2][0]}</span> — <span class="rotation-insight-value">${totalDamage>0?(top3/totalDamage*100).toFixed(0):0}%</span> of damage`});
            }

            const skillHitsMap={};
            rotation.forEach(h=>{const sk=h.skill||'Unknown';if(!skillHitsMap[sk])skillHitsMap[sk]=[];skillHitsMap[sk].push(h);});
            skillsByDmg.slice(0,5).forEach(([sk])=>{
                const hits=skillHitsMap[sk]||[];
                const sorted=[...hits].sort((a,b)=>(a.relative_time||0)-(b.relative_time||0));
                const casts=[];let cur=null;
                sorted.forEach(h=>{const t=h.relative_time||0;if(!cur||t-cur.end>0.15){casts.push({start:t,end:t});cur=casts[casts.length-1];}else cur.end=t;});
                if(casts.length<3)return;
                const gaps=[];for(let i=1;i<casts.length;i++)gaps.push(casts[i].start-casts[i-1].start);
                const avg=gaps.reduce((s,g)=>s+g,0)/gaps.length, mx=Math.max(...gaps);
                if(mx>avg*1.6&&mx>8) insights.push({type:'warning',icon:'⏳',text:`<span class="rotation-insight-value">${sk}</span>: <span class="rotation-insight-value">${mx.toFixed(1)}s</span> gap (avg ${avg.toFixed(1)}s) — possible dropped cast`});
            });

            if(duration>120) insights.push({type:'info',icon:'⏱️',text:`Long encounter: <span class="rotation-insight-value">${formatDuration(duration)}</span> · avg <span class="rotation-insight-value">${formatNumber(Math.round(totalDamage/duration))} DPS</span>`});

            container.innerHTML = insights.map(i=>
                `<div class="rotation-insight ${i.type}"><span class="rotation-insight-icon">${i.icon}</span><span class="rotation-insight-text">${i.text}</span></div>`
            ).join('') || '<div style="color:#7A8CB8;text-align:center;padding:20px;">No significant issues detected</div>';
        }

        // ============================================================
        // DEMO MODE — activates when backend is not running
        // ============================================================
        let demoModeActive = false;
        let demoEncounterMap = {}; // target_name+start_time → full encounter data

        // Seeded LCG random for consistent demo data
        function demoRng(seed) {
            let s = seed;
            return () => { s = (s * 1664525 + 1013904223) & 0xffffffff; return (s >>> 0) / 0xffffffff; };
        }

        function generateOracleRotation(durationSec, seed) {
            const rng = demoRng(seed || 42);
            const SKILLS = [
                { name:'Void Slash',         cadence:3.5,  subHits:5,  base:7500,  var:3000 },
                { name:'Supernova Collapse', cadence:8.0,  subHits:6,  base:14000, var:5000 },
                { name:'Curse Explosion',    cadence:6.1,  subHits:1,  base:48000, var:12000 },
                { name:'Abyssal Burst',      cadence:7.0,  subHits:3,  base:11000, var:3500 },
                { name:'Touch of Despair',   cadence:5.0,  subHits:2,  base:5500,  var:2000 },
                { name:'Starcalling',        cadence:4.0,  subHits:4,  base:9500,  var:3000 },
                { name:'Stellar Dash',       cadence:6.0,  subHits:3,  base:6500,  var:2000 },
                { name:'Manaball',           cadence:2.5,  subHits:1,  base:3800,  var:1200 },
            ];
            const hits = [];
            let id = 0;
            SKILLS.forEach(sk => {
                let t = rng() * sk.cadence;
                while (t < durationSec) {
                    for (let h = 0; h < sk.subHits; h++) {
                        const isCrit  = rng() < 0.34;
                        const isHeavy = rng() < 0.28;
                        const isCH    = isCrit && isHeavy && rng() < 0.65;
                        const base    = sk.base + (rng()*2-1)*sk.var;
                        const dmg     = Math.round(base * (isCrit||isCH?1.5:1) * (isHeavy||isCH?2:1));
                        hits.push({ id:id++, skill:sk.name, damage:Math.max(dmg,100),
                            relative_time: t + h*0.08, is_crit:isCrit||isCH, is_heavy:isHeavy||isCH });
                    }
                    t += sk.cadence + (rng()*0.6-0.3);
                }
            });
            return hits.sort((a,b)=>a.relative_time-b.relative_time);
        }

        function makeDemoEncounter(opts) {
            const rot = generateOracleRotation(opts.duration, opts.seed);
            const total = rot.reduce((s,h)=>s+h.damage,0);
            const crits  = rot.filter(h=>h.is_crit).length;
            const heavies = rot.filter(h=>h.is_heavy).length;
            const ch     = rot.filter(h=>h.is_crit&&h.is_heavy).length;
            const enc = {
                id: opts.id,
                target_name: opts.target,
                category: opts.category || 'field_boss',
                start_time: opts.start,
                end_time: opts.end,
                duration: opts.duration,
                total_damage: total,
                dps: total / opts.duration,
                hit_count: rot.length,
                crit_rate:  rot.length>0 ? crits/rot.length*100  : 0,
                heavy_rate: rot.length>0 ? heavies/rot.length*100 : 0,
                ch_rate:    rot.length>0 ? ch/rot.length*100       : 0,
                build_tag: opts.tag || '',
                player_class: 'Oracle',
                notes: '',
                merged: false,
                hit_log: rot,
                skills: Object.entries(rot.reduce((m,h)=>{m[h.skill]=(m[h.skill]||0)+h.damage;return m;},{}))
                    .map(([name,damage])=>({ name, damage, hits:rot.filter(h=>h.skill===name).length }))
            };
            demoEncounterMap[enc.target_name + '|' + enc.start_time] = enc;
            return enc;
        }

        function initDemoMode() {
            if (demoModeActive) return;
            demoModeActive = true;

            // Status indicator
            const dot  = document.getElementById('statusDot');
            const text = document.getElementById('statusText');
            if (dot)  { dot.style.background = '#f59e0b'; dot.classList.remove('connected'); }
            if (text) text.innerHTML = 'Demo Mode <span style="font-size:0.65rem;color:#7A8CB8;">— no backend</span>';

            // License / version (already static, just ensure it renders)
            updateLicenseInfo({});

            // Build tags
            buildTags = ['4pc Blood CDR','4pc Blood','2pc Veiled','4pc Veiled','Testing','Guild Raids','World Boss'];

            // Weapon config so class detection works
            if (!weaponConfig || !Object.keys(weaponConfig.skillAssignments||{}).length) {
                weaponConfig = { skillAssignments: {
                    'Void Slash':'orb','Supernova Collapse':'orb','Starcalling':'orb',
                    'Stellar Dash':'orb','Interstellar Explosion':'orb','Star Destroyer':'orb',
                    'Abyssal Burst':'wand','Curse Explosion':'wand','Touch of Despair':'wand',
                    'Ray of Disaster':'wand','Manaball':'wand','Chaotic Shield':'wand'
                }};
            }

            // === Build Testing — completed test ===
            const rot60 = generateOracleRotation(60, 7);
            const total60 = rot60.reduce((s,h)=>s+h.damage,0);
            const hits60  = rot60.length;
            const crits60 = rot60.filter(h=>h.is_crit).length;
            const hvy60   = rot60.filter(h=>h.is_heavy).length;
            const ch60    = rot60.filter(h=>h.is_crit&&h.is_heavy).length;
            const dps60   = Math.round(total60/60);

            buildTestComplete = true;
            lastTestData = {
                duration: 62, first_hit:'14:32:01', last_hit:'14:33:03',
                first_60s: {
                    dps: dps60, hit_count: hits60,
                    raw_crit_rate:  (crits60/hits60*100),
                    raw_heavy_rate: (hvy60/hits60*100),
                    raw_ch_rate:    (ch60/hits60*100),
                    rotation: rot60,
                    skills: Object.entries(rot60.reduce((m,h)=>{m[h.skill]=(m[h.skill]||0)+h.damage;return m;},{}))
                        .map(([name,damage])=>({ name, damage, hits:rot60.filter(h=>h.skill===name).length }))
                }
            };
            selectedClass = 'Oracle';

            const statsPanel = document.getElementById('buildTestStatsPanel');
            const extStats   = document.getElementById('buildTestExtendedStats');
            if (statsPanel) statsPanel.style.display = 'block';
            if (extStats)   extStats.style.display   = 'grid';
            document.getElementById('btDps').textContent     = dps60.toLocaleString();
            document.getElementById('btHits').textContent    = hits60.toLocaleString();
            document.getElementById('btCrit').textContent    = (crits60/hits60*100).toFixed(1)+'%';
            document.getElementById('btHeavy').textContent   = (hvy60/hits60*100).toFixed(1)+'%';
            document.getElementById('btNormal').textContent  = ((hits60-crits60-hvy60+ch60)/hits60*100).toFixed(1)+'%';
            document.getElementById('btCritHeavy').textContent = (ch60/hits60*100).toFixed(1)+'%';
            document.getElementById('btAvgHit').textContent  = Math.round(total60/hits60).toLocaleString();

            const card = document.getElementById('activeTargetCard');
            if (card) {
                card.style.display = 'block';
                card.style.borderColor = 'rgba(34,197,94,0.3)';
                card.style.background  = 'rgba(34,197,94,0.05)';
                card.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center;">
                    <div>
                        <div style="font-size:0.75rem;color:#22c55e;font-weight:600;">✓ Test Complete</div>
                        <div style="font-size:1rem;color:#F0EBE0;font-weight:500;margin-top:4px;">Practice Dummy</div>
                    </div>
                    <div style="text-align:right;"><div style="font-size:0.7rem;color:#7A8CB8;">60 seconds</div></div>
                </div>`;
            }

            // Rotation chart
            lastRotationCache = { rotation: rot60, gapStats: {} };
            setTimeout(()=>renderBTStackedChart(rot60), 100);

            // Performance insights
            const gapStats = { deadTime:3, majorGaps:1, longestGap:4.2, avgGap:1.1, activityRate:94, peakDps:dps60*1.3 };
            if (typeof updateRotation === 'function') {
                try { updateRotation(rot60, gapStats); } catch(e) {}
            }

            // === Session Queue — 3 runs ===
            const rotA = generateOracleRotation(60, 11);
            const rotB = generateOracleRotation(60, 22);
            const rotC = generateOracleRotation(60, 33);
            const dpsA = Math.round(rotA.reduce((s,h)=>s+h.damage,0)/60);
            const dpsB = Math.round(rotB.reduce((s,h)=>s+h.damage,0)/60);
            const dpsC = Math.round(rotC.reduce((s,h)=>s+h.damage,0)/60);
            const cr = r=>Math.round(r.filter(h=>h.is_crit).length/r.length*100*10)/10;
            const hr = r=>Math.round(r.filter(h=>h.is_heavy).length/r.length*100*10)/10;
            const chr= r=>Math.round(r.filter(h=>h.is_crit&&h.is_heavy).length/r.length*100*10)/10;

            sessionQueue = [
                { runNumber:1, tempTag:'__sq_demo1__', finalTag:'4pc Blood CDR', playerClass:'Oracle',
                  dps:dpsA, critRate:cr(rotA), heavyRate:hr(rotA), critHeavyRate:chr(rotA),
                  id:'__d1__', saved:false, runLabSlot:'A', rotation:rotA, skills:[], notes:'' },
                { runNumber:2, tempTag:'__sq_demo2__', finalTag:'2pc Veiled',    playerClass:'Oracle',
                  dps:dpsB, critRate:cr(rotB), heavyRate:hr(rotB), critHeavyRate:chr(rotB),
                  id:'__d2__', saved:false, runLabSlot:'B', rotation:rotB, skills:[], notes:'' },
                { runNumber:3, tempTag:'__sq_demo3__', finalTag:'',              playerClass:'Oracle',
                  dps:dpsC, critRate:cr(rotC), heavyRate:hr(rotC), critHeavyRate:chr(rotC),
                  id:null,   saved:false, runLabSlot:null, rotation:rotC, skills:[], notes:'' },
            ];
            sessionRunCounter = 3;
            const qPanel = document.getElementById('sessionQueuePanel');
            if (qPanel) qPanel.style.display = 'block';
            renderSessionQueue();

            // === Encounters tab ===
            const demoEncs = [
                makeDemoEncounter({ id:'de1', target:'Practice Dummy',      duration:62,  seed:101, tag:'4pc Blood CDR', start:'2026-04-08T14:32:00', end:'2026-04-08T14:33:02', category:'training' }),
                makeDemoEncounter({ id:'de2', target:'Practice Dummy',      duration:65,  seed:102, tag:'2pc Veiled',    start:'2026-04-08T14:35:00', end:'2026-04-08T14:36:05', category:'training' }),
                makeDemoEncounter({ id:'de3', target:'Ascended Grand Aelon',duration:126, seed:103, tag:'4pc Blood CDR', start:'2026-04-08T15:10:00', end:'2026-04-08T15:12:06', category:'field_boss' }),
                makeDemoEncounter({ id:'de4', target:'Ascended Grand Aelon',duration:119, seed:104, tag:'4pc Blood CDR', start:'2026-04-08T15:13:30', end:'2026-04-08T15:15:29', category:'field_boss' }),
                makeDemoEncounter({ id:'de5', target:'Ascended Malakar',    duration:173, seed:105, tag:'4pc Blood',     start:'2026-04-08T16:00:00', end:'2026-04-08T16:02:53', category:'field_boss' }),
            ];
            updateSessionEncountersList(demoEncs);

            // === Saved Encounters tab ===
            savedEncounters = demoEncs.map(e => ({
                ...e,
                build_tag: e.build_tag, player_class:'Oracle', notes:'',
                crit_rate: e.crit_rate, heavy_rate: e.heavy_rate,
            }));
            updateSavedEncountersList();
            updateBuildFilters();

            // Intercept encounter detail requests in demo mode
            const _origSelectSessionEncounter = window.selectSessionEncounter || selectSessionEncounter;
            selectSessionEncounter = function(index) {
                selectedSessionEncounter = index;
                renderSessionEncountersList();
                const enc = sessionEncounters[index];
                if (!enc) return;
                selectedEncounterCategory = enc.category;
                mergedEncounterIndices = null;
                renderSessionEncountersList();
                const key = enc.target_name + '|' + enc.start_time;
                const full = demoEncounterMap[key];
                if (full) displayEncounterDetails(full);
            };

            console.log('[Demo] Demo mode initialized');
        }

        // Auto-activate demo mode if backend not connected after 2s
        setTimeout(() => {
            if (!ws || ws.readyState !== WebSocket.OPEN) {
                initDemoMode();
            }
        }, 2000);

        connect();
