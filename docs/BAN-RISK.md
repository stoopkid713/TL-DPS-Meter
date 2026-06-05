# STOOP & EasyAntiCheat — A Technical and Policy Risk Assessment

> **What this is.** STOOP reads Throne & Liberty's own combat log off disk. This page lays out,
> with sources, what that means for ban risk under EasyAntiCheat (EAC) and Amazon Games' policy.
> The short version lives in the [README FAQ](../README.md#faq); this is the full reasoning.
>
> **Use STOOP at your own risk.** Nothing here is a guarantee — see the risk statement at the bottom.

## TL;DR
- **Technical detection risk is LOW; policy/ToS risk is the real (moderate-to-low) exposure.** A pure local-log-file reader that never injects, never reads game memory, never hooks the renderer, and runs in its own process is materially different from every tool documented as an EAC ban trigger — but Amazon Games' Code of Conduct reserves the right to ban for *any* unauthorized third-party tool regardless of detectability, and while T&L's combat-log feature is officially supported, third-party parsers built on it are not officially blessed.
- **The common "it scans everything, so any tool can get you banned" claim is misleading.** It is technically TRUE that EAC scans system-wide and "only needs to run while the game runs," but EAC's *enforcement* targets injection, memory tampering, hooks, and known-cheat signatures — not the mere presence of an unrelated process. The FiveM/Overwolf examples often cited as proof both *inject DLLs and hook DirectX*, which is precisely the behavior STOOP avoids.
- **Bottom line:** EAC detection of a strictly passive disk-log reader is unlikely on the available evidence, but cannot be *guaranteed* (EAC internals are proprietary and change), and the publisher can sanction any third-party tool by policy. Honest framing: "low technical risk, residual policy risk, no guarantees."

## Key Findings

1. **Combat Logging is an official, first-party T&L feature.** Update 3.11.0 added a "Detailed Combat Log file [that] can be generated on PC which can be started/stopped through a separate Ring Menu option," alongside a personal "Combat Meter." The official notes carry a performance caveat — the feature is "Only available for PC environments, prolonged use may cause temporary game performance degradation due to large file processing" — confirming the game itself was designed to write these log files to disk on player command. STOOP reads exactly those files.

2. **EAC's enforcement targets game-process interaction, not co-running.** Reverse-engineering literature (an academic arXiv paper, secret.club, back.engineering, GuidedHacking) uniformly describes EAC acting on code injection into the protected game, memory tampering, hook detection "outside the memory of the game," process handles opened against the game, manually-mapped drivers, and a blocklist of known cheat signatures. No reviewed source describes EAC banning a separate, non-injecting process merely for reading files off disk.

3. **EAC *is* system-wide visible, so STOOP is not invisible — it is just not a documented trigger.** EAC enumerates running processes, loaded drivers, and uses file-system minifilters that watch for *known cheat* files. A novel, non-injecting log reader with no known-cheat signature and no game-process interaction is not described as a detection target — but "not a documented target" is not the same as "provably safe."

4. **The FiveM/Overwolf/Steam-games ban claim conflates injection with co-running.** Both named tools inject. Per anti-cheat vendor Cryptect, posting on Overwolf's own developer forum: "OverWolf injects OWClient.dll and OWExplorer.dll into [the game].exe...Then they're tampering the following DirectX functions: TestCooperativeLevel, AddRef, Release, Reset, Present." FiveM runs its own injection-heavy client and anti-cheat. If either contributed to an EAC flag, the plausible mechanism is injection/hooking behavior resident on the system — exactly what STOOP does NOT do.

5. **T&L had real false-positive ban panic (Oct–Nov 2024), but the official causes were bot/RMT detection, not "running other programs."** Amazon/NCSoft's official statement on the first wave read: "Today, we enacted a set of bans against accounts suspected of operating bots within Throne and Liberty. We will continue to monitor activity and take action against any bad actors." A second wave followed on October 23. Many players self-reported wrongful "Botting Behavior" bans; some were reversed on appeal. No AGS or EAC statement ever confirmed FiveM, Overwolf, or other Steam games as a ban cause — all such attributions are player speculation.

6. **The canonical log-reader precedent (FFXIV/ACT) shows read-only parsers are undetectable in practice and rarely enforced — though imperfect as an analogy.** FFXIV's ACT actually does *more* than STOOP (its default mode captures network packets, and FFXIV uses no kernel/EAC anti-cheat). Square Enix prohibits all third-party tools in its ToS, yet documented sanctions target parser-based *harassment*, not passive parsing. A pure disk-log reader is technically *more conservative* than ACT.

## Details

### 1. How EAC actually works

EAC is a hybrid user-mode + kernel-mode anti-cheat (now part of Epic Online Services). Per the 2024 academic paper "If It Looks Like a Rootkit and Deceives Like a Rootkit" (arXiv 2408.00500), the EAC kernel driver "scans the whole memory area of the protected game," examines external memory pages for the execute bit to find manually-mapped modules, and "can detect various hooking techniques, alerting the anti-cheat system when such a hook is detected outside the memory of the game." secret.club describes EAC's purpose as letting the anti-cheat "selectively filter which processes are able to interact with the memory of the game process." GuidedHacking summarizes the practical reality: "If a game has easy anticheat you will not be able to inject, attach a debugger... or do anything else to the game process until you bypass EAC first."

EAC does operate system-wide for *visibility*: it enumerates processes and drivers and uses known-cheat blocklists plus file-system minifilters. So a co-running tool is *seen*. But every documented enforcement vector is about touching the protected process or matching a known-cheat signature.

**Bot detection** in EAC/AGS context is behavioral and largely server-side (movement patterns, unattended play, auction-house/RMT signals) — it flags in-game *behavior*, not the presence of a passive desktop tool that sends zero input. A tool that sends no input to the game cannot be "bot" behavior by definition.

**Does EAC ban for mere presence of an unrelated process?** On the available evidence, no — not for an arbitrary clean process. Anecdotes tie bans to VirtualBox/VMs and RGB software (ASUS Aura Sync is known to cause EAC *errors*), but VM detection and RGB conflicts are distinct phenomena from "ran an unrelated app." STOOP is a normal user-mode app reading a text file.

### 2. The inject-vs-read distinction (the core technical question)

This is the crux. STOOP's profile — reads local .txt files the game officially writes, no injection, no memory access, no renderer hook, no packet capture, no input, separate-process overlay — sits entirely outside EAC's documented detection surface. Separate-process overlays (MSI Afterburner/RTSS, OBS, Discord) are routinely run alongside EAC games; the friction they cause is overlay-hooking *conflicts*, not bans — and notably the ones that cause conflicts (RTSS, Discord) do so *because they hook the renderer*. STOOP doesn't even do that. Its overlay is a separate transparent window in its own process, which is the single safest architecture available.

### 3. Official T&L / AGS policy

Combat Logging and the personal Combat Meter are official features (Update 3.11.0). The Combat Meter itself is deliberately scoped: "Only stats for your personal damage dealt will be displayed, damage from other players will not be shown." Separately, the **Amazon Games Code of Conduct** states: "Do not cheat, bot, hack, or use other software or services that give you an unfair advantage through, for example, unattended gameplay or game modifications." The **Amazon Games Terms of Use** (§2.2) add: "you will not, and will not authorize or enable anyone to, circumvent or interfere with any security features."

Note what these prohibit: unfair advantage, game modification, security circumvention. A passive personal DPS readout that modifies nothing and parses an official log arguably does not "give an unfair advantage" or "modify the game" — but AGS retains broad discretion. The closest analogous AGS policy statement comes from the Lost Ark team: AGS Community Manager Roxx stated that "any app that modifies the game and/or interacts with it in a way that provides information that is otherwise not available to players is not approved." This is the key policy risk — a publisher could argue a DPS meter surfaces "information otherwise not available." The counter-argument for STOOP specifically is that T&L now ships its *own* combat log and personal combat meter, so the information is no longer "otherwise unavailable." There is no located AGS statement explicitly permitting OR explicitly banning third-party log parsers for T&L; the community consistently describes DPS meters as an unsupported grey area.

### 4. Ban-appeal process

T&L bans are frequently described in penalty notices as "automatically applied by our detection system." AGS offers a web-form appeal ("Appeal a Penalty"), with each penalty appealable once. Evidence on outcomes is mixed: some Oct 2024 false-positive bans were reversed on appeal (community reports: "a lot of people have been wrongfully banned last week and their ban was lifted after appealing"; one user confirmed "I got un-banned"), while others report rote denials with no evidence disclosed. EAC's own policy states that incorrectly-issued ban rounds "will be automatically reversed by our servers" and that appeals won't otherwise move EAC bans. So human/automated review exists but is inconsistent.

### 5. Precedent from other EAC games and FFXIV

**Lost Ark** (also AGS-published, EAC-protected) DPS meters work by *packet capture* (raw sockets / Npcap / WinDivert) — more invasive than STOOP. One meter author's GitHub README warns: "Smilegate also started to actively ban users of other meters that are running on the same pc. So be cautious about that." This indicates that when enforcement happens against meters, the targets are packet-sniffing tools, and that detection there is meaningful — reinforcing that the *method* (packet interception, which STOOP does not do) matters.

**FFXIV's ACT** (no EAC) is the canonical parser case. Its default mode captures network packets (optionally injecting a DLL only in its "Deucalion" mode); Square Enix prohibits all third-party tools in ToS. Yet documented GM sanctions target parser-driven *harassment*, with enforcement language like "Despite being asked to stop, you continued demanding player X to meet arbitrary parser targets" and "Do not force others to play as you demand to fit your parser metrics" — i.e., the offense is harassment, not the passive parsing itself. This supports "read-only parsers are rarely enforced," with the caveat that FFXIV has no kernel/EAC anti-cheat, so it is not direct EAC precedent.

## Point-by-Point Verdict on Common Claims

**Claim 1: "EAC doesn't have to interact with the game to flag and ban you — it only needs to run while the game runs."**
**PARTIALLY TRUE / MISLEADING.** Technically true that EAC scans system-wide and that a ban can be issued offline/later (both EAC and AGS confirm "you don't need to be online for the ban to be issued"). But the *implication* — that any co-running program risks a ban — is unsupported. EAC's enforcement targets injection, memory tampering, hooks, and known-cheat signatures. The mere presence of a clean, non-injecting process is not a documented trigger.

**Claim 2: "T&L has effectively no human ban-appeal process."**
**PARTIALLY TRUE (overstated).** Bans are automated; the appeal is a one-shot web form; many users report rote denials. But documented reversals of the Oct 2024 false-positive wave prove review *can* overturn bans. "Effectively no human appeal" overstates a real shortcoming.

**Claim 3: "Dozens of players permanently banned in the past weeks for running FiveM, Overwolf, and even different Steam games."**
**UNVERIFIED / LIKELY MISATTRIBUTED.** A real false-positive ban panic occurred (Oct–Nov 2024), well-corroborated by press and forums. But (a) the specific "dozens banned for FiveM/Overwolf/Steam games" wording could not be verified; (b) AGS/EAC never confirmed these causes — all are player speculation; (c) crucially, FiveM and Overwolf both INJECT DLLs / hook DirectX, so any genuine EAC flag would plausibly stem from injection behavior, not co-running. This claim does NOT transfer to a non-injecting tool like STOOP.

## Evidence-Quality Assessment

- **Verified (official):** Combat Logging / Combat Meter as official features and their performance/scope caveats (T&L Update 3.11.0 patch notes); Amazon Games Code of Conduct & Terms of Use language; EAC official ban-policy FAQ; FFXIV ToS / Yoshida third-party-tools statement; the Oct 16 2024 AGS bot-ban statement.
- **Well-corroborated (multiple independent sources):** EAC's injection/hook/memory-tampering enforcement model (arXiv paper + secret.club + back.engineering + GuidedHacking); Oct 16/23 2024 bot ban waves (PCGamesN + Maxroll + AGS social); Overwolf/FiveM injection behavior (Overwolf dev forum/Cryptect + Cfx.re FAQ + security write-ups); Lost Ark packet-capture meters and enforcement (multiple GitHub repos); AGS Roxx "interacts/provides otherwise-unavailable information" policy line.
- **Claimed/anecdotal (single source, unverified):** Specific causal attributions of bans to FiveM/Overwolf/VirtualBox/GeForce Experience (player speculation on Steam forums); the exact "dozens banned" wording; rote-denial appeal experiences.

## Ban-Risk Disclosure (the short, publishable version)

> STOOP only parses Throne & Liberty's own Detailed Combat Log — a log file the game writes to disk when *you* enable the official in-game Combat Logging feature. STOOP does not inject code into the game, does not read or write the game's memory, does not hook the game's renderer, does not capture network traffic, and sends no input to the game. Its overlay is a separate window in its own process.
>
> On the available evidence, this design sits outside what EasyAntiCheat is documented to detect and act on: reverse-engineering research consistently shows EAC enforces against code injection, memory tampering, renderer hooks, and known cheat signatures — not against separate programs that merely read files. Tools commonly blamed for EAC bans (e.g., FiveM, Overwolf) *inject DLLs and hook DirectX*; STOOP does none of that.
>
> However, we cannot and do not guarantee you will not be penalized. EasyAntiCheat is proprietary and its detection logic can change without notice, and Amazon Games' Code of Conduct lets them sanction any unauthorized third-party tool at their discretion, regardless of whether it is technically detectable. Amazon has not published a position specifically permitting third-party log parsers for Throne & Liberty. Use STOOP at your own risk. To minimize exposure, keep STOOP to personal stats and never use it to pressure or harass other players.

## Key Uncertainties and What Would Change the Conclusion

- **EAC internals are proprietary and change.** All technical conclusions rest on reverse-engineering, not official Epic documentation. "Not a documented detection target" ≠ "provably undetectable forever."
- **Policy risk is independent of technical detection.** AGS can sanction any third-party tool by ToS regardless of whether EAC can see it. This is the dominant residual risk, and it would escalate if AGS issued explicit anti-parser language for T&L.
- **The FFXIV analogy is imperfect** (no EAC there; ACT actually packet-captures). It supports "read-only parsers are rarely enforced" but is not direct EAC precedent.
- **Absence of evidence, not evidence of absence:** there is no located, confirmed case of a *pure local-log-file reader* being banned in any EAC-protected game. That is reassuring but not proof.

**Triggers that would raise the risk rating from LOW to MODERATE/HIGH:** (1) any explicit AGS/NCSoft statement banning third-party log parsers for T&L; (2) any corroborated, multi-source report of a user banned specifically for a non-injecting log reader; (3) EAC adding a file-system minifilter signature targeting combat-log parsers; or (4) T&L's ToS adding explicit anti-parser language. Absent these, the assessment stands: **low technical risk, residual policy risk, no guarantees.**

---

*This assessment reflects sources available as of mid-2026 and is not legal advice. It is maintained alongside STOOP as a good-faith summary of the ban-risk landscape, not a promise about how Amazon Games or EasyAntiCheat will behave.*
