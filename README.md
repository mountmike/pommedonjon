# pommedonjon

Self-hosted iPhone backups: full, encrypted, restorable backups in the
standard Finder/iTunes format, taken over WiFi to your own storage. No iCloud,
and no Mac or PC in the loop once a phone has been paired.

**Status: early, and in trial on one phone.** A server on another VLAN is
backing up a real iPhone (iOS 26.6.1) to a NAS by its own decision, and the
phone can ask for a backup itself. A backup has not yet been proven to
decrypt and restore, there is no web UI, and the interface for requests
has no authentication. [FINDINGS.md](FINDINGS.md) is what has been measured;
[DECISIONS.md](DECISIONS.md) is what has been decided and what is still
open; [DESIGN.md](DESIGN.md) is the brief for the app that comes next.

## What to know first

- **Every backup needs the phone's passcode typed on the phone**, within 60
  seconds of the backup starting. iOS has required this since 16.1 and there
  is no bypass. A locked phone wakes to ask.
- So pommedonjon starts a backup when you are likely to be there: when the
  phone goes onto a charger at home and its last good backup is more than 20
  hours old. If the prompt goes unanswered it asks again a few minutes later;
  if you tap Cancel it leaves you alone for four hours.
- It only backs up a phone that has backup encryption turned on.
- It keeps **one** verified backup per phone and no history. Keeping earlier
  versions is for you to arrange on the backups directory, for example with
  filesystem snapshots. See [Storage](#storage).

## How it fits together

```
TypeScript daemon (apps/server/src)       Python sidecar (apps/server/sidecar)
  discovery: where is the phone?    --->    probe   read-only device status
  policy:    is a backup due, and
             was it just plugged in?
  runner:    back up, then verify   --->    backup  JSON events as it runs
                                    --->    verify  is this backup complete?
  state:     SQLite run history
```

The sidecar wraps [pymobiledevice3](https://github.com/doronz88/pymobiledevice3)
and talks straight to the phone's lockdown port (TCP 62078) using a pair
record. The container needs no USB, no usbmuxd, no root and no host
networking: only outbound TCP to the phones.

Each phone has its own independent cycle, so two phones back up at the same
time.

## Setting up a phone

Pairing needs a USB cable and a computer once. On a Mac with pymobiledevice3
installed and the phone plugged in and unlocked:

```bash
pymobiledevice3 lockdown pair
```

```bash
pymobiledevice3 lockdown wifi-connections on
```

```bash
pymobiledevice3 lockdown save-pair-record secrets/phone-one.plist
```

```bash
chmod 600 secrets/phone-one.plist
```

Backup encryption must also be on. Turn it on in Finder's page for the phone
("Encrypt local backup"), which keeps the password out of your shell history;
`pymobiledevice3 backup2 encryption on PASSWORD` does the same but takes the
password as an argument. Check the current state with:

```bash
pymobiledevice3 backup2 encryption
```

**The pair record grants full access to the phone**, with no passcode, for as
long as the pairing lasts. Treat it like a private key: never commit it, keep
it readable only by the user the container runs as, and hand it to the
container as a secret. pommedonjon checks the file's permissions when it
starts and warns if anyone else can read it.

## Configuration

Start from [pommedonjon.example.json](apps/server/pommedonjon.example.json). Unknown settings are errors, and every problem in
the file is reported at once.

| Setting | Meaning |
|---|---|
| `backupRoot` | Where backups live. One directory per phone underneath. |
| `stateDir` | Where the run history (SQLite) lives. Must be a local disk. |
| `discovery.ranges` | The network ranges the phones are on, e.g. `["192.168.1.0/24"]`. At most /22 each. |
| `discovery.scanIntervalSeconds` | A range is not swept more often than this. Default 300. |
| `api.port` | Optional. Listen on this port for "back up now" requests; see below. Left out, nothing listens. |
| `devices[].id` | Short name used in paths, logs and commands. |
| `devices[].udid` | The phone's UDID. |
| `devices[].pairRecordPath` | Where its pair record is mounted. |
| `devices[].host` | Optional. Pins the phone to one address or name; nothing else is tried. |
| `defaultPolicy`, `devices[].policy` | When to back up; see below. A phone's own policy overrides the default, and what is changed in the web app overrides both. |

### Finding the phone

A phone's address can change, so it does not need one in the config.
pommedonjon tries the address where it last reached the phone, and if that
does not answer it tries the lockdown port on every address in
`discovery.ranges`. Whatever answers, the pair record decides whether it is
the right phone, so a wrong address can never lead to backing up the wrong
one.

Your firewall has to let the container reach the phones on TCP 49152 to
65535. Port 62078 alone is not enough: it finds the phone and starts the
conversation, and the backup itself then runs on a port the phone picks
each time. A router's intrusion detection may notice the sweeps.

If the container is on a different subnet from the phones, the router also
has to rewrite the source address (source NAT, or masquerade) on that
traffic, so the phone sees an address on its own network. A phone accepts a
connection from another subnet and then closes it.

### When a backup starts

Every backup needs the passcode typed on the phone, so the service does not
back up at a set time. It waits for a moment when the phone's owner is
likely to be holding it, and gets less choosy the longer a backup has been
wanted:

| Once a backup has been wanted for | It starts |
|---|---|
| any time at all | in the minutes after the phone is plugged in at home |
| 4 hours | also when the phone is found unlocked at home |
| a day | also any time the phone is on a charger at home |

A backup is *wanted* once the last good one is older than `dueAfterHours`.
All of this can be set for each phone in the web app, or here:

| Policy setting | Default | Meaning |
|---|---|---|
| `automatic` | `true` | `false`: nothing starts unless someone asks for it. |
| `dueAfterHours` | 20 | A backup is wanted once the last good one is this old. |
| `startWhenPluggedIn` | `true` | Start shortly after the phone goes onto power. |
| `pluggedInWindowMinutes` | 30 | How long after going onto power that is. |
| `startWhenUnlockedAfterHours` | 4 | Once wanted this long, also start when the phone is unlocked. `null` for never. |
| `startOnChargerAfterHours` | 24 | Once wanted this long, also start any time it is on power. `null` for never, 0 for from the start. |
| `window` | `null` | Optional hours to stay inside, e.g. `{"start": "07:00", "end": "22:00"}`. The app calls the hours outside it quiet hours. |
| `retryAfterTimeoutMinutes` | 10 | The least time between an unanswered passcode prompt and the next. |
| `maxUnansweredPerDay` | 3 | After this many unanswered prompts in 24 hours, no more that day. |
| `retryAfterCancelMinutes` | 240 | How long to leave the phone alone after you tap Cancel on the prompt. |
| `retryAfterFailureMinutes` | 10 | How soon to try again after any other failure. |
| `staleAfterHours` | 72 | When a phone counts as overdue. |

A moment is used once. If nobody answers the prompt, the service waits for
the next plug-in or the next unlock; a phone that just sits on a charger is
asked again after four hours. So a phone left charging overnight is not
prompted when its backup falls due at 3 a.m.: it is backed up at the next
plug-in, or when it is next unlocked once four hours have gone by.

How the service knows:

- **Plugged in:** it has to see the phone go onto power. A phone already
  charging when the service starts waits for its next plug-in.
- **Unlocked:** each time it checks on a phone (every `pollIntervalSeconds`
  while a backup is wanted), the phone says whether it is locked. Being
  unlocked for a few seconds between two checks is missed.
- **At home:** the phone answers on the network.

A phone that has never been backed up waits for a plug-in, or for someone
to press Back up now.

### The web app

With `api.port` set, the server also serves a web app at that address, for
example `http://<server>:8377`. It shows:

- every phone and its state, and what each is waiting for;
- a **Back up now** button for each phone;
- a running backup step by step, from "connecting" through the passcode
  prompt to "checking";
- how the last try went if it did not work, and why;
- on each phone's own page, its past backups day by day;
- a phone's name and schedule, to change: automatic or only on request,
  how often, which moments may start a backup, quiet hours, and when it
  counts as overdue.

What is changed in the app is kept in the state database and wins over the
config file from then on. It takes effect within one poll, with no restart.
Adding phones from the app is still to come; [DESIGN.md](DESIGN.md)
describes where it is going.

The app talks to the server through a JSON API, which anything else may use
too:

| Request | Answer |
|---|---|
| `GET /api/devices` | Every phone and its state. |
| `GET /api/devices/<id>` | One phone, with its last 50 backups. |
| `GET /api/devices/<id>/settings` | What can be changed about a phone. |
| `PUT /api/devices/<id>/settings` | Changes it; send all of it. 200 with the settings as saved, 400 `{"error":"invalid-settings","problems":[...]}`. |
| `POST /api/devices/<id>/backup-now` | Backs the phone up now. 202 `{"status":"started"}`, 404 `{"error":"unknown-device"}`, 409 `{"error":"already-running"}`. |

"Started" means the server has begun looking for the phone. If it cannot be
reached, no backup runs, and the phone's state says so.

### Backing up on request

Set `api.port` and the service also takes two requests, meant to be sent
from the phone itself, for instance by Apple Shortcuts:

```
POST http://<server>:<port>/devices/<id>/backup-now
POST http://<server>:<port>/devices/<id>/plugged-in
```

| Request | What it does | Meant for |
|---|---|---|
| `backup-now` | Backs the phone up straight away. Ignores the schedule: whether a backup is due, whether the phone is on a charger, whether an earlier prompt was dismissed. | A button on the home screen. |
| `plugged-in` | Says the phone has just been plugged in. A backup starts only if the schedule allows one now. | An automation that runs when the charger is connected. |

| Answer | Meaning |
|---|---|
| 202 `{"status":"started"}` | A backup is starting; the passcode prompt follows within seconds. |
| 200 `{"status":"not-now","reason":"not-due","until":"..."}` | `plugged-in` only: nothing was started, and why. |
| 404 `{"error":"unknown-device"}` | No phone with that id is configured. |
| 409 `{"error":"already-running"}` | That phone is already being backed up. |

With the automation in place the phone announces each plug-in itself, the
moment it happens, so the service no longer depends on noticing it between
two polls. The container's port has to be published, and the phone has to
be able to reach it.

**There is no authentication yet.** Anything that can reach the port can
make a phone show its passcode prompt. It cannot read or change a backup.
Only publish the port on a network you trust.

## Running

Start from [deploy/compose.yaml](deploy/compose.yaml). It runs the published
image, `ghcr.io/mountmike/pommedonjon`, and needs one thing from you: where
backups go, as `POMMEDONJON_BACKUPS_DIR`. The config, the pair records and
the run history live in volumes Docker creates, so there are no folders to
prepare.

Create the volumes without starting anything:

```bash
POMMEDONJON_BACKUPS_DIR=/mnt/backups/iphones docker compose -f deploy/compose.yaml up --no-start
```

Put your config in:

```bash
docker run --rm -i -v pommedonjon_config:/c alpine sh -c 'cat > /c/pommedonjon.json' < pommedonjon.json
```

Put each phone's pair record in, readable only by the user the container
runs as (1000 unless you set `POMMEDONJON_USER`):

```bash
docker run --rm -i -v pommedonjon_secrets:/s alpine sh -c 'cat > /s/phone-one.plist && chown 1000:1000 /s/phone-one.plist && chmod 600 /s/phone-one.plist' < secrets/phone-one.plist
```

Then start it:

```bash
POMMEDONJON_BACKUPS_DIR=/mnt/backups/iphones docker compose -f deploy/compose.yaml up -d
```

Copying files in by hand is a stopgap until there is a web UI to do it.

Commands (`docker compose run --rm pommedonjon <command>`, or
`node apps/server/dist/cli.js <command>` after `pnpm build`):

| Command | What it does |
|---|---|
| `probe` | Find each phone and ask it about itself. Read-only, never prompts. |
| `backup --device ID` | Back one phone up now, ignoring the schedule. The phone will prompt. |
| `status` | Last good backup and recent attempts per phone. |
| `report [--days N] [--json]` | Day by day: plug-ins, prompts and their outcomes, and why no backup started. |
| `daemon` | Run the service. This is the default. |

The log is one JSON object per line. During a backup it says when the phone
is waiting for its passcode and how far the transfer has got.

### Checking how the schedule is working

`report` reads the run history, which survives restarts, and lays out the
last 14 days per phone:

```
phone-one: 2026-11-24 to 2026-11-26 (3 days)
  backed up on 1 of 3 days; seen plugged in on 2
  prompts: 3 shown, 1 answered (median 4 s), 2 unanswered, 0 cancelled
  unanswered prompts by hour: 23:00 x2
  plugged in but not backed up: 2026-11-25

2026-11-24
  18:02  plugged in
  18:02  backed up in 4 min 11 s (prompt at 18:02, open 4 s)
  ...
```

Days and hours are in the container's timezone, so set `TZ` in the Compose
file to read them as local time.

## Storage

```
<backupRoot>/<device id>/<udid>/         the backup, in Finder/iTunes layout
<backupRoot>/<device id>/verified.json   present only while that backup is verified
```

Each run updates the backup in place. If a run fails part-way, the backup on
disk can be left incomplete until the next good run, and pommedonjon keeps no
earlier copy. **Arrange your own history** on this directory if you want one.

`verified.json` is there for that. It is removed before a run touches the
backup and written again only after the result verifies, so a snapshot job
that runs only while the file exists never captures a half-written backup:

```bash
[ -f /mnt/backups/iphone-backups/phone-one/verified.json ] && zfs snapshot tank/backups@$(date +%F)
```

Verification is structural: the manifests and status file are present and
well-formed, and the backup belongs to the right phone and is encrypted. It
does not prove the backup decrypts or restores.

## Development

Needs Node 26, pnpm and Docker.

```bash
pnpm install
```

```bash
pnpm test
```

```bash
pnpm typecheck
```

The repository is a pnpm workspace, and those commands run in every part of
it:

| Workspace | Holds |
|---|---|
| `apps/server` | The daemon, its API and the Python sidecar. The product's version and changelog live here |
| `apps/app` | The app, built with Expo: one codebase for the web app and the iPhone app. The server serves its web build |
| `packages/api-contract` | The shape of every reply between the two, as Zod schemas both sides use |
| `tools/deploy` | The command that deploys to the test environment |
| `tools/preview` | The command that shows the app with made-up phones |

In each, source is under `src/` and tests under `test/`, in the same folder
layout. The server's tests use fakes for the phone and the sidecar
(`apps/server/test/support/`); none of
them touch a real device.

### Running it on your own machine

[compose.dev.yaml](compose.dev.yaml) builds the image from your checkout and
keeps everything under `local/dev/`, which git ignores:

```
local/dev/config/pommedonjon.json   settings
local/dev/secrets/                 pair records, mode 600
local/dev/state/                   run history
local/dev/backups/                 backups
```

`pnpm dev` runs any command in that container, rebuilding first if the
source changed:

```bash
pnpm dev probe
```

```bash
pnpm dev backup --device phone-one
```

**One daemon per phone.** Two daemons watching the same phone would each
prompt it. If a server already backs a phone up, leave that phone out of
`local/dev`'s config or stick to one-off commands.

### Looking at the app without a phone

```bash
pnpm preview
```

builds everything and serves the app at <http://localhost:8399> with three
made-up phones: one backed up, one due, one overdue. No real phone is
contacted and no backup is made. What it writes goes under `local/preview/`
and is made afresh each time.

[.claude/launch.json](.claude/launch.json) gives the same command to Claude
Code, so it can open the preview in its own browser.

### Environments

| Environment | Runs | Follows |
|---|---|---|
| Development | Your machine, built from the checkout | Whatever is on disk |
| Test | A server, built there from the `test` branch | Whatever `pnpm deploy:test` last sent |
| Production | A server, from the published image | A released version |

`pommedonjon --version` and the first line of the daemon's log say which
build is running, including the commit.

Both server environments use the same compose file,
[deploy/compose.yaml](deploy/compose.yaml), as two separate stacks that set
different variables: which image to run and where backups go. Test adds
[deploy/compose.build.yaml](deploy/compose.build.yaml), which builds the
image instead of pulling it. Only the test stack exists so far. The config,
pair records and run history live in volumes Docker creates on the first
deploy, so nothing is prepared on the server beforehand. [deploy/komodo.example.toml](deploy/komodo.example.toml)
defines the two stacks for [Komodo](https://komo.do).

**A phone belongs to one environment.** Two daemons watching the same phone
would each prompt it.

### Deploying to test

The test stack follows a branch called `test` and builds the image on the
server from whatever commit that branch points at, so no registry or CI run
is involved:

```bash
pnpm deploy:test
```

That pushes your current commit to `test`, asks Komodo to deploy the stack,
waits, and prints how each stage went. The service's own log is read on the
server (`docker logs`) or in Komodo.

It needs Komodo's address and an API key, from the environment or from
`local/komodo.env`; see [deploy/komodo.env.example](deploy/komodo.env.example).

### Releasing

Versions are managed with [Changesets](https://github.com/changesets/changesets).

1. With any change that someone running the app would notice, add a
   changeset and commit it alongside:

   ```bash
   pnpm changeset
   ```

2. Every commit on `main` is tested and published as the `edge` image, plus
   one tagged with its commit (`sha-3f2a9c1`).
3. While changesets are waiting, the pipeline keeps a "Version Packages" pull
   request up to date. It bumps the version and writes `CHANGELOG.md`.
4. Merging that pull request is the release: the pipeline tags `v<version>`,
   publishes the release notes, and pushes the image as `<version>`,
   `<major>.<minor>` and `latest`.

The pipeline is [.github/workflows/pipeline.yml](.github/workflows/pipeline.yml).

## Licence

[GPL-3.0](LICENSE). The container image includes
[pymobiledevice3](https://github.com/doronz88/pymobiledevice3), which is also
GPL-3.0 and does the talking to the phone.
