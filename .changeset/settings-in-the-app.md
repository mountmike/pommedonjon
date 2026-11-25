---
"pommedonjon": minor
---

A phone's name and schedule can now be changed in the web app, on a new
settings screen reached from the phone's page:

- how often it is backed up;
- whether a backup may start only just after plugging in, or any time the
  phone is on a charger;
- quiet hours, in which no backup starts (Back up now still works);
- how long without a backup before it is shown as overdue.

What is changed there is kept in the state database, takes effect within
one poll without a restart, and from then on wins over what the config
file says for that phone. The config file is still where phones are added
and where the pauses after a failed try are set.

For anything that wants the same: `GET` and `PUT /api/devices/<id>/settings`.
