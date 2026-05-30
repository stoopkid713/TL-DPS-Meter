# ツCKヤ DPS Meter — StoopKid Beta

A combat log analyzer for **Throne and Liberty** built on top of the original CK DPS Meter by SirPHz. This fork continues active development with a focus on deep build testing, rotation analysis, and session-based run comparison.

> **Note:** This is a private development fork. Original project by [mjb6967/CKdpsApp](https://github.com/mjb6967/CKdpsApp).

For the full feature evolution see [CHANGELOG.md](CHANGELOG.md); for the
backstory of this fork and its sibling project see [LINEAGE.md](LINEAGE.md).
The current production state is tagged `state-current` on `main`.

---

## ⬇️ Download & Run

1. **[Download `TL-DPS-Meter.exe`](https://github.com/stoopkid713/TL-DPS-Meter/raw/main/TL-DPS-Meter.exe)** *(right-click → Save link as)*
2. Drop it in any folder and **double-click** it
3. Your browser opens automatically — that window **is** the meter
4. In Throne & Liberty, turn on Combat Logging *(Settings → Shortcuts → Ring Menu → add **"Combat Meter"**)* and activate it from the Ring Menu

**Windows 10/11 · fully portable · nothing to install.** Full walkthrough: [HOW-TO-USE.txt](HOW-TO-USE.txt).

> **Heads-up:** Windows SmartScreen may warn on first launch (unsigned PyInstaller build — see [FAQ](#faq) below). Click **More info → Run anyway**. Throne & Liberty writes combat logs *after* you leave combat, so stats populate when a fight ends, not during.

---

## What's New in This Fork

### 🔀 Compare — Cross-Skill Matrix & Key Findings *(added in state-current)*
Side-by-side per-skill breakdown across two runs, plus auto-computed
observations about what differs between them. Spot exactly which skills
drove the delta.

### ⚙️ Sidebar + Weapon-group toggles *(added in state-current)*
Collapsible sidebar for navigation; filter the Weapons tab by weapon group
to compare loadouts cleanly.

### 🔬 Run Lab
A purpose-built comparison tool for back-to-back build testing sessions — no saving required.

- **Session Queue** — Completed runs queue automatically. Tag them inline, assign them to Run A or Run B, and open Run Lab instantly
- **Skill Matrix** — Per-skill breakdown across two runs: cast count, avg damage per cast, Crit%, Heavy%, and Crit+Heavy% (the big ones)
- **Cast Timeline** — Stacked piano roll showing both runs on the same axis with per-skill toggle buttons
- **Cast Drilldown** — Click any skill to see every cast: timestamp, damage, hit type, and a bar chart of cast intervals showing exactly where cadence broke down

### 📊 Stacked DPS Timeline
The Rotation tab's DPS chart now shows per-second damage broken down by skill — each bar is color-coded by skill so you can see which skills drove each burst window and what was absent during weak segments.

- Y-axis with real DPS values (50K, 100K, 150K, 200K) so peaks are readable
- Skill color legend sorted by total damage contribution

### 🔍 Performance Analysis (Rotation Tab)
Replaced 4 generic insights with 9 skill-aware insights:

- **Hit type summary** — Crit%, Heavy%, and Crit+Heavy% all in one line
- **Weak window cause** — Identifies which of your top damage skills were absent during your weakest segment ("30-45s: Void Slash, Curse Explosion absent — likely on cooldown")
- **Dropped cast detection** — Flags skills where the max gap between casts was 60%+ longer than average
- **DPS consistency** — Coefficient of variation across 4 segments (is your rotation smooth or bursty?)
- **Damage concentration** — Names your top 3 skills and their combined % share

### 💾 Session Queue
Between-run workflow built into Build Testing so you never lose a run:

- Each completed 60s test is auto-saved to the backend with a placeholder tag
- Queue panel shows DPS, Crit%, Heavy%, Crit+Heavy% per run
- Inline tag input + class selector per run
- **A / B slot buttons** for quick Run Lab assignment
- Individual run removal with ✕ per card
- **Save All** bulk-tags everything at once when you're done

---

## Core Features (Original)

### 📊 Build Testing
- 60-second standardized tests for fair build comparison
- Real-time DPS, crit, heavy, and crit+heavy rate tracking
- Per-skill damage breakdown with hit type analysis
- Weapon assignment for weapon-specific DPS splits

### 🎯 Rotation Analysis
- DPS Timeline (now stacked by skill)
- Piano Roll — per-skill cast timeline
- Gap detection and segment analysis (0-15s, 15-30s, 30-45s, 45-60s)
- Performance insights with skill-level cause analysis

### 💾 Build Management
- Save encounters with build tags and class
- Class grouping in saved encounters list
- Load any saved encounter for full detail review
- Notes per encounter

### ⚔️ Build Comparison
- Compare up to 3 saved builds side-by-side
- Skill breakdown, rotation timing, segment DPS comparison
- Winner indicators per metric

### 🏰 Dungeon Run Builder
- Combine encounters into full dungeon runs
- Boss detection and run summaries
- Custom dungeon support

### 👥 Party DPS (Beta)
- Post-pull damage leaderboard shared across party
- Requires all party members to run the app
- Powered by Supabase Realtime — no server required

---

## Requirements

- Windows 10/11
- Throne and Liberty with Combat Logging enabled
- Any modern web browser (Chrome, Firefox, Edge)

---

## Installation

1. **[Download `TL-DPS-Meter.exe`](https://github.com/stoopkid713/TL-DPS-Meter/raw/main/TL-DPS-Meter.exe)** (right-click → Save link as)
2. Move it to any folder you like
3. Double-click `TL-DPS-Meter.exe`
4. Browser opens automatically

**No installation required** — fully portable. A single self-contained executable.

---

## Enable Combat Logging

1. Open **Settings → Shortcuts → Ring Menu Settings**
2. Add **"Combat Meter"** to your Ring Menu
3. In-game, open Ring Menu and activate **Combat Meter**

Logs save to: `%LOCALAPPDATA%\TL\Saved\CombatLogs`

> **Note:** Throne and Liberty writes combat logs after you leave combat, not during. Stats populate once the fight ends.

---

## Usage

### Build Testing Session Workflow
1. Enable combat logging in-game
2. Run `TL-DPS-Meter.exe`
3. Go to **Build Testing** tab
4. Hit **Reset** before each pull
5. Fight for 60 seconds
6. Run appears in **Session Queue** — tag it or assign to A/B for Run Lab
7. Hit **Save All** when done

### Global Hotkey
| Hotkey | Action |
|--------|--------|
| `Ctrl+Tab` | Reset Encounter (works while in-game) |

---

## Data Files

| File | Purpose |
|------|---------|
| `config.json` | Settings (log path, player name, hotkey) |
| `encounters.json` | Saved encounters and build tag history |
| `saved_runs.json` | Saved dungeon runs |
| `skill_settings.json` | Skills marked as cannot crit/heavy |
| `weapon_config.json` | Skill-to-weapon assignments |
| `default_target_assignments.json` | Target categorization |
| `dungeons.json` | Dungeon definitions |

---

## FAQ

**Q: Why don't I see damage during combat?**
Throne and Liberty writes logs when you leave combat, not during. Stats appear after each fight ends.

**Q: Can I get banned?**
This tool only reads log files the game generates. It does not inject, modify, or interact with the game process.

**Q: Why does antivirus flag the exe?**
False positive from PyInstaller packaging. Source is available for review.

**Q: How do I filter to only my damage?**
Settings → Player Name → enter your character name.

---

## Credits

- Original project: **SirPHz** (Discord: SirPHz) — [mjb6967/CKdpsApp](https://github.com/mjb6967/CKdpsApp)
- This fork: **stoopkid4529**

---

## Development notes

- The Python backend (`server.pyc` inside `TL-DPS-Meter.exe`) is binary-only.
  Source was lost early on and the `.pyc` is compiled with Python 3.14, which
  no automated decompiler supports. The 28K-line disassembly in
  [`server.disasm.txt`](server.disasm.txt) is the authoritative reference.
  See [docs/disasm-notes.md](docs/disasm-notes.md) for context.
- Frontend changes (`index.html`) are the practical path forward.
- A real-data test fixture lives at [`samples/encounters_sample.json`](samples/encounters_sample.json)
  — copy it to `encounters.json` in the working folder before launching to
  load the sample session.
- A sibling project, [TL-DPS-Auto](https://github.com/stoopkid713/TL-DPS-Auto),
  explores a different "more automated" design philosophy. Separate codebase
  — not a successor to this tool. Coexists on different ports.

---

Made for the Throne and Liberty community ☕
