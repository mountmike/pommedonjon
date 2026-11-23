# nightstand

Self-hosted iPhone backups: full, encrypted, restorable backups in the
standard Finder/iTunes format, taken over WiFi to your own storage. No iCloud,
and no Mac or PC in the loop once a phone has been paired.

**Status: early.** The backup path is proven on iOS 26.6.1 (see
[FINDINGS.md](FINDINGS.md)). The daemon is built and unit-tested but has not
yet run a scheduled backup against a real phone, and there is no notification
channel yet.

## What to know first

- **Every backup needs the phone's passcode typed on the phone**, within 60
  seconds of the backup starting. iOS has required this since 16.1 and there
  is no bypass. A locked phone wakes and shows a bare passcode keypad with no
  explanation.
- So nightstand does not back up at 3 a.m. It starts a backup when the phone
  is home, on charge, due, and inside a time window you choose, and it rations
  prompts that go unanswered.
- Backups are only taken if the phone has backup encryption turned on.

## How it fits together

```
TypeScript daemon (src/)            Python sidecar (sidecar/)
  policy: is a backup due?    --->    probe   read-only device status
  runner: heads-up, back up,  --->    backup  JSON events as it runs
          verify, snapshot    --->    verify  is this backup complete?
  state:  SQLite run history
```

The sidecar wraps [pymobiledevice3](https://github.com/doronz88/pymobiledevice3)
and talks straight to the phone's lockdown port (TCP 62078) using a pair
record. The container needs no USB, no usbmuxd, no root and no host
networking.

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
pymobiledevice3 lockdown save-pair-record config/pair-records/<udid>.plist
```

Backup encryption must also be on. Turn it on in Finder's page for the phone
("Encrypt local backup"), which keeps the password out of your shell history;
`pymobiledevice3 backup2 encryption on PASSWORD` does the same but takes the
password as an argument. Check the current state with:

```bash
pymobiledevice3 backup2 encryption
```

The pair record grants full access to the phone. Treat it like a private key:
never commit it, and mount it read-only.

Then copy [nightstand.example.json](nightstand.example.json) to
`config/nightstand.json` and fill in each phone's UDID, address and pair
record path. Give each phone a fixed address (a DHCP reservation); its
`.local` name does not resolve reliably.

## Running

With Docker, starting from [compose.example.yaml](compose.example.yaml):

```bash
docker compose up -d
```

Set `TZ` in the compose file: the backup window is read in that timezone.

Commands (inside the container, or `node dist/cli.js` after `pnpm build`):

| Command | What it does |
|---|---|
| `nightstand probe` | Ask each phone about itself. Read-only, never prompts. |
| `nightstand backup --device ID` | Back one phone up now. The phone will prompt. |
| `nightstand status` | Last good backup and recent attempts per phone. |
| `nightstand daemon` | Run the service. |

## Storage layout

```
<backupRoot>/<device id>/working/<udid>/    rewritten by every run
<backupRoot>/<device id>/snapshots/<time>/  kept after verified runs
```

A run that fails, or produces a backup that does not verify, never touches
the snapshots. `snapshots.strategy` is `"copy"` (a full copy per snapshot) or
`"none"` (rely on the filesystem's own snapshots, such as ZFS).

Keep `stateDir` on a local disk, not a network share: it holds a SQLite
database.

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
