---
"pommedonjon": patch
---

Fixes from a review of the automatic schedule and phone management, before
either was released:

- Stop now works while a backup that was asked for is still looking for
  the phone.
- A phone put on a charger while nothing was wanted is no longer taken as
  just plugged in when a backup falls due.
- One missed check on a phone no longer lets the same unlock prompt twice.
- The pause after a Cancel is no longer cut short by a later failure.
- A phone removed in the web app no longer comes back at the next restart
  while an old config file is still mounted.
- An old config file that says `trigger` is read, not refused, and an old
  file that cannot be read no longer stops the service.
- Adding a phone looks at the network afresh each time, checks a typed
  identifier against the phone, and takes it in either case.
- A replacement phone with the same name as an old one starts clean
  instead of inheriting its history and backups.
- In the web app, Back returns to the screen that is already there, and
  screens that are not showing stop asking the server.
