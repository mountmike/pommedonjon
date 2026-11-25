---
"pommedonjon": minor
---

The server now works out which phone a request comes from, and opening
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
