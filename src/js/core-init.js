        const WS_URL = 'ws://localhost:8765';
        let ws = null;
        let reconnectInterval = null;
        let currentStats = null;
        let savedEncounters = [];
        let encounters = []; // Alias for Build Testing tab
        let buildTags = [];
        let skillSettings = {};  // skill_name -> {cannot_crit, cannot_heavy}
        let currentSkills = [];  // Skills in current encounter
        let selectedClass = '';  // Remember last selected class
        
        // TL Classes with weapon combos
        const TL_CLASSES = [
            { name: 'Battleweaver', weapons: 'Staff / Crossbow' },
            { name: 'Berserker', weapons: 'Sword & Shield / Daggers' },
            { name: 'Cavalier', weapons: 'Spear / Crossbow' },
            { name: 'Crucifix', weapons: 'Crossbow / Orb' },
            { name: 'Crusader', weapons: 'Greatsword / Sword & Shield' },
            { name: 'Darkblighter', weapons: 'Daggers / Wand' },
            { name: 'Disciple', weapons: 'Sword & Shield / Staff' },
            { name: 'Enigma', weapons: 'Staff / Orb' },
            { name: 'Eradicator', weapons: 'Spear / Staff' },
            { name: 'Fury', weapons: 'Crossbow / Wand' },
            { name: 'Gladiator', weapons: 'Spear / Greatsword' },
            { name: 'Guardian', weapons: 'Sword & Shield / Orb' },
            { name: 'Impaler', weapons: 'Spear / Longbow' },
            { name: 'Infiltrator', weapons: 'Longbow / Daggers' },
            { name: 'Invocator', weapons: 'Staff / Wand' },
            { name: 'Justicar', weapons: 'Greatsword / Orb' },
            { name: 'Liberator', weapons: 'Longbow / Staff' },
            { name: 'Lunarch', weapons: 'Daggers / Orb' },
            { name: 'Oracle', weapons: 'Wand / Orb' },
            { name: 'Outrider', weapons: 'Greatsword / Crossbow' },
            { name: 'Paladin', weapons: 'Greatsword / Wand' },
            { name: 'Polaris', weapons: 'Spear / Orb' },
            { name: 'Raider', weapons: 'Sword & Shield / Crossbow' },
            { name: 'Ranger', weapons: 'Greatsword / Longbow' },
            { name: 'Ravager', weapons: 'Greatsword / Daggers' },
            { name: 'Scorpion', weapons: 'Crossbow / Daggers' },
            { name: 'Scout', weapons: 'Crossbow / Longbow' },
            { name: 'Scryer', weapons: 'Longbow / Orb' },
            { name: 'Seeker', weapons: 'Longbow / Wand' },
            { name: 'Sentinel', weapons: 'Greatsword / Staff' },
            { name: 'Shadowdancer', weapons: 'Spear / Daggers' },
            { name: 'Spellblade', weapons: 'Staff / Daggers' },
            { name: 'Steelheart', weapons: 'Sword & Shield / Spear' },
            { name: 'Templar', weapons: 'Sword & Shield / Wand' },
            { name: 'Voidlance', weapons: 'Spear / Wand' },
            { name: 'Warden', weapons: 'Sword & Shield / Longbow' }
        ];
        
        // Drag and drop state
        let isDragging = false;  // Track if drag is in progress
        let lastSkillAssignmentHash = '';  // Track last rendered state to avoid re-renders
        
        // Weapon/category analysis
        let weaponConfig = {
            skillAssignments: {},  // skill_name -> category
            currentSkills: [],     // Skills from current encounter
            weaponBreakdown: {}    // Category breakdown for display
        };

        function formatNumber(num) {
            if (num >= 1000000) return (num / 1000000).toFixed(2) + 'M';
            if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
            return num.toLocaleString();
        }

        // Skill color palette — consistent hash-based, global scope
        const SKILL_PALETTE = [
            '#D96444','#5B92D4','#fb923c','#34d399','#f472b6',
            '#fbbf24','#60a5fa','#f87171','#4ade80','#c084fc',
            '#38bdf8','#fb7185','#a3e635','#e879f9','#2dd4bf',
            '#fdba74','#818cf8','#86efac','#fcd34d','#94a3b8'
        ];
        function skillColor(name) {
            let h = 0;
            for (let i = 0; i < name.length; i++) { h = Math.imul(31, h) + name.charCodeAt(i) | 0; }
            return SKILL_PALETTE[Math.abs(h) % SKILL_PALETTE.length];
        }

        // Escape HTML to prevent XSS attacks from user-provided content
        function escapeHtml(text) {
            if (!text) return '';
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }

        function formatDuration(seconds) {
            if (!seconds) return '0s';
            if (seconds < 60) return Math.round(seconds) + 's';
            const mins = Math.floor(seconds / 60);
            const secs = Math.round(seconds % 60);
            return `${mins}m ${secs}s`;
        }

        function formatDate(isoString) {
            const date = new Date(isoString);
            const now = new Date();
            const isToday = date.toDateString() === now.toDateString();
            if (isToday) {
                return 'Today ' + date.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});
            }
            return date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});
        }

        function setConnectionStatus(connected) {
            document.getElementById('statusDot').classList.toggle('connected', connected);
            document.getElementById('statusText').textContent = connected ? 'Connected' : 'Disconnected';
            const stripDot = document.getElementById('sidebarStatusDot');
            if (stripDot) stripDot.textContent = connected ? '🟢' : '🔴';
            // Update Build Testing tab connection status
            updateBuildTestingStatus(connected);
        }

        // =============================================
        // WELCOME MODAL
        // =============================================
        let combatLogDetected = false;
        let welcomeModalChecked = false;

        function showWelcomeModal() {
            const modal = document.getElementById('welcomeModal');
            modal.classList.remove('hidden');
        }

        function closeWelcomeModal() {
            const modal = document.getElementById('welcomeModal');
            const neverShow = document.getElementById('welcomeNeverShow').checked;
            
            if (neverShow) {
                localStorage.setItem('welcomeModalDismissed', 'true');
            }
            
            modal.classList.add('hidden');
        }

        function updateWelcomeModalStatus(detected) {
            combatLogDetected = detected;
            
            const statusEl = document.getElementById('welcomeStatus');
            const iconEl = document.getElementById('welcomeStatusIcon');
            const titleEl = document.getElementById('welcomeStatusTitle');
            const hintEl = document.getElementById('welcomeStatusHint');
            const detectedContent = document.getElementById('welcomeDetectedContent');
            const notDetectedContent = document.getElementById('welcomeNotDetectedContent');
            
            if (detected) {
                statusEl.className = 'welcome-status detected';
                iconEl.textContent = '✅';
                titleEl.textContent = 'Combat Log Detected';
                hintEl.textContent = 'Make sure combat logging stays enabled in-game';
                detectedContent.style.display = 'block';
                notDetectedContent.style.display = 'none';
            } else {
                statusEl.className = 'welcome-status not-detected';
                iconEl.textContent = '❌';
                titleEl.textContent = 'Combat Log Not Detected';
                hintEl.textContent = 'Please enable combat logging in-game to use this app';
                detectedContent.style.display = 'none';
                notDetectedContent.style.display = 'block';
            }
            
            // Show welcome modal on first detection check (if not dismissed)
            if (!welcomeModalChecked) {
                welcomeModalChecked = true;
                checkAndShowWelcomeModal();
            }
        }

        function welcomeGoTo(tabName) {
            closeWelcomeModal();
            switchToTab(tabName);
        }

        function switchToTab(tabName) {
            document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
            
            const tab = document.querySelector(`[data-tab="${tabName}"]`);
            if (tab) {
                tab.classList.add('active');
                const pane = document.getElementById('tab-' + tabName);
                if (pane) {
                    pane.classList.add('active');
                }
            }
        }

        function checkAndShowWelcomeModal() {
            // Check if user has dismissed the modal permanently
            if (localStorage.getItem('welcomeModalDismissed') === 'true') {
                return;
            }

            // Show the modal
            showWelcomeModal();
        }

        // Explicit re-open (e.g. from Settings).  Clears the "never show again"
        // The user chose to open it intentionally; showWelcomeModal() has no guard,
        // so open it now WITHOUT clearing the persistent dismiss flag (auto-show stays off).
        function showWelcomeModalForce() {
            showWelcomeModal();
        }

        // ── Solo Lab dropdown state ──────────────────────────────────────────
        // soloLabTabNames: the 5 analysis/lab tabs hidden inside the overflow menu.
        // Config tabs (skillSettings, skillAssign, targetAssign, log) are now
        // accessible via Settings → Configuration, not the Solo Lab dropdown.
        const soloLabTabNames = new Set([
            'buildTesting', 'saved', 'compare',
            'fullEncounter', 'runSummary'
        ]);

        // ── Sidebar auto-collapse state ──────────────────────────────────────
        // Track whether the user had the sidebar collapsed BEFORE we auto-collapsed
        // it for Party DPS, so we can restore their preference when they leave.
        let _sidebarWasCollapsedBeforeParty = false;
        let _partyAutoCollapsed = false;   // true while auto-collapse is in effect

        // Helper: sync the Solo Lab toggle's has-active class
        function syncSoloLabActiveState() {
            const toggle = document.getElementById('soloLabToggle');
            if (!toggle) return;
            // Check whether any tab inside the dropdown is currently active
            const anyChildActive = document.querySelector('#soloLabDropdown .tab.active') !== null;
            toggle.classList.toggle('has-active', anyChildActive);
        }

        // Helper: collapse/restore sidebar when switching tabs
        function handleSidebarForTab(tabName) {
            const sidebar = document.getElementById('mainSidebar');
            const btn = document.getElementById('sidebarCollapseBtn');
            if (!sidebar || !btn) return;

            if (tabName === 'partyDps') {
                if (!_partyAutoCollapsed) {
                    // Remember current state before we touch it
                    _sidebarWasCollapsedBeforeParty = sidebar.classList.contains('collapsed');
                    _partyAutoCollapsed = true;
                }
                // Force-collapse for Party DPS
                sidebar.classList.add('collapsed');
                btn.textContent = '›';
                btn.title = 'Expand sidebar';
            } else {
                if (_partyAutoCollapsed) {
                    _partyAutoCollapsed = false;
                    // Restore to whatever the user had before
                    if (_sidebarWasCollapsedBeforeParty) {
                        sidebar.classList.add('collapsed');
                        btn.textContent = '›';
                        btn.title = 'Expand sidebar';
                    } else {
                        sidebar.classList.remove('collapsed');
                        btn.textContent = '‹';
                        btn.title = 'Collapse sidebar';
                    }
                }
                // If _partyAutoCollapsed is false, user is manually managing the sidebar — don't touch it
            }
        }

        // Tab switching
        document.querySelectorAll('.tab').forEach(tab => {
            tab.addEventListener('click', () => {
                // The Solo Lab ▾ toggle also carries class="tab" (for styling) but has no
                // data-tab — skip it here so its own dropdown listener handles it and we don't
                // getElementById('tab-undefined') -> blank the screen.
                if (!tab.dataset.tab) return;
                // If this tab is inside the Solo Lab dropdown, close the dropdown
                const dropdown = document.getElementById('soloLabDropdown');
                if (dropdown) dropdown.classList.remove('open');

                document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
                document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
                tab.classList.add('active');
                document.getElementById('tab-' + tab.dataset.tab).classList.add('active');

                // Sync Solo Lab toggle active indicator
                syncSoloLabActiveState();

                // Auto-collapse/restore sidebar for Party DPS
                handleSidebarForTab(tab.dataset.tab);

                // Load Run Summary when tab is opened
                if (tab.dataset.tab === 'runSummary') {
                    loadRunSummary();
                }

                // Load target assignments when tab is opened
                if (tab.dataset.tab === 'targetAssign') {
                    if (!targetAssignmentsLoaded) {
                        console.log('[TargetAssign] Requesting from server');
                        if (ws && ws.readyState === WebSocket.OPEN) {
                            ws.send(JSON.stringify({command: 'get_target_assignments'}));
                        } else {
                            // No connection, just initialize with defaults
                            initializeTargetAssignments({});
                        }
                    } else {
                        // Already loaded, just refresh display
                        updateTargetAssignmentDisplay();
                    }
                }

                // Refresh encounter history when switching to Encounters tab
                if (tab.dataset.tab === 'encounters') {
                    if (ws && ws.readyState === WebSocket.OPEN) {
                        sendCommand('get_encounter_history');
                    }
                }

                // Initialize Run Builder class dropdown when tab is opened
                if (tab.dataset.tab === 'fullEncounter') {
                    const runClassSelect = document.getElementById('runClassSelect');
                    if (runClassSelect && runClassSelect.options.length <= 1) {
                        runClassSelect.innerHTML = '<option value="">-- Class --</option>' +
                            TL_CLASSES.map(c => `<option value="${c.name}">${c.name}: ${c.weapons}</option>`).join('');
                    }
                }
            });
        });

        // ── Solo Lab dropdown toggle ─────────────────────────────────────────
        (function initSoloLabDropdown() {
            const toggle = document.getElementById('soloLabToggle');
            const dropdown = document.getElementById('soloLabDropdown');
            if (!toggle || !dropdown) return;

            // Open/close on toggle button click
            toggle.addEventListener('click', (e) => {
                e.stopPropagation();
                dropdown.classList.toggle('open');
            });

            // Close on outside click
            document.addEventListener('click', (e) => {
                if (!document.getElementById('soloLabWrapper').contains(e.target)) {
                    dropdown.classList.remove('open');
                }
            });

            // Sync initial state (Dashboard is active, no Solo Lab child is active)
            syncSoloLabActiveState();
        })();

        function updateLicenseInfo(license) {
            const container = document.getElementById('versionInfo');
            // Show static version — no license system in this fork
            container.innerHTML = `
                <span class="version">StoopKid Beta</span>
                <span class="license ok">Open</span>
            `;
        }

        function updateStats(data) {
            currentStats = data;
            
            // Update sidebar encounter time (always shows raw log data)
            if (data.first_hit) {
                document.getElementById('encounterTime').innerHTML = `
                    <div style="color: #D96444; font-weight: 600;">${data.first_hit} → ${data.last_hit}</div>
                    <div style="margin-top: 4px;">${formatDuration(data.duration)}</div>
                `;
            }

            // Sidebar targets always update (raw log data)
            updateTargets(data.targets);
            
            // Track skills for Data Health counts
            if (data.skills && data.skills.length > 0) {
                data.skills.forEach(skill => {
                    if (skill.name) {
                        addSkillFromLog(skill.name);
                    }
                });
            }
            
            // Build Testing sub-tabs only update when a test is active or loaded encounter is being viewed
            if (buildTestDataActive || isViewingLoadedEncounter) {
                updateSummaryTab(data);
                updateSkillsTable(data.skills_60s || data.skills, data.damage_60s || data.total_damage);
                updateTopHits(data.top_hits_60s || data.top_hits);
                updateRotation(data.rotation_60s, data.gap_stats);
                updateTimeline(data.rotation_60s, data.timeline, data.duration, data.dps, data.hit_count_60s);
                recalculateWeaponBreakdown();
            }
            
            // Full Encounter tab (Run Builder) always updates
            updateFullEncounter(data);
            
            // Log tab ALWAYS shows live data, never loaded encounter data
            // When viewing a loaded encounter, Log tab is updated separately via WebSocket handler
            if (!isViewingLoadedEncounter) {
                updateCombatLog(data.hit_log || data.top_hits);
            }
            updateCurrentSkillsList();  // Update skill settings UI with current encounter skills
        }
        
        function recalculateWeaponBreakdown() {
            // Calculate weapon breakdown client-side from currentStats
            // Uses skills_60s for breakdown (Weapon Stats tab)
            // Uses all skills for assignments (Skill Assign tab)
            if (!currentStats) {
                return;
            }
            
            // For breakdown stats (Weapon Stats tab), use 60s data
            const skills60s = currentStats.skills_60s || currentStats.skills || [];
            // For skill assignment list (Skill Assign tab), use all skills
            const allSkills = currentStats.skills || [];
            
            const assignments = weaponConfig.skillAssignments || {};
            const totalDamage60s = currentStats.damage_60s || currentStats.total_damage || 1;
            
            // Initialize weapon categories only
            const breakdown = {};
            const categories = ['greatsword', 'sns', 'dagger', 'spear', 'crossbow', 'longbow', 'staff', 'wand', 'orb', 'mastery', 'other', 'unassigned'];
            
            categories.forEach(cat => {
                breakdown[cat] = {
                    damage: 0,
                    hits: 0,
                    crits: 0,
                    heavies: 0,
                    skills: [],
                    percent: 0,
                    crit_rate: 0,
                    heavy_rate: 0,
                    avg_hit: 0
                };
            });
            
            // Categorize each skill's 60s damage for breakdown
            skills60s.forEach(skill => {
                const category = assignments[skill.name] || 'unassigned';
                const cat = categories.includes(category) ? category : 'unassigned';
                
                breakdown[cat].damage += skill.damage || 0;
                breakdown[cat].hits += skill.hits || 0;
                breakdown[cat].crits += skill.crits || 0;
                breakdown[cat].heavies += skill.heavies || 0;
                breakdown[cat].skills.push({
                    name: skill.name,
                    damage: skill.damage || 0,
                    hits: skill.hits || 0,
                    crits: skill.crits || 0,
                    heavies: skill.heavies || 0
                });
            });
            
            // Calculate percentages and rates
            categories.forEach(cat => {
                const data = breakdown[cat];
                data.percent = totalDamage60s > 0 ? Math.round((data.damage / totalDamage60s * 100) * 10) / 10 : 0;
                data.crit_rate = data.hits > 0 ? Math.round((data.crits / data.hits * 100) * 10) / 10 : 0;
                data.heavy_rate = data.hits > 0 ? Math.round((data.heavies / data.hits * 100) * 10) / 10 : 0;
                data.avg_hit = data.hits > 0 ? Math.round(data.damage / data.hits) : 0;
                // Sort skills by damage descending
                data.skills.sort((a, b) => b.damage - a.damage);
            });
            
            // Store breakdown (60s) and all skills (for assignment UI)
            weaponConfig.weaponBreakdown = breakdown;
            weaponConfig.currentSkills = allSkills;  // All skills for assignment
            updateWeaponsUI();
        }

