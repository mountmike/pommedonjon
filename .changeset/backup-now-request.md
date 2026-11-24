---
"pommedonjon": minor
---

A phone can now ask to be backed up. Set `api.port` in the config and send
either request, for example from Apple Shortcuts:

- `POST /devices/<id>/backup-now` backs the phone up straight away,
  whatever the schedule says. For a button.
- `POST /devices/<id>/plugged-in` says the phone has just been plugged in,
  and starts a backup only if one is due. For a charger automation.

The passcode prompt follows within seconds. The interface is off unless a
port is set, and has no authentication yet, so only publish it on a network
you trust.

The report now shows when a backup was asked for and when a reported
plug-in started nothing.
