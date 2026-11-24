---
"pommedonjon": minor
---

Phones are now added and managed in the web app, and the config file is
gone.

- **Add a phone** by choosing its pairing file. With the phone at home and
  awake that is all: the server finds the phone and asks its name and
  identifier. The phone's page then checks it: at home, pairing accepted,
  backup encryption on.
- **Remove a phone** from its settings. Its pairing is destroyed; its
  backups and history stay.
- **Check a phone** from its page at any time. Nothing appears on the phone.
- **Server**: set the network range the phones are on, and see which
  version is running and where backups go.

**Upgrading.** Leave the config file and the pair records mounted for one
start. The phones, their pairings and the settings are brought into the
state volume and the log says so; after that neither is read and the two
mounts can be removed. `pommedonjon import --config FILE` does the same by
hand.

**Changed.**

- Everything the service keeps is in the state volume, including the
  pairings. It holds secrets: back it up like one. `POMMEDONJON_PAIRINGS_DIR`
  puts the pairings on a volume of their own.
- The web app's port is on by default (8377). Set `POMMEDONJON_PORT=off` to
  listen on nothing. There is still no sign-in: keep it on a network you
  trust.
- Commands no longer take `--config`. Where things are comes from
  `POMMEDONJON_STATE_DIR`, `POMMEDONJON_BACKUP_ROOT` and `POMMEDONJON_PORT`.

For anything that wants the same: `POST /api/devices`,
`DELETE /api/devices/<id>`, `POST /api/devices/<id>/check`, `GET /api/server`
and `GET`/`PUT /api/settings`.
