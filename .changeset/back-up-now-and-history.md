---
"pommedonjon": minor
---

The web app can now do something, and shows what has happened:

- **Back up now** for each phone, on the home screen and on the phone's own
  page. The app shows "Connecting to your phone" at once, then the passcode
  prompt and the rest of the backup as it happens.
- If a backup you asked for cannot start, because the phone could not be
  reached or its backup encryption is off, the app says so. Before, a
  request that never reached the phone left nothing to see.
- When the last try did not work, the phone's card says when and why.
- Each phone has a page with its past backups day by day: when, how long a
  good one took, and why a bad one did not count.

For anything that wants the same: `POST /api/devices/<id>/backup-now`, and
`GET /api/devices/<id>` now carries the last 50 backups. Every phone's
summary has a new `lastAttempt`.
