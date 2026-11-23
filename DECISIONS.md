# Design decisions

What has been decided, why, and what is still open. Evidence for the claims
here is in [FINDINGS.md](FINDINGS.md). Each decision also has its own commit.

Three kinds of entry:

- **Decided, on evidence**: follows from something measured on the phone.
- **Decided, by judgement**: a reasonable default I chose on the owner's
  behalf. These are the ones most worth challenging.
- **Open**: needs the owner's input, or a test that has not been run.

## Decided

### D1. pymobiledevice3 is the device-protocol implementation

*On evidence.* It completed a full backup and three incrementals on iOS
26.6.1, its maintainer tests on iOS 26.6, and it already handles the iOS 26.4
discovery change.

Rejected:

- **libimobiledevice**: no network path on Linux without a separate daemon
  (netmuxd), and open iOS 26 backup issues.
- **Rust `idevice` crate**: viable, but more work now for no gain yet. It is
  the fallback if the Python dependency becomes a problem.
- **Native TypeScript**: nobody has a usable TypeScript mobilebackup2; it
  would be 2,500 to 4,000 lines tracking Apple's changes alone.

Cost accepted: one maintainer's GPL-3.0 project sits at the centre.

### D2. Connect straight to the phone's lockdown port, not through a tunnel or a mux daemon

*On evidence.* TCP 62078 with a pair record carried whole backups over WiFi
from an unprivileged Alpine container.

Rejected:

- **RemotePairing tunnel**: needs root or a userspace network stack, and is
  not needed on the LAN. It stays a candidate for the tailnet only.
- **usbmuxd or netmuxd in the container**: an extra daemon. The Mac's own
  usbmuxd dropped the phone's network entry within minutes while direct
  connections kept working.

Consequence: the container needs outbound TCP to each phone and nothing
else. No USB, no host networking, no privileges.

### D3. TypeScript daemon, Python sidecar, JSON between them

*Agreed with the owner.* TypeScript owns orchestration, state and (later) the
UI. Python owns the device protocol because that is where the working
implementation lives.

- The sidecar is spawned per operation (`probe`, `backup`, `verify`) and
  prints JSON; a backup streams one JSON event per line.
- pymobiledevice3 is used as a library, not through its CLI, because the CLI
  prints no progress unless it is on a terminal. The one reference project
  on pymobiledevice3 scrapes terminal output instead.

Rejected: a long-lived sidecar with a request protocol. Per-operation
processes are simpler and a crash cannot leave shared state behind. Revisit
if start-up cost matters.

### D4. One interface, `DeviceTransport`, is the seam

*By judgement.* Everything above it (policy, runner, daemon) is written
against the interface and tested with a fake. Where a device lives is data
(`usbmux` or `tcp` endpoint), not a different code path. Failures are typed
(`device-locked`, `unreachable`, `not-paired`) so policy can react to cause.

This is what would let the sidecar be swapped for the Rust crate or a native
implementation without touching the daemon.

### D5. Pair once on a Mac, then export the pair record

*On evidence.* A record exported from the Mac authenticated from the
container. The container never pairs and never needs a cable.

Consequence: the pair record is a long-lived, full-access secret that must be
stored on the server. See O6.

### D6. Find phones by configured address, by polling

*By judgement, for now.* Each phone has an address in the config and the
daemon probes it only when a backup is otherwise due.

Why not mDNS yet: the phone's `.local` name failed to resolve once in
testing, mDNS will not cross VLANs without help, and iOS 26.4 made matching
adverts to devices harder. Polling a known address has none of those
problems. See O7.

### D7. Backups happen when the owner is there, never at night

*On evidence.* Every backup shows a passcode prompt that must be answered
within 60 seconds; a locked phone wakes to show it; there is no bypass.

So the trigger is not a clock time. A backup starts when it is due, the phone
answers, it is on a charger, and the time is inside a configured window.

*By judgement:* the defaults. Window 07:00 to 22:00, due after 20 hours,
charger required. See O2 for the alternative trigger.

### D8. Ration prompts; an absent phone is not a failure

*By judgement.*

- At most two unanswered prompts in 24 hours, then stop asking until one ages
  out. Each one lit somebody's phone for a minute.
- After any failed run, leave the phone alone for 60 minutes.
- A phone that does not answer a probe is simply away. That is not recorded
  as an attempt and causes no back-off, so it is backed up as soon as it
  comes home.

### D9. No heads-up, no backup

*On evidence.* The prompt on a locked phone is a bare keypad with no
explanation. An unexplained passcode request should be distrusted, so the
service must explain itself first.

The runner sends a "backup starting" notification, waits a few seconds, then
starts. If that notification cannot be sent, the backup does not start.

Gap: no delivery channel exists yet, so today the heads-up reaches only the
service log. See O1.

### D10. Encrypted backups only

*By judgement, following the project goal.* The daemon will not start a
backup if the phone reports backup encryption off, and will not preserve a
backup whose manifest says it is unencrypted. It never changes the setting
itself.

### D11. Working copy, verify, then snapshot

*On evidence.* A run that failed at the passcode stage left a status file
saying "finished" next to an empty manifest, so the status file cannot be
trusted alone.

- Each phone backs up into a working directory that every run rewrites.
- After a run, the backup is verified structurally: status, both manifests
  and the info file must be present and well-formed, and it must belong to
  the expected phone.
- Only then is it preserved. A failed or unverified run never touches
  earlier snapshots.
- How it is preserved is a pluggable strategy: `copy` or `none`.

Limit: verification is structural. It does not prove the backup decrypts or
restores. See O9.

### D12. Run history in SQLite, using Node's built-in module

*By judgement.* One file holds every attempt, its events and alert
timestamps. `node:sqlite` avoids a native dependency in the image.

- Progress events are thinned to ten-percent steps.
- Runs left "running" by a stopped daemon are closed off at start-up so they
  cannot block new attempts.

Cost accepted: Node still labels the module as under active development.

### D13. One phone at a time

*By judgement.* Devices are considered in sequence, so two phones never
compete for the disk or the uplink, and one phone's fault cannot stop the
next being considered.

### D14. Strict JSON config; secrets by path

*By judgement.* One JSON file. Unknown keys are errors, because a misspelt
setting that silently falls back to a default is a trap. Pair records are
referenced by path and never inlined. Per-device policy overrides a shared
default.

### D15. Unprivileged, read-only container

*On evidence.* The image ran `probe` as uid 1000 with a read-only root
filesystem and all capabilities dropped. pymobiledevice3 is pinned, so
protocol behaviour only changes deliberately.

### D16. No runtime npm dependencies

*By judgement.* The daemon uses only Node built-ins (SQLite, argument
parsing, child processes). The only dependencies are development tools.
Fewer moving parts in something that holds device credentials.

### D17. Tests use fakes at two boundaries

*By judgement.* A fake sidecar process stands in below the transport, and a
fake transport stands in below the runner and daemon. No test touches a
phone. What the fakes cannot show is listed in FINDINGS.md under what has
and has not been tried on the real device.

## Open

### O1. Notification channel

Needed for the heads-up (D9) and for failure and stale alerts.

- **Push service** such as ntfy (self-hostable) or Pushover: fast enough for
  a 60-second window. Recommended for the heads-up.
- **Email**: fine for alerts, too slow for the heads-up.

Recommendation: ntfy on dockyard for both, email for alerts later. Blocking
for deployment, especially for the second phone.

### O2. Trigger: evening window or on unlock

- **Window (built):** start when due, home and charging inside set hours.
  Simple; may prompt at an inconvenient moment.
- **On unlock:** start just after the owner unlocks the phone, so the prompt
  lands in their hand. One reference project does this.

Needs a test first: can lock and unlock events be observed over WiFi?
Recommendation: keep the window, add unlock as a refinement if the test
passes.

### O3. How good backups are preserved on crepevault

The `copy` strategy is a full copy: 22 GB and about 90 seconds each when
measured locally. Not suitable for a ZFS dataset.

- **ZFS snapshot via the TrueNAS API** after each verified run: exact, needs
  an API key on dockyard.
- **Periodic ZFS snapshot task:** no credentials, but can capture a backup
  mid-run.

Recommendation: the API call, as a third strategy behind the same interface.

### O4. Dataset path, mount and ownership

Which dataset under crepevault's backups, whether dockyard mounts it by NFS
or SMB, and which user owns the files (the container runs as uid 1000). The
SQLite state must stay on dockyard's local disk either way.

### O5. Network

The VLANs for the phones and for dockyard, a firewall rule allowing dockyard
to reach the phones on TCP 62078, fixed addresses for both phones, and
dockyard's CPU architecture (the image has only been built for arm64).

### O6. Where pair records live on dockyard

A plain read-only bind mount works. Whether that is acceptable for a
credential with full access to both phones, or whether it should come from a
secret store, is the owner's call.

### O7. Discovery beyond a fixed address

Fixed addresses work on the LAN. mDNS with `authTag` matching would remove
the need for DHCP reservations but adds the VLAN problem. Decide after O5.

### O8. Remote backups over the tailnet (Phase 2)

Untested. Port 62078 is reported to refuse connections from outside the
phone's subnet, which would rule out the direct path used on the LAN and
bring the RemotePairing tunnel back in.

### O9. Proving a backup restores (Phase 4)

Decrypting needs the backup password. Either the service is given it (a
second secret to protect), or decryption checks are run by hand. Not started.

### O10. How the first full backup is taken

A first backup is about 22 GB. Over USB to the Mac it took 13 minutes; over
WiFi it has not been timed. Options: seed the server from a USB backup taken
on a Mac, or let the first WiFi run take as long as it takes.

### O11. Pair record lifetime

One report says pair records can expire after days without contact. Not
verified. If true, the service needs a re-pairing procedure and an alert.

### O12. Persistent misconfiguration is silent

A rejected pair record or a failing probe is logged once and then waited on.
Nothing alerts until the backup goes stale (72 hours by default). Should
probably alert sooner.

### O13. Licence

pymobiledevice3 is GPL-3.0. Running it as a separate process keeps this
repo's code separate, but that should be checked before publishing the image
or the source.

### O14. Onboarding the second phone

Not started. It needs pairing on a Mac, backup encryption with a password
its owner knows, and O1 in place so its prompts are explained.
