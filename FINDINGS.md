# Phase 0 findings (interim)

Status as of 2026-11-24 00:40, end of day one. **Phase 0 is not finished.** One
full encrypted backup has completed over USB, and three incrementals have
completed over WiFi from a Linux container, one of them started with the
phone locked. Neither has been decrypted or
restored, and nothing has been tried over the tailnet. Sections marked *not
tested* are still open; see [What is left](#what-is-left).

Evidence is labelled throughout:

- **Measured**: I ran it against the phone and saw the result.
- **Reported**: read in project source, docs or issue trackers by a research
  pass, not reproduced here.

Device identifiers (UDID, MAC, addresses) are kept out of this file; raw logs
are in the git-ignored `local/` folder.

## Summary

- **A full encrypted backup over USB works on iOS 26.6.1** with
  pymobiledevice3, driven by this repo's sidecar: 22 GB, 123,290 files, in
  12 min 58 s.
- **An incremental backup over WiFi works from an Alpine Linux container**
  with no USB, no usbmuxd, no root and no host networking, using only a pair
  record exported from the Mac. Done twice: 5 min 38 s with the phone also on
  the Mac's USB, and 6 min 17 s with it unplugged from the Mac entirely. This
  is the path dockyard would use.
- **The service's own code has backed the phone up.** `pommedonjon backup`,
  run from the read-only container with the phone on battery, completed an
  incremental in 4 min 48 s, verified it and recorded it. The daemon loop
  deciding by itself when to start has still not been run for real.
- The phone was already paired with the Mac, with backup encryption on and
  WiFi connections enabled, so no phone settings were changed.
- Classic lockdown over WiFi (TCP 62078) carries the whole backup protocol on
  iOS 26.6.1. The RemotePairing tunnel is not needed on the LAN.
- **Every backup start raises a passcode prompt on the phone, and an
  unanswered prompt fails the backup after 60 seconds.** A locked phone wakes
  and shows the prompt on its lock screen, where it can be answered. This is
  the main constraint on the whole design: backups need the owner for a few
  seconds at the start, so a 3 a.m. unattended backup will not work, but an
  evening run that the owner answers from the lock screen will.
- **The phone stayed reachable all night while charging.** Over 7 h 24 min
  (83 checks, five minutes apart), a lockdown query from the container to the
  phone's address succeeded on every one of the 82 checks where the address
  was known. The Mac's usbmuxd was less dependable: it did not list the
  phone's network entry for the first two hours. A bare port probe found
  62078 not accepting on 14 checks, each time followed seconds later by a
  successful query, so one refused connection means "try again", not "away".
  The phone was on a charger throughout; a sleeping phone on battery is still
  untested.
- Recommended shape: TypeScript daemon and UI, with pymobiledevice3 driven
  through a small Python sidecar that emits JSON events.

## Test setup

| | |
|---|---|
| Phone | iPhone17,5, iOS 26.6.1 (23G83), about 34 GB of data used |
| Host | MacBook Pro, macOS 26.7.3, USB 2 link (480 Mb/s) |
| pymobiledevice3 | 11.63.1 (pipx, Python 3.14) |
| libimobiledevice | 1.4.0 (Homebrew) |
| Container | `python:3.14-alpine` (Alpine 3.24, arm64) + pymobiledevice3 11.63.1 |
| Project | Node 24, pnpm 12, TypeScript 7, Vitest 5 |

The dockyard VM's CPU architecture is not confirmed; the container was only
built for arm64 here.

## Hypotheses

| # | Hypothesis | Verdict | Basis |
|---|---|---|---|
| 1 | mobilebackup2 is open and implemented in libimobiledevice, pymobiledevice3 and the Rust `idevice` crate | Confirmed | Reported. pymobiledevice3 releases almost daily and its maintainer tests on iOS 26.6; libimobiledevice 1.4.0 (Oct 2025) has open iOS 26 backup issues; `idevice` fixed an iOS 26.5 backup failure in July 2026 |
| 2 | On iOS 17+ classic lockdown no longer works over WiFi, so the RemotePairing tunnel is the only network path | **Wrong for iOS 26.6.1** | Measured: an incremental backup completed over WiFi through lockdown on port 62078 |
| 3 | iOS prompts for the passcode when a backup starts | Confirmed | Measured on all four attempts over USB with encryption on. Reported: every local backup since iOS 16.1, no bypass found |
| 4 | iOS 26.4 broke WiFi backup for iTunes on Windows | Partly | Reported: 26.4 removed the stable MAC from the Bonjour advert; hosts must match an `authTag` derived from the pair record. Apple's Windows tools are still reported broken; pymobiledevice3 added the matching in Sept 2026 |
| 5 | Bonjour does not cross Tailscale; a spoof-and-relay workaround exists | Partly | Reported: mDNS over Tailscale is a long-open issue. The spoof is one blog post, for app installs over RemotePairing, not backups. Port 62078 is reported to refuse connections from outside the phone's subnet; confirmed for the lockdown session, see [From another subnet](#from-another-subnet-2026-11-24) |
| 6 | Reference projects are worth studying | Confirmed | See [Reference projects](#reference-projects) |

## What was measured

### Backup attempts (encryption on; 1 to 5 over USB, 6 to 16 over WiFi)

| # | Tool | Passcode prompt | Outcome |
|---|---|---|---|
| 1 | CLI, `--full` | Appeared at +3 s, unanswered, dismissed at +61 s | Failed: `Device locked (MBErrorDomain/208)` |
| 2 | CLI, `--full` | Appeared at +4 s, typed at +10 s | Ran 20 min 44 s to 42%, 12 GB in 10,227 files, then the cable was unplugged: `Connection was terminated abruptly` |
| 3 | Sidecar | Appeared at +1 s, unanswered, dismissed at +60 s | Failed: error 208 |
| 4 | Sidecar, `--full`, fresh directory | Appeared at +1 s, unanswered, dismissed at +60 s | Failed: error 208, reported by the sidecar as code 208 and mapped to `device-locked` |

| 5 | Sidecar, `--full`, same directory | Appeared at +0 s, typed at +3 s | **Completed** in 12 min 58 s (778 s): 22 GB, 123,290 files, sidecar exit 0 |

| 6 | Sidecar inside the Alpine container, direct TCP over WiFi, incremental onto a clone of attempt 5 | Appeared at +3 s, typed at +16 s | **Completed** in 5 min 38 s (338 s), sidecar exit 0 |

| 7 | As 6, with the phone unplugged from the Mac (on another charger) | Appeared at +4 s, typed at +7 s | **Completed** in 6 min 17 s (377 s), sidecar exit 0 |

| 8 | As 6, started while the phone was **locked** | Appeared at +6 s; the phone woke by itself and showed the prompt on the lock screen; typed at +18 s | **Completed** in 5 min 55 s (355 s), sidecar exit 0 |

| 9 | **`pommedonjon backup`** from the read-only, unprivileged container: runner, transport and sidecar together. Phone **on battery** (97%), incremental onto a clone of attempt 8 | Appeared at +3 s after the backup started, closed at +8 s | **Completed** in 4 min 48 s (288 s) including the 5-second heads-up wait; verified, recorded as succeeded, exit 0 |

Attempt 9 is the first run driven by the service's own code and not by the
sidecar alone (morning of 2026-11-24). The run history recorded the whole
sequence: started, passcode required, passcode dismissed, then progress from
0% to 100%. The runner's verification passed (complete, the right phone,
encrypted) and `pommedonjon status` afterwards reported the last good backup.
Snapshots were off, so nothing was preserved beyond the working copy.

Three things it turned up:

- **On battery, the first probe timed out.** A `probe` a minute or two before
  the run got no answer; a bare connection to port 62078 then succeeded, and
  two more probes answered at once. It fits the overnight pattern of the
  phone needing one contact before it answers. Seen once.
- **The command said nothing while it ran.** It logged the heads-up and then
  nothing until the result, so there was no cue to pick up the phone. The
  runner now logs the passcode stage and progress.
- **Progress sat at 0% for two and a half minutes**, then went to 100% in
  the next 80 seconds. Presumably an incremental spends that first stretch
  working out what changed. A progress bar will need to allow for it.

Attempts 10 to 12, the same morning, with the phone **locked and on
battery**. All three used `pommedonjon backup` from the container.

| # | What happened | Outcome |
|---|---|---|
| 10 | Connection attempt timed out about a second after the backup started | Failed as `unreachable`; the phone showed nothing |
| 11 | The same, six seconds after a plain connection from the Mac had succeeded | Failed as `unreachable`; the phone showed nothing |
| 12 | After the sidecar was changed to keep dialling: connected at +11 s, prompt at +14 s. The owner saw a keypad **with a message** and typed the passcode | Failed: the session was lost 2.5 s after connecting and the backup's connection dropped 7.6 s after the prompt. Recorded as `unreachable`, with the prompt noted |

What these show:

- **A phone on battery can be slow to accept a connection.** Five raw
  connections in a row took 0.09, 0.01, 0.10, 0.11 and 6.66 seconds.
  pymobiledevice3 allows one second per dial. Six probes in a row failed
  that way; with a 12-second dialling window the next probe took 12 seconds
  and succeeded, and the five after it answered within a second.
- **A locked phone on battery dropped the session mid-prompt.** In attempt
  12 the keep-alive connection was closed by the phone almost at once, and
  the backup connection followed although the passcode had been typed. Seen
  once. One reference project reports the same thing on iOS 26.6 (see
  [Reference projects](#reference-projects)). Attempt 9, also on battery but
  with the phone unlocked and in hand, completed.
- **The locked prompt does not always look the same.** Attempt 8 (locked, on
  a charger): bare keypad, no text. Attempt 12 (locked, on battery): keypad
  with a message. The owner also reports a prompt with a clear message when
  the phone was unlocked. What decides which appears is not known.
- **Cancelling the prompt has still not been observed**, so a cancel cannot
  yet be told from a timeout (DECISIONS.md O17).
- Two bugs surfaced and were fixed: the connection gave up too early, and a
  failed run's log line said "TimeoutError" where it should have said
  "backup failed".

Attempts 13 and 14, later the same morning, with the reworked code
(discovery, verified marker, schemas). Phone unlocked, in hand, on battery
at 94%.

| # | What happened | Outcome |
|---|---|---|
| 13 | Prompt appeared 3 s after the backup started. **The owner tapped Cancel.** It closed 2.6 s later | Failed at once with `Device locked (MBErrorDomain/208)`, the same error as a timeout |
| 14 | Prompt appeared at +3 s, passcode typed, closed at +7 s | **Completed** in 4 min 11 s (251 s): verified, `verified.json` written, recorded as succeeded |

Attempts 15 and 16, the evening of 2026-11-24: the first backups started by
the daemon's own decision, from the test stack on the server, which is on a
different VLAN from the phone and writes to the NAS over NFS. The NAS had
been seeded with attempt 14's backup. The owner plugged the phone in and
did nothing else.

| # | What happened | Outcome |
|---|---|---|
| 15 | The daemon saw the phone go onto power on its next poll and started a backup | Failed after 8 s as `unreachable`: the firewall allowed only port 62078 and the backup service is on another port (see "From another subnet"). No prompt was shown |
| 16 | Ten minutes later, after the pause for a failed attempt, the daemon started again by itself. Prompt 9 s after the start, passcode typed, closed 4.7 s later | **Completed** in 6 min 15 s (375 s): incremental, verified, `verified.json` written |

What these show:

- **The whole loop works unattended on the server side:** plug-in seen,
  backup started, failure backed off and retried, result verified and
  marked, all without anyone touching the server.
- **Plug-in detection works on a real phone.** The poll before had the
  phone on battery, the next had it on power, and that was taken as "just
  plugged in".
- One poll between the two attempts got no answer from the phone although
  it was plugged in and in use. The next poll, two minutes later, found it
  again and the plug-in was still counted as recent.
- An incremental over NFS with sync disabled took 6 min 15 s, against
  4 min 11 s for attempt 14 to a local disk. The two are not the same amount
  of changed data, so this is not a measure of the share.

What attempts 13 and 14 show:

- **The phone does not distinguish a cancel from a timeout.** Both end in
  error 208. What differs is how long the prompt was open: 2.6 seconds when
  cancelled, 58 to 61 when left alone (attempts 1, 3 and 4). The transport
  now reports a prompt that closed in under 45 seconds, followed by that
  error, as cancelled. One observation, on an unlocked phone; a cancel from
  the lock screen and a wrong passcode have not been seen.
- **The reworked code backs the phone up end to end.** The phone was found
  at its remembered address, the backup ran and verified, and the marker
  file appeared beside it with the phone's UDID and the time.
- **Battery is not always bad.** This is the second successful backup on
  battery, both with the phone unlocked and in hand. The failures on battery
  were with it locked.

Attempt 8 answers the locked-phone question (owner's observation plus the
event log): a locked phone lights its screen and shows the backup passcode
prompt on the lock screen, the passcode can be typed there, and the backup
then runs. The prompt took 6 seconds to appear, against 1 to 4 seconds when
unlocked. In the three unanswered attempts nobody was watching the phone.

Attempt 5, the baseline:

- About 28 MB/s average over USB 2. Progress was close to linear: 10% roughly
  every 70 seconds.
- The result is an encrypted backup in the standard layout: `Manifest.plist`
  (368 KB, `IsEncrypted: true`, backup keybag present, iOS 26.6.1),
  `Manifest.db` (202 MB, encrypted as expected), `Status.plist` with
  `SnapshotState: finished`.
- `Status.plist` says `IsFullBackup: false` even though `--full` was passed.
  Not investigated.
- Not yet verified: that it decrypts with the backup password, or restores.
- The phone stayed on usbmuxd's USB list afterwards.

Attempt 6, the WiFi incremental, started 13 minutes after the baseline
finished:

- It wrote 95 files totalling 495 MB, of which `Manifest.db` alone is 202 MB.
  Four files were added and two removed against the baseline.
- Progress reached 99% in under 3 minutes; the last 1% and the finishing
  steps took another 2.5 minutes. Progress is not linear for incrementals.
- The phone was plugged into the Mac by USB throughout, but the connection
  was made to its WiFi address from inside the container.
- The backup directory was bind-mounted from macOS through Docker Desktop,
  which is slower than a native Linux mount; dockyard may do better.
- The baseline it was cloned from was not modified (APFS copy-on-write clone,
  no extra disk used). This is the working-copy-then-snapshot pattern in
  miniature.
- A full backup over WiFi has not been timed.

Attempt 7, WiFi only, started 8 minutes after attempt 6 finished:

- The phone was off the Mac's USB entirely (not on the USB bus, not in
  usbmuxd), on a separate charger at 93%, so the Mac played no part beyond
  hosting the container.
- It wrote 131 files totalling 343 MB and took 6 min 17 s. So two
  near-empty incrementals cost about 6 minutes each: there is a fixed
  overhead of several minutes regardless of how little changed.
- Progress jumped from 23% to 99% in one step about 3.5 minutes in, then took
  2.7 more minutes to finish. Progress events are not a usable ETA for
  incrementals.
- On battery (no charger at all) is still untested.

Attempt 2 ran at about 9.7 MB/s, a third of attempt 5's rate. The Mac was busy
with other spike work during attempt 2 (image builds, extra device queries),
which may explain it; the cause was not isolated.

### Behaviours worth designing around

- **Passcode window is 60 seconds.** After that iOS dismisses the prompt and
  the backup fails with error 208. The prompt-dismissed event alone does not
  say whether the passcode was typed.
- **The prompt explains nothing.** On a locked phone the screen simply turned
  on showing the passcode keypad, with no text saying a backup was asking or
  which computer wanted it (owner's observation, attempt 8). To the owner it
  is an unexplained passcode request. Two consequences: the service must send
  its own heads-up through another channel just before it starts ("pommedonjon
  is about to back up your phone, enter your passcode"), and nobody should be
  taught to type their passcode into unexplained prompts, so a prompt with no
  matching heads-up should be treated as suspect. Whether the prompt carries
  text when the phone is already unlocked was not noted.
- **Starting a backup wakes a locked phone.** The screen lights and shows the
  prompt. So a run scheduled for the middle of the night would light the
  phone for up to a minute and then fail; a run in the evening acts as a
  visible nudge the owner can answer from the lock screen.
- **The phone's `.local` name does not resolve reliably.** One lookup returned
  only link-local IPv6 addresses and no IPv4 address, seconds before the phone
  answered ping on its usual address, and one of the 83 overnight lookups
  failed outright. The daemon needs a configured or last-known address to
  fall back on, and must treat a failed lookup as "unknown", not "absent".
- **`Status.plist` is not proof of a good backup.** After attempt 3 failed at
  the passcode stage, `Status.plist` read `SnapshotState: finished`,
  `IsFullBackup: true`, while `Manifest.plist` was 0 bytes and there was no
  `Manifest.db`. After the unplugged run it read `uploading`. A completeness
  check must also require the manifest files.
- **An incomplete directory restarts as a full backup.** Rerunning without
  `--full` onto the 12 GB partial rewrote its status with a new UUID as a full
  backup. Whether the phone would have re-sent the 12 GB is unknown because
  that run never got past the prompt.
- **usbmuxd dropped the USB entry mid-backup.** During attempt 2 the Mac's
  usbmuxd listed the phone as network-only from about +80 s onwards, although
  USB data kept flowing. Seen once; cause unknown. Presence detection should
  not treat a missing USB entry as "unplugged" while a backup is running.
- **The CLI prints no live progress unless attached to a terminal.** Hence the
  sidecar, which uses the library's progress callback.

### Network and discovery

- Over WiFi the phone advertises `_apple-mobdev2._tcp` and
  `_remotepairing._tcp`. `_remoted._tcp` appears only on the USB network
  interface.
- The `_apple-mobdev2._tcp` record gives port 32498, which is closed. The
  lockdown service is on 62078. Do not use the advertised port.
- `_remotepairing._tcp` is on port 49152, open, with TXT keys `identifier`,
  `authTag`, `ver=24`, `minVer=8`.
- The mobdev2 instance name contains a private (randomised) MAC, which stayed
  the same all night. The RemotePairing instance identifier rotates about
  once an hour: eight different values overnight, changing at roughly half
  past each hour. Neither is a stable identity; matching has to go through
  `authTag`.
- The Mac's `ideviceinfo -n` answered in 0.2 s over WiFi with the phone awake.
- A few minutes after the phone was put down for the night (still on USB to
  the Mac): the Mac's usbmuxd stopped listing the phone's network entry, so
  `ideviceinfo -n` reported "device not found", yet a direct TCP lockdown
  query to port 62078 with the pair record still succeeded from both the Mac
  and the container. Ping and Bonjour also still worked. One port probe in
  that period found 62078 closed; the next, 50 seconds later, found it open.

### From another subnet (2026-11-24)

The test server is on a different VLAN (`192.168.40.0/24`) from the phone
(`192.168.1.0/24`), behind a UniFi gateway.

| Path from the server to the phone | TCP 62078 | Lockdown session |
|---|---|---|
| Firewall allow rule only | opens | dropped by the phone, every attempt |
| Allow rule and masquerade onto the phone's network | opens | works; probe answered in 2 s |
| The phone's Tailscale address | opens | dropped by the phone |

- The phone accepts the TCP connection in all three cases. What it refuses
  is the lockdown session, when the source address is not on its own subnet.
- With the masquerade policy the phone sees the gateway's address on its
  own network. Nothing else was changed between the failing and the working
  probe.
- Tested with the phone awake and on battery. Not yet tested overnight.
- **62078 is not the only port.** A backup opens a second connection: the
  lockdown session on 62078 asks the phone to start the backup service, and
  the phone answers with a port for it that is different every time. Asked
  four times, it gave 64435, 64437, 64447 and 64448. With the firewall rule
  and the NAT policy limited to 62078, a probe worked (it only uses the
  lockdown session) while the first backup the daemon started failed after
  8 s with a timeout. With both widened to TCP 49152 to 65535 the service
  ports were reachable. The range is the usual one for dynamic ports, not
  something the phone states; only those four values have been seen.

### Writing a backup to an NFS share (2026-11-24)

Copying the 22 GB backup (123,287 files) from the server to the NAS over
NFS 4.2:

- New files were created at about 16 a second, whether one stream was
  writing or eight. One large file went at about 200 MB/s. So the limit is
  the rate of creating files, not bandwidth.
- The remaining 97,000 files took 1 h 42 min.
- The cause was the dataset's sync setting. On Standard the NAS commits
  each new file to disk before answering. With sync set to Disabled on that
  one dataset, 1,000 files of 4 KB were created at about 500 a second
  (two rounds: 526 and 480), roughly thirty times faster.
- The cost of Disabled is that a NAS crash can lose the last few seconds of
  writes. That is acceptable here: ZFS comes back in a consistent earlier
  state, so `verified.json` cannot survive without the files written before
  it, and an interrupted backup is left unverified for the next run to
  repair.
- An incremental backup writes far fewer files, so this mostly matters for
  a first full backup.

### Overnight reachability (night of 2026-11-23)

`scripts/presence-monitor.sh` checked the phone every five minutes from 23:46
to 07:10: 83 checks. The phone was on the Mac's USB the whole time, so it was
charging (74% at the start, 100% from 01:05). Its owner went to bed at about
01:05; that the phone then sat locked and untouched is assumed, not observed.

| Check | Result |
|---|---|
| Lockdown query from the container, direct to TCP 62078 with the pair record | 82 of 82 where the address was known |
| Bonjour adverts on WiFi (`_apple-mobdev2._tcp`, `_remotepairing._tcp`) | 83 of 83 |
| `.local` name resolves | 82 of 83 |
| Bare port probe of 62078 (`nc`, 3 s limit) | open 68, not accepting 14, not tried 1 |
| Mac's usbmuxd lists the network entry | 64 of 83 |
| Mac's usbmuxd lists the USB entry | 74 of 83 |

- **Direct lockdown never failed.** The single miss was the check where the
  name did not resolve, so nothing was tried. That includes all 14 checks
  where the port probe had just reported the port as not accepting.
- **The port stops accepting briefly and often.** The 14 misses were 21 to 47
  minutes apart, lasted one check each except for one pair, and happened both
  before and after the owner went to bed. The probe cannot tell a refusal
  from a 3-second timeout. A plausible reading is that the phone's WiFi dozes
  and the first connection wakes it, but that was not tested.
- **usbmuxd's network entry came and went on a long cycle.** Missing for the
  first 19 checks (23:46 to 01:36), then present for the remaining 64. The
  cause is unknown. A mux daemon in the path would have reported the phone as
  absent for two hours while it was answering directly.
- **The USB entry dropped for single checks nine times** with the cable in.
  The USB network interfaces vanished from Bonjour on the same checks.

What this does not show: a phone asleep on battery, a phone on a different
subnet from the server, or behaviour over more than one night. Samples are
five minutes apart, so shorter gaps are invisible.

Consequences for the daemon:

- Probing a configured address directly (D2, D6) is the dependable path.
- A refused or timed-out connection is not evidence that the phone is away.
  The daemon already treats a failed probe as "wait and ask again at the next
  poll", which fits. A backup that fails to connect at its very start is
  different: today it counts as a failed run and waits out the 60-minute
  back-off. See DECISIONS.md O15.

### Pair record portability

- The Mac's pair record can be read from its usbmuxd without root and without
  contacting the phone. It contains the host and root certificates and private
  keys, the device certificate, `HostID`, `SystemBUID`, `WiFiMACAddress` and
  the `EscrowBag`.
- Mounted read-only into the Alpine container, it authenticated lockdown
  sessions over WiFi: six of six version queries, battery and
  backup-encryption reads, and then a complete incremental backup (attempt 6).
  One connection was refused immediately after a burst of port probes and did
  not recur.
- This file grants full access to the phone. It needs secret handling, not a
  bind mount from a shared dataset.

## Recommended transport

**pymobiledevice3, over classic lockdown on TCP 62078, driven as a library
from a small Python sidecar that speaks newline-delimited JSON to the
TypeScript daemon.**

Why:

- It is the only one of the three implementations with an active maintainer
  testing on iOS 26.6, and it already has the 26.4 `authTag` matching.
- It connects straight to the phone by address with a supplied pair record, so
  the container needs no usbmuxd, no netmuxd, no root and no host networking.
- A sidecar gives structured events (passcode prompt, progress, device error
  codes) instead of scraping terminal output, which is what the one reference
  project using pymobiledevice3 does.

Alternatives considered:

- **libimobiledevice**: no built-in network path on Linux (needs netmuxd), no
  way to set `EnableWifiConnections`, open iOS 26 backup issues. Keep as a
  second opinion for debugging.
- **Rust `idevice` crate**: maintained and a good fit if the sidecar ever needs
  to be a single static binary. More work now for no gain yet.
- **RemotePairing tunnel**: not needed on the LAN. It is the candidate for the
  tailnet path only, where 62078 is reported not to work.

Attempt 6 exercised exactly this path end to end. What it has not shown is a
full (first) backup over WiFi, behaviour with the phone off USB and on
battery, or anything across VLANs.

## TypeScript scope

Agreed direction: TypeScript for the daemon, server and UI; other languages
where they fit better. On that basis a native TypeScript device transport is
not worth pursuing:

- Lockdown, pair-record TLS and AFC exist in Appium's `appium-ios-remotexpc`,
  but not as importable library code, and it has no direct-TCP lockdown.
- No usable TypeScript mobilebackup2/DeviceLink exists. The estimate is
  2,500 to 4,000 lines to write, tracking Apple's changes alone.
- The tunnel path is not realistic in Node on Alpine without root.

The `DeviceTransport` interface in `src/transport/` keeps that door open
without paying for it.

## What exists in the repo

First built the night of 2026-11-23/24, then reworked on 2026-11-24 to the
design in [DECISIONS.md](DECISIONS.md). 268 unit tests pass under Node 26;
all use fakes for the phone and the sidecar.

| Part | Where | Tried against the real phone? |
|---|---|---|
| Sidecar: `probe`, `backup`, `verify` | `sidecar/pommedonjon_sidecar.py` | Yes, all three |
| Transport interface and implementation | `src/transport/` | Yes (attempt 9) |
| Config, as a Zod schema | `src/config/` | n/a; the container loads real configs with it |
| Discovery: range sweep, locator, address book | `src/discovery/` | Yes: found the phone by sweeping the home /24 from the container, on the second sweep |
| Schedule and plug-in detection | `src/policy/` | Yes (attempts 15 and 16) |
| Storage: one backup per phone, verified marker | `src/storage/` | Yes (attempt 14) |
| Run history in SQLite | `src/state/` | Yes: recorded attempts 9 to 12, then upgraded in place to the current schema |
| Runner: back up, verify, record | `src/runner/` | Yes (attempts 13 and 14) |
| Daemon: one cycle per phone, stale alerts | `src/daemon/` | Started and stopped cleanly in the container with a backup not due. A backup it started itself: **no** |
| Trial record and `report` command | `src/report/`, `src/state/` | The report: yes, on the morning's real history. Power and waiting records: **no**, nothing has been recorded by a running daemon yet |
| Pair record permission check | `src/credentials/` | Yes: warned on a 644 file mounted as a Compose secret, silent on 600 |
| CLI: `daemon`, `probe`, `backup`, `status`, `report` | `src/cli.ts` | All but a working `daemon`: yes |
| Container image and Compose example | `Dockerfile`, `compose.example.yaml` | `probe` through Compose with secrets, read-only and unprivileged: yes |

Not built: notifications (they go to the service log only), mDNS discovery,
the web UI. Cancel detection was built after attempt 13 and has only been
run against fakes.

**The next real test owed** is the field trial: the daemon running for a
week or two and starting backups by its own decision when the phone is
plugged in. Nothing has yet exercised plug-in detection on a real phone.

Things the build turned up:

- **The phone's Tailscale address does not work for lockdown.** Port 62078
  accepts a connection on the Tailscale address, then the phone drops the
  session: two probes failed after 13 seconds each while the same probe to
  the WiFi address succeeded. So the direct path does not extend over the
  tailnet, and the phone does treat connections differently by where they
  arrive.
- **A range sweep finds the phone, but not always first time.** From the
  container, sweeping the home /24 for port 62078 and then proving identity
  with the pair record found the phone on the second sweep, with the phone
  on battery. In a separate measurement the phone did not accept a
  connection within 2 seconds from either the container or the Mac, moments
  after accepting three in a row. The first contact seems to wake it. Once
  found, its address is remembered and probed with a 12-second dialling
  window, which has been dependable.
- **A sweep from a container is slow for dead addresses.** They time out
  instead of failing fast (250 of 254 timed out, against an immediate
  "host down" on the Mac itself), so a sweep's length is set by the timeout
  and how many connections run at once: about 4 seconds for the first knock
  and 12 for the second.
- **Copy snapshots were full copies** (the feature has since been removed;
  keeping history is left to whoever runs pommedonjon). On APFS, snapshotting the real 22 GB
  backup took 84 to 105 seconds and 22 GB of disk each. Node does not make
  copy-on-write clones on macOS. For the ZFS dataset, real ZFS snapshots are
  the right tool and the copy strategy should stay off.
- **A read-only container needs a writable `$HOME`.** pymobiledevice3 creates
  a data folder there on start-up. The image points `$HOME` at `/tmp`, to be
  mounted as tmpfs. It left no copy of the pair record there.
- **Local faults must not look like an absent phone.** The sidecar first
  reported that filesystem error as "unreachable". It now only calls network
  errors unreachable.
- **The backup window depends on the container's timezone.** Without `TZ`
  set, an evening window opens at the wrong hours.

## Risks

1. **Passcode prompt on every backup.** No bypass is known. Fully unattended
   backups are not achievable; the realistic target is "one passcode entry,
   at a moment the owner is already holding the phone".
2. **A phone on battery is a worse target than one on a charger.** One
   night on a charger showed no gaps and every direct query succeeded. On
   battery, connections were slow to open and one session was dropped
   mid-prompt on a locked phone. Backing up only on a charger (DECISIONS.md
   D7) avoids depending on that.
3. **Apple can change this again.** 26.4 already changed discovery. Classic
   lockdown over WiFi could be withdrawn in a later release.
4. **Tailnet path is unproven** and may need the RemotePairing tunnel plus
   address relaying.
5. **Dependency on one maintainer's project** (pymobiledevice3, GPL-3.0). The
   sidecar boundary limits what its licence touches, but that should be
   checked before publishing anything.
6. **Pair record handling.** It is a long-lived, full-access credential that
   must live on dockyard.
7. **Different subnets.** The owner's server and phones are on different
   VLANs. mDNS will not cross them without the router relaying it, and port
   62078 is reported to refuse connections from outside the phone's subnet.
   Neither has been tested (DECISIONS.md O5).

## Decisions and design

These were here as "Decisions needed before deploying" and "Proposed Phase 1
design". Both are superseded by [DECISIONS.md](DECISIONS.md), which was
revised after the owner's review on 2026-11-24 and is the single place for
what is decided, what is in scope and what is open.

## Reference projects

All findings here are reported, from reading their source.

| Project | Transport | Worth borrowing | Weakness |
|---|---|---|---|
| ios-backup (Unraid) | pymobiledevice3, RemotePairing tunnel, privileged container | Passcode-waiting metric and alert | Scrapes terminal output; backs up in place with no last-good copy |
| AirVault (Unraid) | Own Go implementation over lockdown 62078 with netmuxd | Unlock-triggered start, failure back-off, staged snapshot with atomic publish | Open issue: WiFi fails on iOS 26.6 when the phone resets the lockdown session |
| BBackupp (macOS) | Embedded libimobiledevice | Completeness check before snapshotting with restic; skips when locked | Unmaintained. Its mux proxy fakes a network device by IP; the Tailscale claim is README-only |
| ios-backup-machine | libimobiledevice, USB only | Before/after fingerprints of completion files, silence watchdog | User must be present at the box |

The two WiFi-capable projects disagree: ios-backup's README calls legacy WiFi
sync dead on current iOS, while AirVault uses it on iOS 26. The measurements
above side with AirVault, with the locked-phone caveat.

## What is left

Needs the phone and its owner (each backup start needs the passcode):

1. ~~One complete full backup over USB, timed.~~ Done: 12 min 58 s. Still to
   do on it: confirm it decrypts with the backup password (typed by the
   owner, never stored).
2. ~~Backup over WiFi through lockdown from the container.~~ Done for two
   incrementals, the second with the phone off the Mac's USB. A full backup
   over WiFi is still to do.
3. RemotePairing path, then a backup through it. Lower priority now that
   lockdown works on the LAN; it matters for the tailnet.
4. Resume after an interrupted run, and an incremental after a normal day's
   use rather than 13 minutes.
5. ~~Locked vs unlocked.~~ Done (attempt 8). On battery: one backup done
   (attempt 9), with the owner at the phone. Still to do: on battery with the screen off for
   30+ minutes, and whether lock/unlock events are observable over WiFi.
6. Tailnet: phone off home WiFi, direct by Tailscale address on both paths,
   then spoof and relay.

Needs no one:

7. ~~Overnight reachability log.~~ Done; see "Overnight reachability". The
   raw data is `local/logs/presence-overnight.ndjson`.
8. Confirm a completed backup decrypts and is structurally sound.

## Sources

- https://github.com/doronz88/pymobiledevice3 (docs: `ios17-tunnels`,
  `network-stacks`, `idevice-protocol-layers`; issues 1076, 1879, 1994, 2184)
- https://github.com/libimobiledevice/libimobiledevice (issues 1710, 1735)
- https://github.com/jkcoxson/netmuxd (issue 57), https://github.com/jkcoxson/idevice (issue 108)
- https://imazing.com/blog/ios-264-and-wi-fi-device-connectivity
- https://imazing.com/blog/ios-backup-passcode-prompt
- https://github.com/tailscale/tailscale/issues/1013
- https://dev.to/kvnpt/how-to-remotely-iterate-deploy-your-sideloaded-ios-apps-over-tailnet-jak
- https://github.com/appium/appium-ios, https://github.com/appium/appium-ios-device
- https://github.com/louij2/ios-backup, https://github.com/wizier/airvault,
  https://github.com/Lakr233/BBackupp, https://github.com/giovi321/ios-backup-machine
