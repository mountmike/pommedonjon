---
"pommedonjon": minor
---

Backups now start as soon as they are decided. The five-second pause before
each one, which waited for a heads-up notification that was never sent, is
gone, so the passcode prompt arrives sooner.

**Remove `headsUpLeadSeconds` from your config if you set it**: the setting
no longer exists and unknown settings are errors.

The log no longer repeats each backup's start and result as a
"notification:" line. A phone that has gone too long without a good backup
is reported as a warning, "no good backup for too long", once a day.
