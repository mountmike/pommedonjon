# Design decisions

What has been decided, why, and what is still open. Evidence for the claims
here is in [FINDINGS.md](FINDINGS.md). Each decision also has its own commit.

Three kinds of entry:

- **Decided, on evidence**: follows from something measured on the phone.
- **Decided, by the owner** or **by judgement**: a choice. Judgement calls
  are mine, made on the owner's behalf, and are the ones most worth
  challenging.
- **Open**: needs the owner's input, or a test that has not been run.

Numbers are stable because commit messages cite them. A decision that has
been replaced stays in place, marked with what replaced it.

Revised 2026-11-24 after the owner's first review. Entries changed by that
review say so. Where the code has not caught up, the entry ends with
**To build**.

## Scope

*Decided by the owner, 2026-11-24.*

nightstand is an application that someone runs in their own homelab. It is
published as a container image with an example Compose file; the person
running it mounts directories for backups, state and secrets, the same way
they would for any other stack.

nightstand is responsible for:

- finding the phones it is configured for and deciding when to back them up;
- running the backup, verifying it, and recording what happened;
- keeping one verified, restorable backup per phone in the directory it is
  given;
- handling pair records as the secrets they are.

The person running it is responsible for, and nightstand takes as given:

- **Where backups live.** A directory path in the config. Which disk,
  dataset, share or mount is behind it is not nightstand's concern.
- **Keeping history.** Snapshots or copies of the backup directory (ZFS or
  anything else) are theirs to arrange.
- **The network.** Routing, VLANs and firewall rules that let the container
  reach each phone.

Help with setting those up on the owner's own homelab is welcome when the
time comes; it is not part of the design or the build plan.

### Phases

1. **First build:** discovery, the charger trigger, phones in parallel,
   runtime-validated data, pair-record handling, published image and Compose
   example.
2. **Notifications:** its own phase, not designed yet (O1).
3. **Later, once the first build is done:** O8 to O15.

## Decided

### D1. pymobiledevice3 is the device-protocol implementation

*On evidence.* It completed a full backup and several incrementals on iOS
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
- **usbmuxd or netmuxd in the container**: an extra daemon. Overnight, the
  Mac's own usbmuxd did not list the phone's network entry for two hours
  while direct connections succeeded on every check (82 of 82).

Consequence: the container needs outbound TCP to each phone and nothing
else. No USB, no host networking, no privileges.

Not yet known: whether the phone accepts this connection from a different
subnet. See O5.

### D3. TypeScript daemon, Python sidecar, JSON between them

*Agreed with the owner.* TypeScript owns orchestration, state and (later) the
UI. Python owns the device protocol because that is where the working
implementation lives.

- The sidecar is spawned per operation (`probe`, `backup`, `verify`) and
  prints JSON; a backup streams one JSON event per line.
- pymobiledevice3 is used as a library, not through its CLI, because the CLI
  prints no progress unless it is on a terminal.

Rejected: a long-lived sidecar with a request protocol. Per-operation
processes are simpler, a crash cannot leave shared state behind, and they
make backing up phones in parallel (D13) a matter of running two processes.

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
stored on the server. See D19.

### D6. Find phones by discovery; a configured address is the fallback

*Decided by the owner, 2026-11-24: discovery is in scope for the first
build.* This replaces "configured address only".

What exists today: each phone has a `host` in the config, which is an IP
address or a DNS name. Nothing else identifies where the phone is.

How stable that is:

- A phone's IP address comes from DHCP and can change at any lease renewal
  unless the router reserves it.
- A reservation is keyed on the phone's MAC address, and an iPhone uses a
  private MAC address per network. With the phone's setting on "Fixed" that
  address stays the same for that network; on "Rotating" it changes
  periodically and the reservation stops matching.
- So a fixed address is only as stable as two settings the owner has to get
  right, on the router and on the phone.

What happens today when the address is wrong: the probe fails and the phone
is treated as away, indefinitely. It can never back up the wrong phone,
because the connection is authenticated with that phone's pair record and
the UDID it reports is checked (D4).

The design to build, in order of preference at run time:

1. A `host` in the config, if the owner set one. Always wins.
2. The address the phone was last reached at.
3. Discovery, when neither answers.

Whatever finds a candidate address, the pair record decides whether it is
the right phone. Discovery only has to produce candidates.

Which discovery mechanism is not decided. See O7. **To build.**

### D7. Back up when the phone is on a charger and the last good backup is over 24 hours old

*Decided by the owner, 2026-11-24.* This replaces the time window
(07:00 to 22:00, due after 20 hours).

- The trigger is the phone being on external power with no verified backup
  in the previous 24 hours.
- No time-of-day window by default. It stays available as an option.
- Charger-only also sidesteps what was seen on battery: slow connections and
  a session dropped mid-prompt (FINDINGS.md, attempts 10 to 12).

Still fixed by evidence: every backup shows a passcode prompt that must be
answered within 60 seconds, and there is no bypass. So the owner must be
near the phone when it starts.

Two details that need the owner's call. See O16. **To build.**

### D8. Keep asking after a timeout; treat a cancel differently

*Decided by the owner, 2026-11-24.* This replaces "at most two unanswered
prompts in 24 hours".

- A prompt that timed out can be retried. The limit of two a day goes.
- A prompt the owner cancelled means "not now" and should stop the asking
  for longer.
- A phone that does not answer a probe is away. That is not an attempt and
  causes no back-off. (Unchanged.)

Whether the two can be told apart is not known yet. A timeout is
recognisable: the prompt closes at 60 seconds and the phone reports error
208. A cancel has not been observed. See O17. **To build.**

### D9. Heads-up before a backup: deferred with notifications

*Revised 2026-11-24.* The original rule was "no heads-up, no backup",
because a locked phone showed a bare keypad with no explanation.

The evidence is now mixed. The owner has since seen a prompt with a message
on an unlocked phone, and a keypad with a message on a locked one (attempt
12). The bare keypad was seen once (attempt 8).

- Notifications are their own later phase (O1), so the first build starts
  backups without a heads-up reaching the phone.
- The runner keeps its notification hook, which writes to the service log.
- The owner's rule for what comes next: if it turns out a locked phone
  never shows a message, nightstand only ever prompts on unlock (O2).
  Every test from here on records what the prompt showed.

### D10. Encrypted backups only

*By judgement, following the project goal.* The daemon will not start a
backup if the phone reports backup encryption off, and will not keep a
backup whose manifest says it is unencrypted. It never changes the setting
itself.

### D11. One working copy per phone, verified after every run

*On evidence; narrowed by the owner, 2026-11-24.* A run that failed at the
passcode stage left a status file saying "finished" next to an empty
manifest, so the status file cannot be trusted alone.

- Each phone backs up into one directory that every run updates in place.
- After a run the backup is verified structurally: status, both manifests
  and the info file must be present and well-formed, and it must belong to
  the expected phone.
- A run only counts as a good backup if it verifies.

Removed from scope: preserving earlier versions. The built-in snapshot
strategies (`copy`, `none`) come out. Because backups update in place, a
failed run can leave the directory worse than it was, and protecting against
that is the job of whatever snapshots the person running it has arranged.

Consequence worth designing for: a snapshot taken on a timer can catch a
backup half-written. nightstand should make "the directory is in a verified
state" visible to outside tools, for example a small marker file written
after verification and removed when a run starts. **To build.**

Limit: verification is structural. It does not prove the backup decrypts or
restores. See O9.

### D12. Run history in SQLite, using Node's built-in module

*By judgement.* One file holds every attempt, its events and alert
timestamps. `node:sqlite` avoids a native dependency in the image.

- Progress events are thinned to ten-percent steps.
- Runs left "running" by a stopped daemon are closed off at start-up so they
  cannot block new attempts.

Cost accepted: Node still labels the module as under active development.

### D13. Phones back up in parallel

*Decided by the owner, 2026-11-24.* This replaces "one phone at a time".

- Each phone has its own independent cycle of deciding, probing and backing
  up. Two phones on chargers at the same moment both start.
- One phone's fault, slowness or unanswered prompt never delays another.
- Never two runs for the same phone at once.

Cost accepted: two backups share the disk and the WiFi. A limit on how many
run at once can be added as an option if that turns out to matter.
**To build.**

### D14. Zod schemas, parsed at run time, for all data crossing a boundary

*Decided by the owner, 2026-11-24.* This replaces the hand-written config
parser.

- One Zod schema per shape, with the TypeScript type derived from it, so the
  type and the check cannot drift apart.
- Parsed at every boundary: the config file, everything the sidecar prints
  (probe results, backup events, verification reports), rows read back from
  SQLite, and later HTTP requests.
- Unknown keys in the config stay errors, because a misspelt setting that
  silently falls back to a default is a trap.
- Pair records are referenced by path and never inlined.

**To build.**

### D15. Unprivileged, read-only container

*On evidence.* The image ran `probe` and a full `backup` as uid 1000 with a
read-only root filesystem and all capabilities dropped. pymobiledevice3 is
pinned, so protocol behaviour only changes deliberately.

### D16. Few runtime dependencies, each one chosen

*Revised 2026-11-24.* It was "no runtime npm dependencies". Zod (D14) is the
first. The principle that remains: this service holds credentials for
people's phones, so each runtime dependency is added deliberately and the
list stays short.

### D17. Tests use fakes at two boundaries

*By judgement.* A fake sidecar process stands in below the transport, and a
fake transport stands in below the runner and daemon. No test touches a
phone. What the fakes cannot show is listed in FINDINGS.md under what has
and has not been tried on the real device.

### D18. Distributed as a published image and a Compose example

*Decided by the owner, 2026-11-24.*

- A published container image, and a Compose file in this repo that someone
  can copy into their own stack.
- Everything site-specific is an input: the config file, a backups
  directory, a state directory, and the pair records.
- The SQLite state must be on a local disk, not a network share.

Not decided: which registry, and which CPU architectures to publish (only
arm64 has been built). **To build.**

### D19. Pair records are handled as secrets

*Decided by the owner, 2026-11-24: store them to best practice.* What that
means here, by judgement:

- Delivered as file-backed Compose secrets, mounted read-only, separate from
  the config and from the backups directory.
- Never in the image, the config file, environment variables, logs, run
  history, or the build context.
- Readable only by the user the container runs as; nightstand checks the
  file's permissions at start-up and says so if they are loose.
- The Compose example and README show the layout and the host-side
  permissions.

Already true: the config references pair records by path, the build context
excludes them, and the container reads them from a read-only mount.
**To build:** the Compose secrets layout and the permission check.

## Open

### O1. Notification channel

*Deferred by the owner, 2026-11-24, to its own phase.* Not designed. It
covers the heads-up before a backup and alerts for failures and stale
backups.

One idea from the owner to carry into that phase: the phone itself tells the
server it is ready, from a small iOS app or a Shortcut, either on a button
or on a nightly timer that shows its own "backup about to start"
notification. That would make the phone the trigger and the heads-up at
once.

### O2. Prompt on unlock

*Rule set by the owner, 2026-11-24:* if a locked phone turns out never to
show a message with its passcode prompt, nightstand only ever prompts just
after an unlock.

- Evidence so far does not meet that bar: a locked phone showed a bare
  keypad once and a keypad with a message once.
- Prompting on unlock also needs a test that has not been run: whether lock
  and unlock can be observed over WiFi.

### O3. Preserving earlier backups

*Closed by the owner, 2026-11-24: out of scope.* See Scope and D11.

### O4. Dataset path, mount and ownership

*Closed by the owner, 2026-11-24: out of scope.* The backups directory is a
configured path. See Scope and D18.

### O5. Network between the server and the phones

*Out of scope for the design, by the owner, 2026-11-24.* Help with the
owner's own setup comes at deployment time.

One part of it is a risk to the product and should be tested early, because
it could change what the Compose example has to look like:

- The owner's server is on a different VLAN from the phones. That needs a
  firewall rule allowing the server to reach each phone on TCP 62078.
- Port 62078 is *reported* to refuse connections that come from outside the
  phone's own subnet. That has not been tested here: every test so far came
  from the phone's subnet.
- If the report is true, a firewall rule alone will not be enough. The
  container would need an address on the phones' network, or the router
  would have to rewrite the source address.

### O6. Where pair records live

*Closed by the owner, 2026-11-24.* See D19.

### O7. Which discovery mechanism

*In scope for the first build, by the owner, 2026-11-24.* See D6 for the
shape. The candidates:

- **mDNS.** The phone advertises itself, and pymobiledevice3 can match an
  advert to a pair record. It does not cross VLANs without the router
  relaying it, and a container on Docker's default network does not receive
  it at all, which conflicts with D15.
- **Scan a configured network range** for the lockdown port, then let the
  pair record pick the right phone. Works across VLANs and from an ordinary
  container. Costs a setting (the range) and some connection attempts.
- **The phone announces itself** (the app or Shortcut idea in O1). Exact and
  cheap, but belongs to the notifications phase.

Recommendation: scan first, because it works in the owner's own network
layout and keeps the container unprivileged. Add mDNS as an option for
setups where server and phones share a network.

Also seen: the phone's mDNS name failed to resolve twice, and the
RemotePairing identifier it advertises rotates about hourly.

### O8. Remote backups over the tailnet

*Later.* Untested. See also O5: the same subnet question decides whether the
direct path can work at all.

### O9. Proving a backup restores

*Later.* Decrypting needs the backup password. Either the service is given
it (a second secret to protect), or decryption checks are run by hand.

### O10. How the first full backup is taken

*Later.* A first backup is about 22 GB. Over USB to the Mac it took 13
minutes; over WiFi it has not been timed. Seeding the server's directory
from a USB backup works (attempt 9 ran on a seeded copy).

### O11. Pair record lifetime

*Later.* One report says pair records can expire after days without contact.
Not verified. If true, the service needs a re-pairing procedure and an
alert.

### O12. Persistent misconfiguration is silent

*Later.* A rejected pair record or a failing probe is logged once and then
waited on. Nothing alerts until the backup goes stale.

### O13. Licence

*Later.* pymobiledevice3 is GPL-3.0. Running it as a separate process keeps
this repo's code separate, but that should be checked before the image is
published (D18).

### O14. Onboarding the second phone

*Later.* It needs pairing on a Mac and backup encryption with a password its
owner knows.

### O15. Connections that fail or drop

*Partly settled on evidence, 2026-11-24; the rest later.*

- Settled: one failed connection does not mean the phone is away. The
  sidecar now keeps dialling for 12 seconds. On battery the phone took up
  to 6.7 seconds to accept a connection.
- Open: a backup whose connection drops after the prompt has appeared
  (attempt 12: passcode typed, session lost anyway). It is recorded as
  `unreachable` although the owner was prompted. How soon to retry, and
  whether that counts as an unanswered prompt, is not decided.
- Open: the later connections a backup opens still have a one-second limit.

### O16. Details of the charger trigger

Two points D7 leaves open.

**Plugged in, or on a charger?**

- *On a charger* (a state): start whenever the phone is on power and a
  backup is due. A phone left charging overnight becomes due at 24 hours
  exactly, which can be while its owner is asleep.
- *Plugged in* (an event): start only in the minutes after the phone goes
  onto power. The prompt arrives while the owner is still holding the phone.

Recommendation: the event.

**Exactly 24 hours?**

With a 24-hour rule and a daily habit, plugging in ten minutes earlier than
yesterday means no backup that day. Recommendation: treat a backup as due
after about 20 hours, so a once-a-day plug-in always qualifies.

Together with D8 this matters at night: retrying after every timeout, on a
phone that sits on a charger until morning, would light it up repeatedly.
The event trigger avoids that; so would an optional quiet period.

### O17. Telling a cancel from a timeout

Needed for D8. Not yet observed: the one test aimed at it ended with the
passcode typed and the connection lost.

- A timeout: prompt closes at 60 seconds, phone reports error 208.
- A cancel: unknown. Possible tells are a different error, or the same error
  arriving well before 60 seconds.

Needs one run where the owner taps Cancel.
