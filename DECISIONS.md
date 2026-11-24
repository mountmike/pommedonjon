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

pommedonjon is an application that someone runs in their own homelab. It is
published as a container image with an example Compose file; the person
running it mounts directories for backups, state and secrets, the same way
they would for any other stack.

pommedonjon is responsible for:

- finding the phones it is configured for and deciding when to back them up;
- running the backup, verifying it, and recording what happened;
- keeping one verified, restorable backup per phone in the directory it is
  given;
- handling pair records as the secrets they are.

The person running it is responsible for, and pommedonjon takes as given:

- **Where backups live.** A directory path in the config. Which disk,
  dataset, share or mount is behind it is not pommedonjon's concern.
- **Keeping history.** Snapshots or copies of the backup directory (ZFS or
  anything else) are theirs to arrange.
- **The network.** Routing, VLANs and firewall rules that let the container
  reach each phone.

Help with setting those up on the owner's own homelab is welcome when the
time comes; it is not part of the design or the build plan.

### Phases

1. **First build:** discovery, the charger trigger, phones in parallel,
   runtime-validated data, pair-record handling, published image and Compose
   example. Done; released as 0.1.0.
2. **Field trial:** run it on the owner's phone for a week or two and watch
   how the schedule and the process behave in ordinary use. Added by the
   owner, 2026-11-24. Started that evening on the test stack, with the first
   backup the daemon began by itself. See O16 for what it has to settle.
3. **The app and its service interface:** the next phase, by the owner,
   2026-11-24. One front end for the web and the iPhone (D23) over a JSON
   API, in a workspace monorepo (D24). It takes over what notifications
   were mostly for, with a status screen that shows when a phone has gone
   too long without a good backup, and it replaces both the config file
   (O24) and the Shortcuts of the proof of concept (O22). Planned as steps,
   each usable by itself; none is started:

   1. Restructure the repository into workspaces, with no change in
      behaviour.
   2. A design brief: theme, component kit and the screens (O23).
   3. The API contract and a status screen, in the web app the container
      serves.
   4. The same app on the iPhone, and "back up now" in it.
   5. A schedule for each phone, set in the app (O26).
   6. Settings in the database; the config file goes (O24).
   7. Adding a phone from the app (O25).
   8. Sign-in (O27).
4. **Later:** push or email notifications (O1); O8 to O15.

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
(an address and a pair record), not a different code path. Failures are
typed (`device-locked`, `unreachable`, `not-paired`) so policy can react to
cause.

The interface is two calls: ask a phone about itself, and back it up. It
began with a second way to reach a phone, through a USB daemon on the host,
used during the first night's experiments on the Mac. Nothing the service
does went that way, so it was removed on 2026-11-24. Pairing a new phone
still needs USB once, and uses pymobiledevice3's own command for it (D5).

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

What existed before: each phone had a `host` in the config, an IP address
or a DNS name, and nothing else said where the phone was.

How stable that is:

- A phone's IP address comes from DHCP and can change at any lease renewal
  unless the router reserves it.
- A reservation is keyed on the phone's MAC address, and an iPhone uses a
  private MAC address per network. With the phone's setting on "Fixed" that
  address stays the same for that network; on "Rotating" it changes
  periodically and the reservation stops matching.
- So a fixed address is only as stable as two settings the owner has to get
  right, on the router and on the phone.

What happened then when the address was wrong: the probe fails and the phone
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

### D9. No heads-up before a backup

*Settled by the owner, 2026-11-24, in two steps.*

The original rule was "no heads-up, no backup", because a locked phone
showed a bare keypad with no explanation (attempt 8). It was first deferred
along with notifications, and then dropped:

- The prompt has since been seen with a message, on an unlocked phone and
  on a locked one (attempt 12). Prompting a locked phone is acceptable to
  the owner (O2).
- A backup now starts when its owner plugs the phone in or taps a button
  (D7, O22), so the prompt arrives while they are holding the phone. The
  prompt is the notice (O1).

**Built.** There is no heads-up and no pause: a backup starts as soon as it
is decided. The notification hook, the `headsUpLeadSeconds` setting and the
record of sent alerts were removed on 2026-11-24, with the owner's
agreement, as left over. What notifications were still for is in O1; the
one warning that matters, a phone gone too long without a good backup, is
written to the log once a day until there is a status page to show it.

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
backup half-written. pommedonjon should make "the directory is in a verified
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

**Built.** The image is published to GitHub's registry as
`ghcr.io/mountmike/pommedonjon`, for amd64 only so far. There is one Compose
file, `deploy/compose.yaml`: the same one the owner's stacks run is the one
to copy. An earlier second example, with host folders and file-backed
Compose secrets, was removed on 2026-11-24 so that there is one way to run
it, the one that is actually run.

### D19. Pair records are handled as secrets

*Decided by the owner, 2026-11-24: store them to best practice.* What that
means here, by judgement:

- Kept in a volume of their own, mounted read-only at `/run/secrets`,
  separate from the config and from the backups directory. (First built as
  file-backed Compose secrets; changed to a volume with D20, so nothing has
  to be laid out on the host.)
- Never in the image, the config file, environment variables, logs, run
  history, or the build context.
- Readable only by the user the container runs as; pommedonjon checks the
  file's permissions at start-up and says so if they are loose.
- The README shows how to put one in with the right owner and mode.

Already true: the config references pair records by path, the build context
excludes them, and the container reads them from a read-only mount.
**Built.** The file's owner and mode inside the volume are what protect it.
At start-up pommedonjon logs an error for a pair record that is missing or
unreadable and a warning for one that anyone but its owner can read, and
carries on, so one phone's mistake does not stop another's backups.

### D20. Three environments, fed by commits

*Decided by the owner, 2026-11-24:* development on the Mac, a test stack on
the server, possibly a production stack too; versions driven by commits;
Changesets for versioning. Also from the owner: tests live in `test/`, and
the project runs on Node 26.

How that is built, by judgement:

- **Every commit on `main` becomes an image** tagged `edge` and
  `sha-<commit>`.
- **A release is the merge of the "Version Packages" pull request** that
  Changesets maintains. The pipeline then tags `v<version>` and pushes the
  image as `<version>`, `<major>.<minor>` and `latest`. Production follows a
  version.
- **One workflow does all of it.** A tag pushed by a workflow's own token
  does not start another workflow, so a separate tag-triggered image build
  would never run. The release image is built in the same run that tags.
- **Tests run inside the Node image the product ships on**, not on the
  runner's own Node.
- **amd64 only** for now. Checked locally: the image builds for amd64 and
  both the app and the Python sidecar start in it.
- **The image carries its commit**, shown by `--version` and in the
  start-up log, since every build between two releases has the same version.

Since then, all of it has run: the repository is on GitHub (D22), commits
on `main` publish `edge`, and merging the "Version Packages" pull request
released 0.1.0.

*From the owner, 2026-11-24:* while the only thing running pommedonjon is
the test stack, work goes onto one branch, `dev`, with no pull requests.
`main` keeps its protection and moves when the owner asks.

**Test does not go through the pipeline at all.** The owner asked for the
quickest path from a development session to a test environment managed by
Komodo. So:

- The test stack follows a branch called `test` and **builds the image on
  the server** from that commit (`--build`). No CI run, no registry.
- `pnpm deploy:test` moves `test` to the current commit, asks Komodo over
  its API to deploy, waits, and prints the result. The branch
  is only a pointer to "what is on test now", so it is force-moved.
- Production still runs released images from the registry.
- Komodo has no notion of one stack with several environments. Both
  environments are the same compose file (`deploy/compose.yaml`) deployed
  as two stacks with different variables.
- **Nothing is prepared on the server.** The owner's other stacks keep
  their settings in named volumes and never in folders made by hand on the
  host, and asked for the same here. So the config and the pair records
  each live in a named volume that Docker creates on the first deploy; only
  the backups directory is a path on the host, because it is the NAS. A new
  volume is empty, so both have to be put in once. How that should happen
  without a copy command is open (O21).
- The stacks are defined from this repository, not from the owner's stacks
  repository, because the compose file has to travel with the code it
  builds. That is a departure from how the owner's other stacks are kept.

Verified against the owner's Komodo (2.2.0): a deploy from a development
session takes about 75 seconds. The deploy command once also fetched the
stack's log through the API; the key was never given that permission and
the log was being read on the server anyway, so that part was removed.

One constraint the environments must respect: **a phone may be watched by
only one daemon.** Two would each prompt it. So test and production cannot
both be given the same phone. See O18.

### D21. The name is pommedonjon

*Decided by the owner, 2026-11-24.* The project started as "nightstand".

"Pomme" is French for apple and a donjon is a castle's keep, the word
"dungeon" comes from: the apple's keep, in the language of crepes, to sit
in the owner's crepe-themed homelab beside crepecastle and crepevault. A
web search found no existing app or project by the name. Names passed over
because they were taken: iKeep (an accounting app), donjon, iDungeon (an
iOS app), cider.

Renamed with it, before anything was published: the package and command,
the image, the `POMMEDONJON_*` environment variables, the sidecar script,
the example config, and the default names `pommedonjon.json` and
`pommedonjon.sqlite`.

Not renamed: commit messages before this point, and the throwaway image
used by the reachability script from the first night's spike.

### D22. Public from the first day, under GPL-3.0

*Decided by the owner, 2026-11-24.* The repository is public at
`github.com/mountmike/pommedonjon` and the project is licensed GPL-3.0.

GPL-3.0 because the image ships pymobiledevice3, which is GPL-3.0, and the
project cannot work without it. Using the same licence makes publishing the
image straightforward. This is a practical choice, not legal advice.

Commits are published under the owner's GitHub no-reply address, not a
personal one. The history was rewritten once, before the first push, to make
that so; nothing else about the commits changed.

### D23. One front end, in React and TypeScript, for the web and the iPhone

*Decided by the owner, 2026-11-24:* React and TypeScript, one codebase for
the web app and the iPhone app, built with Expo (React Native, with its web
target). The owner wants a user interface that is both from the start, as
much front-end code shared as possible, and a real iPhone app.

The owner first chose Capacitor, a native shell around a web app, and
changed to Expo the same evening. What decided it: nothing about starting
a backup needs native code in either (O26), so the choice came down to
whether the phone app should feel like an iPhone app or like a website in
a wrapper.

What follows from that, by judgement, to be confirmed as each is built:

- **The container serves the web build beside the API.** Expo exports the
  web app as static files, so there is still one container and the web app
  needs no set-up.
- **The iPhone app has to be told where the server is**, on a first-run
  screen, and the API has to accept requests from it. The web app does
  not: it is served from the same address as the API.
- **Screens are built from React Native components**, so the component kit
  has to be one made for that (O23). Web-only kits are out.
- **Building the iPhone app needs Xcode**, and keeping it on a phone for
  more than a week needs the paid Apple Developer Program.
- The Shortcuts that call the service by address (O22) were a proof of
  concept. The app replaces them, with a button and a schedule (O26).

### D24. A workspace monorepo

*Decided by the owner, 2026-11-24:* pnpm workspaces, to keep the modules
apart and to share code between the web app and the iPhone app.

Proposed layout, by judgement:

| Workspace | Holds |
|---|---|
| `apps/server` | Today's daemon, the API, and the Python sidecar it drives |
| `apps/app` | The Expo app: the iPhone app and the web app |
| `packages/api-contract` | Zod schemas for every request and reply. The server validates with them and the app takes its types from them (D14) |
| `packages/api-client` | The typed client the app calls the server with |

One image is still published: the server with the web build inside it.

**Built, as far as there is anything to put in it** (2026-11-24): the
repository is a workspace with `apps/server` and, for the deploy command,
`tools/deploy`. Nothing about how the service behaves changed, and the
image has the same contents in the same places. The app and the two shared
packages are added when there is something to put in them, not as empty
folders. The product's version and changelog are the server's; when the
app arrives, the two will be versioned together.

### D25. No sign-in in the proof of concept

*Decided by the owner, 2026-11-24:* the first version of the app has no
sign-in. Proper sign-in comes later (O27), and will not be a user and
password store of pommedonjon's own.

What that means while it lasts, and should be kept in view: the API will
grow from "make a phone show its prompt" to changing settings and taking
in pair records, with nothing checking who is asking. It belongs on a
trusted network only. Two rules hold regardless: the API never hands a
pair record back out, and it never serves the contents of a backup.

## Open

Still needing a decision or a test. Items settled since the first review are
under [Settled](#settled) below; they keep their numbers because commit
messages cite them.

| | Question | Waiting on |
|---|---|---|
| O8 | Remote backups over the tailnet | later |
| O9 | Proving a backup restores | later |
| O10 | How the first full backup is taken | later |
| O11 | Pair record lifetime | later |
| O12 | Persistent misconfiguration is silent | later |
| O14 | Onboarding the second phone | next, with the second phone |
| O15 | Connections that fail or drop | partly settled |
| O16 | Plugged in, or on a charger? To be settled by the field trial | the field trial decides |
| O18 | Which phone goes to which environment | needs the owner |
| O21 | Getting the config and pair records in without copying files | now O24 and O25 |
| O23 | The design brief: theme, component kit, screens | agreed; nothing waiting |
| O24 | Settings without a config file | the owner's yes to the proposal |
| O25 | Adding a phone from the app | a test of pairing from the browser |
| O26 | What starts a backup: a button or a schedule | decided, rules agreed; to be built |
| O27 | Sign-in | later; direction proposed |

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
from a USB backup works, and is how the owner's NAS was started: every
backup there since has been an incremental. A phone with no computer to
seed from would have to do the full one over WiFi.

### O11. Pair record lifetime

*Later.* One report says pair records can expire after days without contact.
Not verified. If true, the service needs a re-pairing procedure and an
alert.

### O12. Persistent misconfiguration is silent

*Later.* A rejected pair record or a failing probe is logged once and then
waited on. Nothing alerts until the backup goes stale.

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

**Built for the trial:** the daemon stores every change in a phone's power
state and every change in why it is waiting, alongside the run history, and
`pommedonjon report` lays them out day by day with totals that answer the
three questions above, including the hour at which unanswered prompts
arrived. `--json` gives the same for analysis. A record in the database was
chosen over the log because a container restart loses the log.

### O18. Which phone goes to which environment

A phone can only be given to one running daemon (D20). With two phones and
two server environments, the options:

- **Test has the owner's phone, production has the second phone.** New
  builds reach the owner first; the other person only ever gets a released
  version. Recommended.
- **One environment at a time.** Test has both phones during the trial;
  production replaces it afterwards.
- **Test has no phone of its own** and is only for one-off commands.

### O21. Getting the config and pair records in without copying files

The deploy stack keeps them in named volumes (D20), which start empty. The
owner asked whether pommedonjon could create its config on demand, and
expects a web UI to manage it eventually.

Most of the config has a sensible default or is fixed by the image: where
backups and state go, the schedule. Two things cannot be invented: which
phones to back up, which comes down to having a pair record for each, and
which network range to look for them in.

*Decided by the owner, 2026-11-24:* for the proof of concept, copy the two
files into the volumes by hand after the first deploy. Later versions get a
UI that does it. The idea of the app building its own config from the pair
records it finds, needing only a network range, is kept for then. No code
has been changed for this.

### O23. The design brief: theme, component kit, screens

*Asked for by the owner, 2026-11-24*, before any screens are built: a plan
for the look, the component library and the way it is used.

**Written, reviewed and agreed, 2026-11-24:** [DESIGN.md](DESIGN.md). The
owner's choices in it: the System theme, which looks like the iPhone's own
apps; Expo's UI kit; an icon of a phone that is a keep with an apple's
leaf; quiet hours from 10 pm to 7 am; the rules of the automatic mode
(O26); and that the app works out which phone it is on from the pairing,
not from an address.

To be written for the owner's review: the principles (a phone's state at a
glance, one main action, honest about the passcode), the list of screens
and how one leads to the next, colour and type for light and dark, and the
theme. The name gives it one, an apple and a castle keep, to be used with
restraint.

The component kit is open. It has to be one built for React Native that
also renders well on the web (D23). Two or three to be compared against
their current documentation, with a recommendation and a sample screen.

### O24. Settings without a config file

The owner asked whether the config file can go away entirely. *Proposed:*
yes.

- Where things are (the port, the backups and state directories) is fixed
  by the image or set as environment variables.
- Everything else lives in the database and is changed from the app: the
  phones, each one's schedule, and the pair records.
- **The network range may stop being a setting.** Once the app runs on the
  phone, every request it makes tells the server the phone's current
  address. Sweeping a range (D6) becomes the fallback for a phone without
  the app.
- No migration is needed: only the test stack exists, and its one phone
  can be added again through the app.
- A consequence: the app needs to write where pair records are stored.
  Today that volume is mounted read-only (D19).

### O25. Adding a phone from the app

*What the owner wants, 2026-11-24:* add a phone that has been paired
before, and also find a phone freshly plugged into the computer, from the
browser, and copy its pairing.

- **Paired before:** import its pair record. No obstacle.
- **Freshly plugged in, from the browser:** possible in principle through
  WebUSB, and unproven. Reported, not tested here: it works only in
  Chrome-family browsers; the projects that do it are small and
  experimental; only one program can hold the phone's USB connection at a
  time, and on Linux the system's own service has to be disabled first. On
  a Mac, Apple's service holds that connection, and nothing found says it
  can be shared.
- **To do first:** a short, time-boxed test of pairing from Chrome on the
  owner's Mac.
- **The fallback, known to work:** a one-line helper run on the computer,
  which creates the pairing or reads the existing one and sends it to the
  server. The Mac's pair record can be read without root (FINDINGS.md,
  "Pair record portability").

Pairing is not the whole of it: WiFi connections have to be switched on
for the phone and backup encryption set, with a password its owner
chooses. Both are done over the same USB session today.

### O26. What starts a backup: a button or a schedule

*Decided by the owner, 2026-11-24.* The app has its own API. A backup
starts because someone pressed a button in the app, or because a schedule
set in the app says so. Nothing else is involved: no Shortcuts, and no
automation set up by hand on the phone.

I had kept planning around a Shortcuts automation that tells the service
when the charger is connected, carried over from the proof of concept
(O22). That was my mistake about what was being asked for, and it is
dropped from the plan.

How it works, which needs nothing from iOS:

- **The schedule lives on the server**, which is always running. The app
  is where it is set; the server is what acts on it and starts the backup.
  The phone only has to be at home.
- **The button** is the app calling the API, as the proof of concept's
  request already does.
- **"When it goes on charge" stays available as a kind of schedule**,
  without anything on the phone: the server sees it by asking the phone,
  which is how the first automatic backups were started (attempts 15 and
  16).

**The schedule is loose, and the service picks the moment.** *The owner's
idea, 2026-11-24:* an automatic mode. The schedule says roughly how often
and when; an algorithm then chooses the actual moment from what is known
about the phone, and keeps waiting past the scheduled time until its owner
is actually at it.

What it could use:

| Signal | Where it comes from | Known to work? |
|---|---|---|
| At home | The phone answers on the network | Yes |
| On power, and just plugged in | The server asks the phone | Yes (attempts 15 and 16) |
| Unlocked, or just unlocked | The server asks the phone, or listens to it | **Yes, measured 2026-11-24.** A value the phone reports follows the lock, and the phone also announces locking, waking and unlocking as they happen (FINDINGS.md, "Lock state, seen from the server") |
| The app is open | The app tells the server | Certain, once there is an app. The strongest sign of all that the owner is there |
| When prompts were answered before | The run history (O16) | Recorded since the trial began |
| A cancel | The transport (O17) | Yes; already buys a long pause (D8) |

**The rules, agreed by the owner on 2026-11-24** (DESIGN.md, "Automatic
mode"): once a backup is wanted, start when the phone is plugged in at
home or its owner opens the app; after four hours, also at the next unlock
at home; after a day, also any time it is on a charger. Never in quiet
hours, four hours' peace after a cancel, and no more than three unanswered
prompts a day. Plug-in comes before unlock because someone plugging in has
finished with the phone and someone unlocking is about to use it.

So the automatic mode can time a prompt to the moment its owner unlocks
the phone. What that costs is not known yet: hearing it as it happens means
holding a connection to the phone open, and whether that survives the
phone sleeping, and what it does to the battery, are unmeasured. A sensible
first rule: only listen once a backup is due.

This brings back O2 (prompt just after an unlock), which was closed when
prompting a locked phone turned out to be acceptable. Acceptable is not
the same as best: a prompt that arrives as the owner unlocks is the one
least likely to be missed.

Today's settings are "when a backup is due and the phone goes on charge",
with optional hours to stay inside (D7). That is one fixed rule; the
automatic mode would replace it as the default.

The one constraint that no schedule removes: every backup asks for the
passcode on the phone (FINDINGS.md), so a schedule is only useful at times
its owner is likely to be holding it.

### O27. Sign-in

*Later, by the owner (D25).* The owner's direction: not a password store
of our own; sign in with an existing account.

*Proposed:*

- **Standard OIDC as the base**, one implementation that covers Google and
  self-hosted identity providers. GitHub does not follow the standard and
  would need its own adapter.
- **Sign in with Apple as an extra inside the iPhone app.** On the web,
  Apple requires each domain and return address to be registered against a
  developer account, which someone hosting pommedonjon on their own domain
  cannot do under the app's identity.
- Each installation keeps a list of who may sign in.

## Settled

Were open; now decided, built or ruled out of scope.

### O1. Notification channel

*Deferred by the owner, 2026-11-24, and narrowed the same day.* Push or
email notifications are a future feature, not a phase.

What they were for, and where each part went:

- **A heads-up before a backup.** Not needed. The passcode prompt is the
  notice, and with the plug-in trigger the owner is holding the phone.
- **"Backup finished."** Nobody acts on it.
- **"No good backup for days."** The one that matters, because the usual
  way a backup system fails is by stopping quietly. It goes on the status
  page of the web UI (phase 3). A push can follow later.

The owner's idea of the phone telling the server it is ready is now O22.

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

One part of it was a risk to the product, and has now been tested on the
owner's network (2026-11-24). The server is on a different VLAN from the
phones.

- **A firewall rule alone is not enough.** With a rule allowing the server
  to reach the phone on TCP 62078, the connection opened and the phone then
  dropped the lockdown session every time. The earlier report is true: the
  phone refuses lockdown sessions whose source address is outside its own
  subnet. The same thing happens over Tailscale (O8).
- **Rewriting the source address at the router fixes it.** With a
  masquerade (source NAT) policy on the gateway for server to phones'
  network, TCP 62078, the phone sees the gateway's address on its own
  subnet and answers normally. The first probe took 20 s, because it had to
  sweep for the phone; the second took 2 s.
- **Both have to cover more than port 62078.** A backup opens a second
  connection, to a port the phone picks afresh each time (64435 to 64448
  were seen). Limited to 62078, the probe passed and the backup timed out.
  The owner's rule and NAT policy now cover TCP 49152 to 65535.
- The firewall rule is still what decides which devices the server may
  reach. The NAT policy only changes the address the phone sees.
- Nothing in the image or the Compose example changes. The alternative,
  giving the container an address on the phones' network, was not needed.

Carried into the README: a server on another subnet needs both an
allow rule and source NAT towards the phones, on TCP 49152 to 65535. Without
the NAT the symptom is a connection that opens and is then closed by the
phone; with only 62078 allowed it is a probe that works and a backup that
times out as it starts.

A probe that passes while a backup cannot start is a trap for whoever sets
this up. A check that also opens a service port would catch it; not built.

### O6. Where pair records live

*Closed by the owner, 2026-11-24.* See D19.

### O7. Which discovery mechanism

*Decided by the owner, 2026-11-24: scan a configured range, for now.* To be
revisited after more testing and when remote backups are taken up.

How it works:

- The config gives the network range the phones live on.
- pommedonjon first tries the address where it last reached the phone.
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
- **The phone announces itself**, from an app or a Shortcut. Since built,
  as a way to start a backup and not as discovery (O22): the phone says it
  was plugged in, and the service still finds it by address.

### O13. Licence

*Closed by the owner, 2026-11-24.* See D22.

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

### O19. The name

*Closed by the owner, 2026-11-24.* See D21.

### O20. Who owns the backups on the NAS

*Closed by the owner, 2026-11-24.* For a moment the plan was to run the test
stack as root, because the new NAS dataset was owned by root. The owner
chose instead to create a dedicated `pommedonjon` account on the NAS.

How it fits together, with no user IDs needing to match:

- the dataset belongs to the NAS's `pommedonjon` account;
- the NFS share maps every write to that account (Mapall);
- the container keeps running as its normal unprivileged user, 1000.

Checked from the server: a container running as 1000 can create and delete
files on the mounted share. The unprivileged container of D15 stands.

Worth carrying into the README when storage gets its own section: a share
that maps all writes to one account is the simplest way to give the
container somewhere to write on a NAS.

### O22. "Back up now", sent from the phone

The owner's idea (first raised under O1): the phone tells the server to
start, from a button or when it goes on charge. Pressed with the phone
unlocked and in hand, the passcode prompt cannot be missed, and the server
no longer has to infer a plug-in from polling.

*Decided by the owner, 2026-11-24:*

- Try it first as a proof of concept using an Apple Shortcut. If that
  works, the web UI and service interface become the next phase.
- The proof of concept has **no token or other authentication**. It is a
  temporary measure; authentication arrives with the service interface.
- A native iOS app is wanted, later, once enough has been proven.

*Approved by the owner and built, 2026-11-24.* As proposed:

- The daemon listens for HTTP on a port named in the config. With no port
  configured it does not listen at all, so the published image behaves as
  it does today.
- One request: start a backup of a named phone now. It skips the checks
  for "is one due" and "was it just plugged in" and any pause after a
  failure. It is refused if that phone is already being backed up.
- On the phone, a Shortcut that sends that request, as a home-screen
  button and as an automation when the charger is connected.
- The test stack publishes the port on the server (8377).

How it turned out in the code: the config setting is `api.port`; the
request is `POST /devices/<id>/backup-now`, answered with 202, 404 or 409
as soon as the daemon has decided. A GET starts nothing, so a browser or a
link preview cannot set off a prompt. An unencrypted backup is still never
taken, asked for or not.

What the proof of concept had to find out:

- whether the charger automation runs by itself or asks first each time;
- whether the phone can reach the server from its own network without more
  firewall work;
- how long it takes from the tap to the prompt.

What it found, on the owner's phone the same evening:

- **The button works.** One tap, and the passcode prompt appeared.
- **The charger automation runs by itself.** Two requests arrived at the
  server as the owner replugged the charger, with no confirmation asked on
  the phone. Both were refused, correctly, because the backup from the
  button was still running, so the owner saw nothing happen. The Shortcut
  gives no sign of a refusal.
- **The phone reaches the server with no more firewall work** on the
  owner's network.
- **Tap to prompt took 10.6 s.** About 1.8 s finding the phone, 5 s of
  deliberate pause (`headsUpLeadSeconds`, there for a heads-up notification
  that does not exist yet, D9), and 3.9 s connecting and starting the
  backup service. Without the pause it would be under 6 s.

What followed from that, approved by the owner and built the same evening:

- **A second request for the automation.** A request to back up now
  ignores whether a backup is due, which is right for a button and wrong
  for an automation: left on, the charger automation would prompt at every
  plug-in. `POST /devices/<id>/plugged-in` means "this phone has just been
  plugged in" and starts a backup only if the schedule allows one: due,
  inside the allowed hours, and not in the pause after a failure or a
  dismissed prompt. Otherwise it answers 200 with the reason.
- **No heads-up pause on a requested backup**, of either kind. The owner is
  at the phone.

Checked on the owner's phone straight after:

- Tap to prompt fell from 10.6 s to 5.4 s.
- With no backup due, replugging the charger sent the plug-in request, the
  server answered "not now, not due", and nothing appeared on the phone.
- Not yet seen: a plug-in request that does start a backup. The first
  chance is the owner's first plug-in after the next backup falls due.

Still open: the Shortcut shows nothing when the server says no. Left for
the web UI phase.

A consequence worth noting for O16: with the automation in place the phone
announces every plug-in itself, so the "plugged-in" trigger no longer rests
on polling happening to catch one. Polling remains as the fallback for a
phone without the automation.

Without authentication, anything that can reach the port can make a phone
show a passcode prompt. It cannot read or change a backup. That is the
accepted cost for the proof of concept.
