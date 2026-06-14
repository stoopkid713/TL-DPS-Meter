# Security & Privacy

STOOP is a **DPS meter for Throne & Liberty**. It reads the game's own local combat
log and shows your damage. This document explains, in concrete and verifiable terms,
exactly what STOOP does and does not do — so you can answer the two questions everyone
asks: *"Is this a virus?"* and *"Will this get me banned?"*

Everything below is grounded in the source in this repository. **STOOP is open source —
don't take our word for it, read the code.** Key files are linked throughout.

---

## TL;DR

- STOOP **reads a text file the game writes to disk** and draws its own window. That's it.
- It does **not** inject into the game, read the game's memory, hook its rendering, or
  capture network packets. ([`backend/log_watcher.py`](backend/log_watcher.py),
  [`DECISIONS.md` ADR-002](DECISIONS.md))
- Antivirus/SmartScreen warnings on the download are **false positives** caused by the
  app being **unsigned** and packaged with **PyInstaller** — not by anything it does. See
  [Why antivirus may flag it](#why-antivirus-may-flag-it-false-positives).
- Third-party game tools sit in a **ToS gray area**. The technical ban risk is low, but it
  is not zero as a matter of policy. See [Anti-cheat & ban risk](#anti-cheat--ban-risk).

---

## How STOOP captures damage

STOOP's only data source is the **combat log file that Throne & Liberty itself writes**
when in-game combat logging is enabled. STOOP tails that file and parses new lines.

- **Default log location it reads:** `%LOCALAPPDATA%\TL\Saved\CombatLogs\*.txt`
  ([`backend/constants.py`](backend/constants.py) → `DEFAULT_LOG_SUBDIR`,
  [`backend/dps_meter_server.py`](backend/dps_meter_server.py) → `_default_log_dir`).
- **How it reads:** a [`watchdog`](https://pypi.org/project/watchdog/) file-system
  observer notices the file change; STOOP opens the file **read-only**, reads the new
  bytes from its last position to end-of-file, and parses them
  ([`backend/log_watcher.py`](backend/log_watcher.py) → `read_new_lines`).
- **What's in the log:** the game's log is **self-only, outgoing-damage-only**. STOOP can
  only ever see *your own* outgoing damage — not other players' memory, not the game's
  internal state ([`DECISIONS.md` ADR-002](DECISIONS.md)).

This is a deliberate, documented architectural decision, not an accident:

> **ADR-002 — Capture is log-file-read ONLY (no memory/packet/injection).**
> Only ever read the game's local combat log. Never inject, hook, or sniff packets.
> — [`DECISIONS.md`](DECISIONS.md)

### What STOOP explicitly does **not** do

You can verify each of these by searching the source:

| It does **not**… | How to verify |
| --- | --- |
| Inject code/DLLs into the game | No `CreateRemoteThread` / DLL injection anywhere in the tree |
| Read or write the game's memory | No `OpenProcess` / `ReadProcessMemory` / `WriteProcessMemory` |
| Hook the game's rendering (DirectX/overlay-into-game) | The overlay is a **separate window/process**, not injected (see below) |
| Capture or modify network packets | No `pcap` / `npcap` / raw sockets / `pydivert` |
| Send input to the game / automate gameplay | No `SendInput` / `keybd_event` / `mouse_event` |
| Log your keystrokes | Global hotkey uses `RegisterHotKey` (see [Hotkeys](#hotkeys-not-a-keylogger)) |

---

## Network endpoints

The Python backend (`backend/`) makes **no outbound internet connections at all** — it
only binds a local WebSocket so the in-app UI can talk to it. *All* internet traffic comes
from the app's UI layer (WebView2/Chromium rendering `index.html`), and the only
always-on remote call is an update check. The party and feedback features are **opt-in**.

| Endpoint | Direction | When | Purpose |
| --- | --- | --- | --- |
| `ws://localhost:8765` | **Local only** | Always | UI ⇄ backend on your own machine. Never leaves your computer. ([`backend/constants.py`](backend/constants.py)) |
| `https://api.github.com/repos/stoopkid713/STOOP/releases/latest` | Outbound GET | On launch | Checks for a newer release. |
| `https://tldps-party.kyle-526.workers.dev/skills` | Outbound GET | On launch | Fetches skill metadata used for display. |
| `wss://tldps-party.kyle-526.workers.dev/party/<CODE>` | Outbound WSS | **Opt-in** | Live party scoreboard — only when you create or join a party. |
| `https://tldps-party.kyle-526.workers.dev/feedback` | Outbound POST | **Opt-in** | Only when you submit a bug report from the app. |

The `*.workers.dev` host is a [Cloudflare Worker](workers/party/) ("party room") — the
backend for the live scoreboard. No telemetry, ads, or analytics beacons are sent.

> Searchable in [`index.html`](index.html): `WS_URL`, `RELEASES_LATEST_API`,
> `SKILLS_CLOUD_URL`, `PARTY_WS_BASE`, `FEEDBACK_URL`.

---

## Files & folders STOOP touches

| Path | Access | Why |
| --- | --- | --- |
| `%LOCALAPPDATA%\TL\Saved\CombatLogs\*.txt` | **Read-only** | The game's combat log — STOOP's only data source. |
| `%LOCALAPPDATA%\STOOP\` *(installed build)* | Read/write | Its own JSON settings + a rotating log file. |
| Next to the `.exe` *(portable build)* | Read/write | Same data, kept beside the exe so the folder is USB-portable (marked by an empty `STOOP.portable` file). |
| `%TEMP%\_MEI******\` | Read/write | PyInstaller unpacks the bundled Python runtime here on launch and removes it on exit. **This temp-unpack is what most antivirus heuristics react to.** |

On first run STOOP writes a few default config files into its data dir
(`default_target_assignments.json`, `dungeons.json`, `skill_settings.json`,
`weapon_config.json`). These are game-fact presets, not your personal data.

---

## Hotkeys (not a keylogger)

STOOP registers **one** global hotkey (default `Ctrl+Tab`) to reset stats. It uses the
Windows [`RegisterHotKey`](https://learn.microsoft.com/windows/win32/api/winuser/nf-winuser-registerhotkey)
API ([`backend/hotkey.py`](backend/hotkey.py)), which registers a **single specific key
combination** with the OS and is notified **only** when that exact combo is pressed. It
**cannot observe any other keystrokes** — it is the privacy-preserving opposite of a
keylogger (which would use a low-level keyboard hook to capture *all* keys). STOOP installs
no such hook, and the shipped binary depends only on `pywebview`, `watchdog`, and
`websockets` ([`backend/pyproject.toml`](backend/pyproject.toml)).

---

## Why antivirus may flag it (false positives)

Some antivirus engines and the Windows SmartScreen download check may flag
`STOOP-portable.zip` / `STOOP.exe`. **These are false positives.** The cause is *how the
app is packaged and distributed*, not *what it does*:

1. **It's unsigned.** STOOP has no Authenticode code-signing certificate, so SmartScreen
   shows an "unknown publisher" warning and heuristic engines treat it with suspicion.
   This is the single biggest factor.
2. **It's a PyInstaller one-file build.** On launch, the one-file stub unpacks a packed
   Python runtime to `%TEMP%\_MEI******\` and loads native modules (`.pyd`, `VCRUNTIME140.dll`)
   from there. This unpack pattern is shared by many malware droppers, so machine-learning
   / heuristic engines flag the *packaging*, not the behavior.
3. **Low reputation.** A brand-new binary that few people have downloaded has no
   established reputation, so it is treated as guilty until proven innocent.

### The evidence it's a false positive

- Detections are **few and ML/heuristic-only** (e.g. Microsoft `Wacatac`/`Phonzy` with the
  `!ml` "machine-learning guess" suffix). The strong **signature-based** engines
  (BitDefender, Kaspersky-class, ESET, Avast/AVG, Avira, etc.) report it **clean**. Real
  malware lights up the signature engines first.
- A sandbox detonation shows **no malicious behavior**: no network C2, no IDS alerts. The
  only files it drops are its **own** config/log files; the only registry writes are
  **Windows' own** app-compat telemetry that the OS records for *any* program that runs.
- The only heuristic rules that match are textbook PyInstaller false-positive triggers
  ("VCRUNTIME140 DLL sideloading", "Python image load by non-Python process") — both are
  just describing how PyInstaller one-file apps start.

### If your antivirus blocked it

Only do this if you trust your source of the download:

- **Edge/Chrome download "virus detected":** open Downloads → the blocked item → **Keep**.
- **Defender quarantined it:** Windows Security → **Protection history** → the item →
  **Actions → Restore**, or add an exclusion for the STOOP folder.

### For maintainers: clearing the flags

There is no single "VirusTotal clear" button — VirusTotal only aggregates other vendors'
verdicts. To reduce flags:

1. **Code-sign the binary.** This is the highest-impact fix and the only permanent one
   (signatures attach trust to the *publisher*, so new releases inherit reputation instead
   of resetting each build). Options for an open-source project, cheapest first:
   [SignPath Foundation](https://signpath.org/) (free for qualifying OSS),
   [Azure Trusted Signing](https://learn.microsoft.com/azure/trusted-signing/) (~$10/mo),
   [Certum Open Source Code Signing](https://www.certum.eu/) (~$80–110/yr), or a standard
   OV/EV certificate (EV grants SmartScreen reputation immediately).
2. **Submit false positives to vendors**, then re-scan:
   - Microsoft (clears Defender + the Microsoft slot on VirusTotal):
     <https://www.microsoft.com/en-us/wdsi/filesubmission> — choose "Software developer."
   - Other flagging vendors have their own false-positive portals; attach this document
     and the VirusTotal link, then hit **Reanalyze** on VirusTotal once they update.

---

## Anti-cheat & ban risk

**Read this before you decide to use STOOP.**

Throne & Liberty uses Easy Anti-Cheat (EAC), and its publisher's Terms of Service broadly
restrict third-party software. Be honest with yourself about two different kinds of risk:

- **Technical detection risk — low.** EAC bans are driven by things like injecting into the
  game, reading/altering game memory, DLL/driver cheats, known cheat signatures, or
  automating input. **STOOP does none of these** (see [the table above](#what-stoop-explicitly-does-not-do)).
  It reads a log file off disk and draws a separate window. Its overlay is a **separate
  Tauri/WebView2 window** ([`overlay/`](overlay/)) — its own process, **not** injected into
  or hooked onto the game (this is the key difference from tools like Overwolf, which inject
  overlays into the game process). STOOP sends **no input** to the game, so it cannot trip
  "bot/behavior" detection either.
- **Policy / ToS risk — not zero.** Independent of detection, a publisher can decide that
  *any* third-party tool violates its ToS and act on accounts at its discretion, and appeal
  processes may be limited. No third-party tool can engineer this risk away.

**Use STOOP at your own risk.** We believe the technical risk is low and the design is
deliberately conservative (log-read-only), but we cannot and do not guarantee that using
any third-party tool is free of consequences. Make your own informed decision. For the
deeper, point-by-point treatment, see [`docs/BAN-RISK.md`](docs/BAN-RISK.md).

---

## Supported versions

Only the latest release receives security fixes. If you're on an older version, update first.

| Version | Supported |
|---------|-----------|
| Latest  | ✅ |
| Older   | ❌ |

---

## Reporting a vulnerability

Found a genuine security issue (not a false-positive AV flag)? **Please do not file public
GitHub issues for security vulnerabilities.** Report it privately instead:

- Use **GitHub → Security → Report a vulnerability** (private advisory) on this repository, or
- Email the maintainer directly: **kjricciardi@gmail.com**

Include:
- What the vulnerability is and how to reproduce it
- Which component is affected (desktop app, party worker, or the join page)
- What impact you believe it has

You'll get a response within **5 business days**. If the report is valid, a fix will be
prioritized for the next release and you'll be credited in the changelog (unless you prefer
otherwise).

### Scope

**In scope:**
- The Cloudflare party worker (`tldps-party`) — remote code execution, data exposure, room takeover
- The desktop app — local privilege escalation, malicious log file parsing
- The join page (`github.io/STOOP/join.html`) — XSS, open redirect

**Out of scope:**
- Denial-of-service against the party worker (best-effort free infrastructure)
- Social engineering
- Issues in third-party dependencies without a clear STOOP-specific exploit path
