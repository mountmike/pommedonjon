# pommedonjon

Self-hosted iPhone backups: full, encrypted, restorable backups in the
standard Finder/iTunes format, taken over WiFi to your own storage. No iCloud,
and no Mac or PC in the loop once a phone has been paired.

**Status: early, and in trial on one phone.** A server on another VLAN is
backing up a real iPhone (iOS 26.6.1) to a NAS by its own decision. Phones
are added and managed in a web app the service serves. Not yet there: a
backup has not been proven to decrypt and restore, the web app has no
sign-in, the iPhone app has not been built, and backups only happen at
home. [FINDINGS.md](FINDINGS.md) is what has been measured;
[DECISIONS.md](DECISIONS.md) is what has been decided and what is still
open; [DESIGN.md](DESIGN.md) is the brief for the app;
[REMOTE.md](REMOTE.md) is the research into backing up away from home.

## What to know first

- **Every backup needs the phone's passcode typed on the phone**, within 60
  seconds of the backup starting. iOS has required this since 16.1 and there
  is no bypass. A locked phone wakes to ask.
- So pommedonjon starts a backup when you are likely to be there: just after
  the phone goes onto a charger at home, and, once a backup has been wanted
  for a while, when you unlock it at home. If the prompt goes unanswered it
  waits for the next such moment; if you tap Cancel it leaves you alone for
  four hours. See [When a backup starts](#when-a-backup-starts).
- Phones are added and managed in a web app the service serves. It has **no
  sign-in yet**, so it belongs on a network you trust.
- It only backs up a phone that has backup encryption turned on.
- It keeps **one** verified backup per phone and no history. Keeping earlier
  versions is for you to arrange on the backups directory, for example with
  filesystem snapshots. See [Storage](#storage).

## How it fits together

```
The app (apps/app)                  one codebase: the web app, and the iPhone app
     |  JSON API, shapes in packages/api-contract
TypeScript daemon (apps/server/src)       Python sidecar (apps/server/sidecar)
  api:       the web app and its API
  settings:  the phones, their schedules
  discovery: where is the phone?    --->    probe   read-only device status
  policy:    is a backup wanted, and
             is this a good moment?
  runner:    back up, then verify   --->    backup  JSON events as it runs
                                    --->    verify  is this backup complete?
  state:     SQLite: phones, settings,
             run history
```

The sidecar wraps [pymobiledevice3](https://github.com/doronz88/pymobiledevice3)
and talks straight to the phone's lockdown port (TCP 62078) using a pair
record. The container needs no USB, no usbmuxd, no root and no host
networking: only outbound TCP to the phones.

Each phone has its own independent cycle, so two phones back up at the same
time.

## Setting up a phone

A phone has to trust a computer once, over a USB cable. That makes a
*pairing*: a small file the service then uses to talk to the phone over
WiFi. On a Mac with [pymobiledevice3](https://github.com/doronz88/pymobiledevice3)
installed and the phone plugged in and unlocked:

```bash
pymobiledevice3 lockdown pair
```

```bash
pymobiledevice3 lockdown wifi-connections on
```

```bash
pymobiledevice3 lockdown save-pair-record phone.plist
```

Backup encryption must also be on. Turn it on in Finder's page for the phone
("Encrypt local backup"), which keeps the password out of your shell history;
`pymobiledevice3 backup2 encryption on PASSWORD` does the same but takes the
password as an argument. Check the current state with:

```bash
pymobiledevice3 backup2 encryption
```

Then, in the web app:

1. Under **Server**, set the network range your phones are on, for example
   `192.168.1.0/24`.
2. **Add a phone**, and choose the pairing file. With the phone at home and
   awake that is all: the server finds the phone that accepts the pairing
   and asks its name and identifier. To add a phone that is not at home,
   give its name and identifier (UDID) yourself.
3. The phone's page opens and the server checks it: at home, pairing
   accepted, backup encryption on.

Then delete `phone.plist` from the computer.

**The pairing grants full access to the phone**, with no passcode, for as
long as it lasts. The service keeps it in its state volume, readable by the
service alone; it never shows it, sends it or logs it, and removing the
phone in the web app destroys it. Treat the state volume, and any backup of
it, as a secret.

## Settings

Everything is set in the web app and kept in the state volume. There is no
config file. Where things are comes from the environment, and the image's
defaults suit [deploy/compose.yaml](deploy/compose.yaml) as it stands:

| Variable | Default | Meaning |
|---|---|---|
| `POMMEDONJON_STATE_DIR` | `/state` | The database and the pairings. Must be a local disk. |
| `POMMEDONJON_PAIRINGS_DIR` | `<state>/pairings` | The pairings, if you want them on a volume of their own. |
| `POMMEDONJON_BACKUP_ROOT` | `/backups` | Where backups live. One directory per phone underneath. |
| `POMMEDONJON_PORT` | `8377` | The web app and API. `off` to listen on nothing. |
| `POMMEDONJON_TRUST_PROXY` | off | `1` behind a reverse proxy, so a caller's address is taken from `X-Forwarded-For`. Only when nothing else can reach the port. |

In the web app:

| Where | What |
|---|---|
| **Server** | The network range the phones are on; which version is running and where backups go. |
| **Add a phone** | A phone's pairing, and optionally its name, identifier and a fixed address. |
| A phone's page | Its state, **Back up now**, a check of its connection, its history. |
| A phone's settings | Its name and schedule ([below](#when-a-backup-starts)); removing it. |

**Coming from a config file.** A version before this one read a
`pommedonjon.json` and pair records mounted beside it. Leave both mounted
for one start: the phones, their pairings and the settings are brought into
the state volume, and the log says so. After that neither is read, and the
two mounts can go. `pommedonjon import --config FILE` does the same by hand.
[pommedonjon.example.json](apps/server/pommedonjon.example.json) shows the
old format.

### Finding the phone

A phone's address can change, so it does not need a fixed one.
pommedonjon tries the address where it last reached the phone, and if that
does not answer it tries the lockdown port on every address in the network
range set under **Server** (at most a /22 each). Whatever answers, the
pairing decides whether it is the right phone, so a wrong address can never
lead to backing up the wrong one.

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
| any time at all | in the minutes after the phone is plugged in at home, or when you open the app on it |
| 4 hours | also when the phone is found unlocked at home |
| a day | also any time the phone is on a charger at home |

A backup is *wanted* once the last good one is older than "how often".
Each phone's schedule is set on its settings page in the web app. These are
the settings behind it; the last four are not in the app yet and keep their
defaults:

| Policy setting | Default | Meaning |
|---|---|---|
| `automatic` | `true` | `false`: nothing starts unless someone asks for it. |
| `dueAfterHours` | 20 | A backup is wanted once the last good one is this old. |
| `startWhenPluggedIn` | `true` | Start shortly after the phone goes onto power. |
| `pluggedInWindowMinutes` | 30 | How long after going onto power that is. |
| `startWhenAppOpened` | `true` | Start when the app is opened on the phone itself. |
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
- **Unlocked:** each time it checks on a phone (every two minutes while a
  backup is wanted), the phone says whether it is locked. Being
  unlocked for a few seconds between two checks is missed.
- **The app was opened on it:** the app says so, and the server works out
  which phone is asking by connecting back to the address the request came
  from with each phone's pairing. Only the real phone accepts its own. This
  works for the web app in Safari on the phone too.
- **At home:** the phone answers on the network.

A phone that has never been backed up waits for a plug-in, or for someone
to press Back up now.

### The web app

The service serves a web app on its port, for example
`http://<server>:8377`. It shows:

- every phone and its state, and what each is waiting for;
- a **Back up now** button for each phone, and **Stop** while one runs;
- a running backup step by step, from "connecting" through the passcode
  prompt to "checking";
- how the last try went if it did not work, and why;
- on each phone's own page, a check of its connection and its past backups
  day by day, with what started each one;
- a phone's name and schedule, to change: automatic or only on request,
  how often, which moments may start a backup, quiet hours, and when it
  counts as overdue;
- adding and removing phones, and the server's network range.

Changes take effect within one poll, with no restart.
[DESIGN.md](DESIGN.md) describes where the app is going.

The app talks to the server through a JSON API, which anything else may use
too. **It has no sign-in yet**: anything that can reach the port can use it.

| Request | Answer |
|---|---|
| `GET /api/devices` | Every phone and its state. |
| `POST /api/devices` | Adds a phone: `{"pairRecord": "<base64>", "name"?, "udid"?, "host"?}`. 201 `{"id":...}`, 400 `{"error":"invalid-phone","problems":[...]}`, 409 `{"error":"already-added"}`. |
| `GET /api/devices/<id>` | One phone, with its last 50 backups. |
| `DELETE /api/devices/<id>` | Removes a phone and destroys its pairing. Its backups stay. |
| `POST /api/devices/<id>/check` | Looks for the phone now and says what it reports. Nothing appears on the phone. |
| `GET /api/devices/<id>/settings` | What can be changed about a phone. |
| `PUT /api/devices/<id>/settings` | Changes it; send all of it. 200 with the settings as saved, 400 `{"error":"invalid-settings","problems":[...]}`. |
| `POST /api/devices/<id>/backup-now` | Backs the phone up now. 202 `{"status":"started"}`, 404 `{"error":"unknown-device"}`, 409 `{"error":"already-running"}`. |
| `POST /api/devices/<id>/stop` | Stops the backup of that phone that is running. 202 `{"status":"stopping"}`, 409 `{"error":"not-running"}`. |
| `GET /api/me` | Which phone the request came from, if it is one of the server's: `{"deviceId": "mike"}` or `null`. |
| `POST /api/me/opened` | The app was opened. If that was on one of the phones and a backup is wanted, one starts. |
| `GET /api/server` | Which version is running and where backups go. |
| `GET /api/settings`, `PUT /api/settings` | The server's own settings: the network range and the poll interval. |

A pairing goes in through `POST /api/devices` and never comes out: no reply
carries one.

"Started" means the server has begun looking for the phone. If it cannot be
reached, no backup runs, and the phone's state says so.

### The iPhone app

The same app builds for the iPhone, from the same code
([apps/app](apps/app)). It is not in the App Store and has not been run on
a phone or a simulator yet: what is there is the code, its configuration
and its icon.

What differs from the web app:

- **Connect**, shown once, asks for the server's address, because an app
  is not served by the server the way the web page is.
- The phone it is running on is marked **This iPhone** and listed first.
  (The web app does the same when opened on a phone.)

To build it you need Xcode with an iOS simulator installed, and CocoaPods:

```bash
pnpm --filter @pommedonjon/app ios
```

The app talks plain HTTP to an address on the local network, which iOS
allows for local addresses only. Reaching a server from outside the home
network is a separate question: see [REMOTE.md](REMOTE.md).

### Backing up on request

The service also takes two requests meant to be sent from the phone
itself, for instance by Apple Shortcuts. They are from the proof of concept
and predate the app:

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
backups go, as `POMMEDONJON_BACKUPS_DIR`.

```bash
POMMEDONJON_BACKUPS_DIR=/mnt/backups/iphones docker compose -f deploy/compose.yaml up -d
```

Then open `http://<server>:8377` and [set up a phone](#setting-up-a-phone).

Everything the service keeps is in one volume Docker creates, `state`: the
phones, their pairings, the settings and the history. It must be on the
server's own disk, and it holds secrets. The compose file also names two
volumes, `config` and `secrets`, which only matter to a stack set up before
phones were managed in the web app; a new one can delete those lines.

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
local/dev/state/      the phones, their pairings, settings, history
local/dev/backups/    backups
```

`pnpm dev` runs any command in that container, rebuilding first if the
source changed:

```bash
pnpm dev probe
```

```bash
pnpm dev backup --device phone-one
```

**One service per phone.** Two services watching the same phone would each
prompt it. If a server already backs a phone up, do not add that phone here
as well, or stick to one-off commands.

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
image instead of pulling it. Only the test stack exists so far. Everything
the service keeps lives in a volume Docker creates on the first deploy, so
nothing is prepared on the server beforehand. [deploy/komodo.example.toml](deploy/komodo.example.toml)
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
