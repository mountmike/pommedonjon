# nightstand

Self-hosted iPhone backups: full, encrypted, restorable backups in the
standard Finder/iTunes format, taken over WiFi to your own storage. No iCloud,
and no Mac or PC in the loop once a phone has been paired.

**Status: early.** The backup path is proven on iOS 26.6.1 and nightstand's
own code has backed a real phone up from the container (see
[FINDINGS.md](FINDINGS.md)). The daemon deciding by itself when to start has
only been tested with fakes; a field trial on a real phone is the next phase.
There are no notifications yet. [DECISIONS.md](DECISIONS.md) records what has
been decided and what is still open.

## What to know first

- **Every backup needs the phone's passcode typed on the phone**, within 60
  seconds of the backup starting. iOS has required this since 16.1 and there
  is no bypass. A locked phone wakes to ask.
- So nightstand starts a backup when you are likely to be there: when the
  phone goes onto a charger at home and its last good backup is more than 20
  hours old. If the prompt goes unanswered it asks again a few minutes later.
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
container as a secret. nightstand checks the file's permissions when it
starts and warns if anyone else can read it.

## Configuration

Copy [nightstand.example.json](nightstand.example.json) to
`config/nightstand.json`. Unknown settings are errors, and every problem in
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
nightstand tries the address where it last reached the phone, and if that
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
| `retryAfterFailureMinutes` | 10 | How soon to try again after any other failure. |
| `staleAfterHours` | 72 | When a backup counts as stale. |

With `"plugged-in"`, a phone left charging overnight is not prompted when its
backup falls due at 3 a.m.; it is backed up at the next plug-in. With
`"on-charger"` it would be, and would be asked again every
`retryAfterTimeoutMinutes` until answered.

nightstand has to see the phone go onto power to call it a plug-in. A phone
already charging when the service starts waits for its next plug-in.

## Running

Start from [compose.example.yaml](compose.example.yaml), which expects:

```
config/nightstand.json    settings
secrets/<name>.plist      one pair record per phone, mode 600
state/                    created by nightstand; a local disk
```

```bash
docker compose up -d
```

Commands (`docker compose run --rm nightstand <command>`, or
`node dist/cli.js <command>` after `pnpm build`):

| Command | What it does |
|---|---|
| `probe` | Find each phone and ask it about itself. Read-only, never prompts. |
| `backup --device ID` | Back one phone up now, ignoring the schedule. The phone will prompt. |
| `status` | Last good backup and recent attempts per phone. |
| `daemon` | Run the service. This is the default. |

The log is one JSON object per line. During a backup it says when the phone
is waiting for its passcode and how far the transfer has got.

## Storage

```
<backupRoot>/<device id>/<udid>/         the backup, in Finder/iTunes layout
<backupRoot>/<device id>/verified.json   present only while that backup is verified
```

Each run updates the backup in place. If a run fails part-way, the backup on
disk can be left incomplete until the next good run, and nightstand keeps no
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

```bash
pnpm install
```

```bash
pnpm test
```

```bash
pnpm typecheck
```

The tests use fakes for the phone and the sidecar; none of them touch a real
device.
