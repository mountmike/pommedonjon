---
"pommedonjon": minor
---

A phone can now ask to be backed up straight away. Set `api.port` in the
config and send `POST /devices/<id>/backup-now`, for example from an Apple
Shortcut; the passcode prompt follows within seconds, whatever the schedule
says. The interface is off unless a port is set, and has no authentication
yet, so only publish it on a network you trust.

The report now shows when a backup was asked for.
