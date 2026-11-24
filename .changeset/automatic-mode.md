---
"pommedonjon": minor
---

Backups now start at a good moment instead of on one fixed trigger. Once a
backup is wanted, it starts just after the phone is plugged in at home;
once it has been wanted for four hours, also when the phone is found
unlocked; once it has been wanted for a day, also any time the phone is on
a charger. Each moment can be switched on or off for each phone in the web
app, along with how long a backup waits before the later ones apply.
Automatic backups can also be switched off, leaving only Back up now.

After a passcode prompt nobody answers, the same plug-in or unlock is not
used again: the service waits for the next one. After three unanswered
prompts in 24 hours it stops asking until the oldest is a day old.

**Changed settings.** `trigger` is gone from the policy. In its place:
`automatic`, `startWhenPluggedIn`, `startWhenUnlockedAfterHours`,
`startOnChargerAfterHours` and `maxUnansweredPerDay`. What was
`"trigger": "on-charger"` is now `"startOnChargerAfterHours": 0`. A config
file that still has `trigger` is refused at start-up. Settings saved from
the web app are converted automatically.

The web app now names the moments a waiting phone would start at, for
example "Will start the next time you plug in or unlock the phone at home."
