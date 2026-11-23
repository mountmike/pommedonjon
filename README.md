# pommedonjon

Self-hosted iPhone backups: full, encrypted, restorable backups in the
standard Finder/iTunes format, taken over WiFi to your own storage. No iCloud,
and no Mac or PC in the loop once a phone has been paired.

**Status: early.** The backup path is proven on iOS 26.6.1 and pommedonjon's
own code has backed a real phone up from the container (see
[FINDINGS.md](FINDINGS.md)). The daemon deciding by itself when to start has
only been tested with fakes; a field trial on a real phone is the next phase.
There are no notifications yet. [DECISIONS.md](DECISIONS.md) records what has
been decided and what is still open.

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
TypeScript daemon (src/)                  Python sidecar (sidecar/)
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

Copy [pommedonjon.example.json](pommedonjon.example.json) to
`config/pommedonjon.json`. Unknown settings are errors, and every problem in
the file is reported at once.

| Setting | Meaning |
|---|---|
| `backupRoot` | Where backups live. One directory per phone underneath. |
| `stateDir` | Where the run history (SQLite) lives. Must be a local disk. |
| `discovery.ranges` | The network ranges the phones are on, e.g. `["192.168.1.0/24"]`. At most /22 each. |
| `discovery.scanIntervalSeconds` | A range is not swept more often than this. Default 300. |
| `devices[].id` | Short name used in paths, logs and commands. |
| `devices[].udid` | The phone's UDID. |
| `devices[].pairRecordPath` | Where its pair record is mounted. |
| `devices[].host` | Optional. Pins the phone to one address or name; nothing else is tried. |
| `defaultPolicy`, `devices[].policy` | When to back up; see below. A phone's own policy overrides the default. |

### Finding the phone

A phone's address can change, so it does not need one in the config.
pommedonjon tries the address where it last reached the phone, and if that
does not answer it tries the lockdown port on every address in
`discovery.ranges`. Whatever answers, the pair record decides whether it is
the right phone, so a wrong address can never lead to backing up the wrong
one.

Your firewall has to let the container reach the phones' range on TCP 62078.
A router's intrusion detection may notice the sweeps.

### When a backup starts

| Policy setting | Default | Meaning |
|---|---|---|
| `dueAfterHours` | 20 | A backup is due once the last good one is this old. |
| `trigger` | `"plugged-in"` | `"plugged-in"`: only shortly after the phone goes onto power. `"on-charger"`: any time it is on power. |
| `pluggedInWindowMinutes` | 30 | With `"plugged-in"`: how long after going onto power a backup may start. |
| `window` | `null` | Optional hours to stay inside, e.g. `{"start": "07:00", "end": "22:00"}`. |
| `retryAfterTimeoutMinutes` | 10 | How soon to ask again after an unanswered passcode prompt. |
| `retryAfterCancelMinutes` | 240 | How long to leave the phone alone after you tap Cancel on the prompt. |
| `retryAfterFailureMinutes` | 10 | How soon to try again after any other failure. |
| `staleAfterHours` | 72 | When a backup counts as stale. |

With `"plugged-in"`, a phone left charging overnight is not prompted when its
backup falls due at 3 a.m.; it is backed up at the next plug-in. With
`"on-charger"` it would be, and would be asked again every
`retryAfterTimeoutMinutes` until answered.

pommedonjon has to see the phone go onto power to call it a plug-in. A phone
already charging when the service starts waits for its next plug-in.

## Running

Start from [compose.example.yaml](compose.example.yaml), which expects:

```
config/pommedonjon.json    settings
secrets/<name>.plist      one pair record per phone, mode 600
state/                    created by pommedonjon; a local disk
```

```bash
docker compose up -d
```

Commands (`docker compose run --rm pommedonjon <command>`, or
`node dist/cli.js <command>` after `pnpm build`):

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

Source is under `src/` and tests under `test/`, in the same folder layout.
The tests use fakes for the phone and the sidecar (`test/support/`); none of
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

### Environments

| Environment | Runs | Follows |
|---|---|---|
| Development | Your machine, built from the checkout | Whatever is on disk |
| Test | A server, from the published image | `edge`: every commit on `main` |
| Production | A server, from the published image | A released version |

`pommedonjon --version` and the first line of the daemon's log say which
build is running, including the commit.

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
