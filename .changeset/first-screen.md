---
"pommedonjon": minor
---

The server now has a web app. With `api.port` set, open the server's
address in a browser to see every phone and its state: backed up, due,
overdue, away or backing up, with when it was last backed up and what it
is waiting for. A running backup shows its steps as they happen, including
the 60 seconds the phone waits for its passcode.

It is read-only for now, and like the rest of the interface it has no
sign-in yet, so keep it on a network you trust.

For anything that wants the same information: `GET /api/devices` and
`GET /api/devices/<id>`.
