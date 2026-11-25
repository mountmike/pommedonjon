# pommedonjon

## 0.2.0

### Minor Changes

- abcaf02: Phones are now added and managed in the web app, and the config file is
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
- d8769e4: Backups now start at a good moment instead of on one fixed trigger. Once a
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
- 87a7681: The web app can now do something, and shows what has happened:
  
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
- 86fbaf1: A phone can now ask to be backed up. Set `api.port` in the config and send
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
- 1cdee7f: The server now has a web app. With `api.port` set, open the server's
  address in a browser to see every phone and its state: backed up, due,
  overdue, away or backing up, with when it was last backed up and what it
  is waiting for. A running backup shows its steps as they happen, including
  the 60 seconds the phone waits for its passcode.
  
  Like the rest of the interface it has no
  sign-in yet, so keep it on a network you trust.
  
  For anything that wants the same information: `GET /api/devices` and
  `GET /api/devices/<id>`.
- b477825: Backups now start as soon as they are decided. The five-second pause before
  each one, which waited for a heads-up notification that was never sent, is
  gone, so the passcode prompt arrives sooner.
  
  **Remove `headsUpLeadSeconds` from your config if you set it**: the setting
  no longer exists and unknown settings are errors.
  
  The log no longer repeats each backup's start and result as a
  "notification:" line. A phone that has gone too long without a good backup
  is reported as a warning, "no good backup for too long", once a day.
- 578ef01: A phone's name and schedule can now be changed in the web app, on a new
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
- 0b20a21: A running backup can be stopped from the web app: **Stop** takes the place
  of Back up now while one runs. A stopped backup counts as "not now", so
  the phone is left alone for as long as after Cancel on the phone itself.
  
  Each backup in a phone's history now says what started it: a plug-in, an
  unlock, time on a charger, or someone asking.
  
  For anything that wants the same: `POST /api/devices/<id>/stop`, and each
  run in `GET /api/devices/<id>` carries `startedBy`.
- 8e2de72: The server now works out which phone a request comes from, and opening
  the app on a phone is a moment a wanted backup may start.
  
  - When the app is opened on one of your phones, and a backup of it is
    wanted, the backup starts: nobody is more certainly holding a phone. This
    has its own switch in each phone's settings, on by default, and respects
    quiet hours and the pauses like every other moment.
  - The phone the app is running on is marked "This iPhone" and listed first.
    This works for the web app opened in Safari on the phone.
  - The server recognises a phone by connecting back to the address the
    request came from with each phone's pairing: only the real phone accepts
    its own. Behind a reverse proxy, set `POMMEDONJON_TRUST_PROXY=1` so the
    address is taken from `X-Forwarded-For`.
  
  The iPhone app is prepared but not yet built: it gains a Connect screen for
  the server's address, its bundle id and its icon. The web app has the new
  icon too.
  
  For anything that wants the same: `GET /api/me` and `POST /api/me/opened`.

### Patch Changes

- 79eb219: The image's state and backup directories now belong to the user it runs as,
  so the default named volume for run history is writable on first start.
  Before, a fresh volume was owned by root and the app failed to start.
- 0a22585: Fixes from a review of the automatic schedule and phone management, before
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
- @pommedonjon/api-contract@0.2.0

## 0.1.0

### Minor Changes

- 7fe2098: First build for the field trial. Backs up iPhones over WiFi to a directory you
  choose: finds each phone by sweeping a network range, starts when the phone is
  plugged in and its last good backup is over 20 hours old, backs up several
  phones at once, and keeps a per-day record you can read with `report`.
