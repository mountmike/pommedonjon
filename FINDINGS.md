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
| 5 | Bonjour does not cross Tailscale; a spoof-and-relay workaround exists | Partly | Reported: mDNS over Tailscale is a long-open issue. The spoof is one blog post, for app installs over RemotePairing, not backups. Port 62078 is reported to refuse connections from outside the phone's subnet. *Not tested here* |
| 6 | Reference projects are worth studying | Confirmed | See [Reference projects](#reference-projects) |

## What was measured

### Backup attempts (encryption on; 1 to 5 over USB, 6 to 8 over WiFi)

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
  its own heads-up through another channel just before it starts ("nightstand
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

Built the night of 2026-11-23/24, at the owner's request, ahead of the Phase 0
review. 113 unit tests pass; all use fakes for the phone and the sidecar.

| Part | Where | Tried against the real phone? |
|---|---|---|
| Sidecar: `probe`, `backup`, `verify` | `sidecar/nightstand_sidecar.py` | `backup`: yes, by its earlier version (attempts 5 to 8). `probe` and `verify`: yes, read-only |
| Transport interface and implementation | `src/transport/` | `probe`: yes. `startBackup` with the new argument layout: no |
| Config loading and validation | `src/config/` | n/a |
| Due-policy: interval, window, back-off, prompt budget | `src/policy/` | n/a |
| Storage: working copy, verification, snapshots | `src/storage/` | Verification: yes. Snapshot copy: yes, on a clone of the real backup |
| Run history in SQLite | `src/state/` | n/a |
| Runner: heads-up, back up, verify, snapshot, record | `src/runner/` | **No** |
| Daemon loop and stale alerts | `src/daemon/` | Idle only: started outside the window for 3 seconds |
| CLI: `daemon`, `probe`, `backup`, `status` | `src/cli.ts` | `probe` and `status`: yes. `backup` and a working `daemon`: **no** |
| Container image | `Dockerfile` | `probe` from a read-only, unprivileged container: yes |

Not built: mDNS discovery (devices are found by configured address), any
notification channel (notifications go to the service log only), email
alerts, ZFS snapshot integration, the web UI.

**The first real test owed** is `nightstand backup --device <id>` from the
container, which needs one passcode entry.

Things the build turned up:

- **Copy snapshots are full copies.** On APFS, snapshotting the real 22 GB
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
2. **WiFi lockdown availability is only characterised for a charging phone.**
   One night on a charger showed no gaps longer than a single five-minute
   check, and every direct query succeeded. A sleeping phone on battery may
   behave differently; the charger requirement in the default policy avoids
   depending on that.
3. **Apple can change this again.** 26.4 already changed discovery. Classic
   lockdown over WiFi could be withdrawn in a later release.
4. **Tailnet path is unproven** and may need the RemotePairing tunnel plus
   address relaying.
5. **Dependency on one maintainer's project** (pymobiledevice3, GPL-3.0). The
   sidecar boundary limits what its licence touches, but that should be
   checked before publishing anything.
6. **Pair record handling.** It is a long-lived, full-access credential that
   must live on dockyard.
7. **VLANs.** Not looked at yet: mDNS will not cross VLANs without a
   reflector, and dockyard needs a firewall rule to reach the phones on 62078.

## Decisions needed before deploying

1. **Notification channel** for the heads-up and alerts. Until one exists, a
   backup started by the daemon shows the owner an unexplained passcode
   prompt.
2. **Trigger policy:** the evening window as built (default 07:00 to 22:00,
   on charge, at most two unanswered prompts a day), or trigger on unlock.
3. **Snapshots on crepevault:** ZFS snapshot through the TrueNAS API after a
   verified run, or a periodic snapshot task. Either way `snapshots.strategy`
   stays `"none"`.
4. **Dataset path and mount:** which dataset under crepevault's backups, and
   how dockyard mounts it (NFS or SMB), including which user owns the files.
5. **Network:** the VLANs the phones and dockyard are on, a firewall rule for
   TCP 62078, fixed addresses for both phones, and dockyard's CPU
   architecture.
6. **Where the pair records live** on dockyard.

## Proposed Phase 1 design (provisional)

- **Trigger when the owner is there, not at 3 a.m.** Two candidate triggers,
  both needing one passcode entry:
  - *On unlock:* start when the owner unlocks the phone and a backup is due
    (one reference project does this, five seconds after unlock). Still to
    test: whether lock and unlock events can be observed over WiFi
    (`com.apple.springboard.lockstate`).
  - *Evening window:* start once the phone is home, on charge and a backup is
    due, inside a window when the owner is awake. Attempt 8 shows the phone
    wakes and asks on the lock screen. Unanswered prompts must be rationed so
    the phone does not light up repeatedly.
- **Discovery:** mDNS browse for `_apple-mobdev2._tcp` with `authTag`
  matching, plus a configured address per phone as a fallback for when mDNS
  does not cross the VLAN.
- **Preconditions:** on external power or above a battery floor, backup due
  (counted from the last *verified* backup), inside an allowed time window.
- **Storage:** back up into a per-device working directory, verify (manifest
  present and non-empty, status finished, sidecar reported `finished`), then
  snapshot. A failed run never touches the last good snapshot. Storage is on
  crepevault's backups dataset; the exact path and mount method are to be
  confirmed.
- **Failure handling:** typed reasons from the transport (`device-locked`,
  `cancelled`, `failed`), backoff, and a cap on prompts per day so the phone
  does not nag.
- **Heads-up before every run:** a push notification to the phone a few
  seconds before the backup starts, naming nightstand and saying a passcode
  prompt is coming, because the prompt itself says nothing. The channel is to
  be decided (for example ntfy or Pushover; email is too slow for a 60-second
  window).
- **Alerting:** email on repeated failure and on stale backups; a
  "waiting for passcode" state surfaced to the UI.
- **State:** SQLite, one row per run with the event log.

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
5. ~~Locked vs unlocked.~~ Done (attempt 8). Still to do: on battery, screen
   off 30+ minutes, and whether lock/unlock events are observable over WiFi.
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
