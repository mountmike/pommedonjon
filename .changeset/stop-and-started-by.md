---
"pommedonjon": minor
---

A running backup can be stopped from the web app: **Stop** takes the place
of Back up now while one runs. A stopped backup counts as "not now", so
the phone is left alone for as long as after Cancel on the phone itself.

Each backup in a phone's history now says what started it: a plug-in, an
unlock, time on a charger, or someone asking.

For anything that wants the same: `POST /api/devices/<id>/stop`, and each
run in `GET /api/devices/<id>` carries `startedBy`.
