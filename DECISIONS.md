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
review say so, and all of them are now built. Each entry ends with a
**Built** note where how it was built involved further choices.

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
2. **Field trial:** run it on the owner's phone for a week or two and watch
   how the schedule and the process behave in ordinary use. Added by the
   owner, 2026-11-24. See O16 for what it has to settle.
3. **Notifications:** its own phase, not designed yet (O1).
4. **Later:** O8 to O15.

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

Discovery is by scanning a configured network range (O7).

**Built.** Choices made while building it, by judgement:

- Sweeps are rationed to one per five minutes (`scanIntervalSeconds`). A
  phone that is away is the normal case; without a limit every poll would
  knock on every address.
- One sweep serves every phone being looked for, and each phone is given a
  sweep's result once, so other people's devices are not re-tested on every
  poll.
- Each address gets two knocks, 2 and then 6 seconds: on battery the phone
  has ignored a first connection and taken 6.7 seconds to accept one.
- Ranges are capped at /22, about a thousand addresses.
- With discovery, a refused pair record is not reported as "not paired":
  every other Apple device in the house refuses it too. It is only reported
  for a pinned `host`. This makes O12 slightly worse.
- Tried on the real network from the container: found the phone on the
  second sweep, not the first, with the phone on battery. The first contact
  seems to wake it.

### D7. Back up when the phone is on a charger and a backup is due

*Decided by the owner, 2026-11-24.* This replaces the time window
(07:00 to 22:00).

- The trigger is the phone being on external power with no verified backup
  in roughly the previous day.
- "Due" means 20 hours since the last good backup, not 24. With exactly 24,
  plugging in ten minutes earlier than yesterday would skip a day.
- No time-of-day window by default. It stays available as an option.
- Charger-only also sidesteps what was seen on battery: slow connections and
  a session dropped mid-prompt (FINDINGS.md, attempts 10 to 12).

Still fixed by evidence: every backup shows a passcode prompt that must be
answered within 60 seconds, and there is no bypass. So the owner must be
near the phone when it starts.

Whether "on a charger" means the moment of plugging in or the whole time on
power is left to the field trial. See O16.

**Built**, with both behaviours as the `trigger` setting. The default is
`"plugged-in"` with a 30-minute window, by judgement. Further choices:

- A probe only says "on power" at one moment, so a plug-in is inferred from
  successive probes. The phone starts being probed 30 minutes before a
  backup is due so there is history to judge from.
- A phone already on power when first seen, as after a restart of the
  service, does not count as plugged in: nobody knows how long it has been
  there. It waits for its next plug-in.
- A missed probe never creates a plug-in. Not answering for 15 minutes and
  then appearing on power does: the phone came home onto a charger.
- Backing up on battery is no longer possible at all, even as an option.

### D8. Keep asking after a timeout; treat a cancel differently

*Decided by the owner, 2026-11-24.* This replaces "at most two unanswered
prompts in 24 hours".

- A prompt that timed out can be retried. The limit of two a day goes.
- A prompt the owner cancelled means "not now" and should stop the asking
  for longer.
- A phone that does not answer a probe is away. That is not an attempt and
  causes no back-off. (Unchanged.)

The phone itself does not tell the two apart; timing does. See O17.

**Built.** After a timeout the phone is asked again in 10 minutes; after any
other failure, also 10 minutes, set separately. With the plugged-in trigger
the 30-minute window limits that to about four prompts per plug-in. With
on-charger nothing limits it.

A cancel can be told apart (O17) and buys a pause of four hours
(`retryAfterCancelMinutes`). Four hours is my judgement: long enough not to
nag the same evening, short enough that a cancel at breakfast does not cost
the evening's backup.

### D9. Heads-up before a backup: deferred with notifications

*Revised 2026-11-24.* The original rule was "no heads-up, no backup",
because a locked phone showed a bare keypad with no explanation.

The evidence is now mixed. The owner has since seen a prompt with a message
on an unlocked phone, and a keypad with a message on a locked one (attempt
12). The bare keypad was seen once (attempt 8).

- Notifications are their own later phase (O1), so the first build starts
  backups without a heads-up reaching the phone.
- The runner keeps its notification hook, which writes to the service log.
- Prompting a locked phone is acceptable to the owner, now that a locked
  prompt has been seen with a message (O2).

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
after verification and removed when a run starts.

**Built** as `<backupRoot>/<device id>/verified.json`, holding the UDID and
the time of verification. Choices, by judgement:

- It is withdrawn just before the transport starts, so a run that stops
  earlier leaves the claim alone. A run that then fails to connect has
  withdrawn it without changing anything; that errs on the safe side.
- If the marker cannot be written after a good backup, the run still counts
  and an error is logged.
- The layout lost its `working/` level: the backup is at
  `<backupRoot>/<device id>/<udid>/`.

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

**Built** as one independent cycle per phone. Besides starting together, it
means a phone is still watched while another's backup runs, so its plug-in
is not missed.

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

**Built.** Two behaviours tightened as a result, both failing closed: a
probe reply that does not say whether backups are encrypted is refused, and
a verification report in an unexpected shape counts as not having run. Config
errors are now all reported at once.

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
arm64 has been built).

**Built** as far as the Compose example, the example config and an image
that builds locally. Publishing waits on the registry choice and O13.

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
**Built.** Compose mounts a file-backed secret exactly as it is on the host,
so the host file's owner and mode are what protect it; the example says so.
At start-up nightstand logs an error for a pair record that is missing or
unreadable and a warning for one that anyone but its owner can read, and
carries on, so one phone's mistake does not stop another's backups.

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

*Closed by the owner, 2026-11-24.* The owner's rule was: if a locked phone
never shows a message with its passcode prompt, only ever prompt just after
an unlock. A locked phone has since shown a keypad with a message, so
prompting while locked is acceptable and unlock-triggering is not needed.

Kept as a note: a locked phone showed a bare keypad once (attempt 8) and a
keypad with a message once (attempt 12). What decides which is not known.

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
- Related evidence, 2026-11-24: over Tailscale the phone accepts the
  connection and then drops the session (O8). That is a different interface
  on the phone, not a different subnet on WiFi, so it does not settle this,
  but it shows the phone does discriminate by where a connection comes from.

### O6. Where pair records live

*Closed by the owner, 2026-11-24.* See D19.

### O7. Which discovery mechanism

*Decided by the owner, 2026-11-24: scan a configured range, for now.* To be
revisited after more testing and when remote backups are taken up.

How it works:

- The config gives the network range the phones live on.
- nightstand first tries the address where it last reached the phone.
- If that does not answer, it tries the lockdown port on every address in
  the range.
- For each device that answers, the pair record decides whether it is the
  right phone. That is the stable identity; the address is only where the
  phone was found.
- The address is remembered. A phone that is not found is away.

Why this one: it survives an address change, works across VLANs, and keeps
the container unprivileged. Its costs: the firewall rule has to cover the
whole range, and a router's intrusion detection may flag the sweeps.

Considered:

- **mDNS.** Does not cross VLANs without the router relaying it, and a
  container on Docker's default network does not receive it at all (D15).
  The phone's mDNS name also failed to resolve twice, and the RemotePairing
  identifier it advertises rotates about hourly. A possible later option for
  setups where server and phones share a network.
- **A DNS name kept current by the router.** Needs no code, since `host`
  already accepts a name. Whether a given router does this for iPhones is
  for the person running it to check.
- **The phone's Tailscale address.** Never changes, but ruled out on
  evidence: tested 2026-11-24 from the Mac, the lockdown port accepts a
  connection on the Tailscale address and the phone then drops the session,
  while the same probe to the WiFi address succeeds.
- **The phone announces itself**, from an app or a Shortcut. Exact and
  cheap, and the owner is interested. It belongs with the notifications
  phase (O1).

### O8. Remote backups over the tailnet

*Later.* First evidence, 2026-11-24: the direct path does not work over the
tailnet. The phone accepts a connection to port 62078 on its Tailscale
address and then drops the lockdown session. Remote backups would need the
RemotePairing tunnel or a relay on the home network.

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

### O16. Plugged in, or on a charger? To be settled by the field trial

*The owner's call, 2026-11-24: test it for a week or two and watch.*

- *On a charger* (a state): start whenever the phone is on power and a
  backup is due. A phone left charging overnight can become due while its
  owner is asleep, and with retries after every timeout (D8) it would light
  up repeatedly until morning.
- *Plugged in* (an event): start only in the minutes after the phone goes
  onto power, while the owner is still holding it.

My recommendation is the event, but this is a question about habits, not
about the protocol, so it gets measured. What the trial has to record for
each day: when the phone went onto and off power, when a backup became due,
when each prompt was shown and whether it was answered, timed out or
cancelled, and how long the backup took. What it has to answer:

- How often does a prompt arrive when nobody is there to answer it?
- Does a backup happen every day the phone is charged at home?
- How many prompts does a normal day produce?

Settled already: due after 20 hours, not 24 (D7).

### O17. Telling a cancel from a timeout

*Settled on evidence, 2026-11-24.* The owner tapped Cancel on the prompt
(attempt 13). The phone reported the same "Device locked" error 208 that it
reports after a timeout, so the device does not distinguish them. The time
the prompt stayed open does:

- left alone: 58 to 61 seconds (attempts 1, 3 and 4);
- cancelled: 2.6 seconds.

The transport reports a prompt that closed in under 45 seconds, followed by
that error, as cancelled.

Limits: one observation, on an unlocked phone. Not seen yet: a prompt
cancelled from the lock screen, or a wrong passcode, which may look the same.
