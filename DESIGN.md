# Design brief

How the app should look, read and behave, before any screen is built.
Reviewed and agreed with the owner on 2026-11-24 ([DECISIONS.md](DECISIONS.md)
O23); nothing here is built yet. Where something rests on a measurement it says so and points
at [FINDINGS.md](FINDINGS.md).

One app, for the web and the iPhone, from one codebase (D23).

## What it is for

Three questions, in this order:

1. **Is my phone backed up?**
2. **If not, what is it waiting for?**
3. **Can I just do it now?**

Everything else (schedules, adding a phone, history) is in service of those
and sits one step further away.

## Principles

- **The answer first.** The first thing on screen is the state of each
  phone, in words, with when it was last backed up.
- **One main action.** "Back up now" is the only prominent button.
- **Honest about the passcode.** Every backup needs the passcode typed on
  the phone within 60 seconds (FINDINGS.md). The app says so before it
  starts, shows "enter your passcode" while it waits, and never implies a
  backup happens with nobody there.
- **Always says why.** When nothing is happening, it says what would make
  something happen: "Will back up next time you plug in at home."
- **Quiet when fine, loud when not.** No celebration for a routine backup.
  A phone that has gone days without one is unmissable.
- **Never colour alone.** Every state has an icon and words as well as a
  colour.
- **Plain words.** See [Words](#words).

## What a phone can be

The whole vocabulary of the status screen. Each maps to something the
server already knows.

| State | Says | Colour | When |
|---|---|---|---|
| Backed up | "Backed up 2 hours ago" | Safe | Last good backup is recent |
| Due | "Backup due. Will start when you plug in at home." | Due | Older than the schedule allows; waiting for a good moment |
| Overdue | "No backup for 4 days" | Overdue | Older than the stale limit (72 hours today) |
| Backing up | "Enter your passcode on the phone", then "Backing up, 42%", then "Checking" | Tint | A run is in progress |
| Away | "Not at home. Last backed up yesterday." | Neutral | The phone does not answer on the home network. Not a fault |
| Needs you | "Backup encryption is off on this phone", "This phone needs pairing again" | Overdue | Something only its owner can fix |
| Never | "Not backed up yet" | Due | Added, no good backup so far |

## Screens

| Screen | For | Main action |
|---|---|---|
| **Phones** (home) | Every phone and its state. On the iPhone app, this phone comes first and largest | Back up now |
| **A phone** | Its state, what it is waiting for, its history day by day, its schedule | Back up now |
| **Backup in progress** | The steps of a run, as they happen; shown in place on both screens above | Cancel |
| **Schedule** | How often, and which moments are fair game ([Automatic mode](#automatic-mode)) | Save |
| **Add a phone** | Bring in a phone that was paired before, or pair a new one; then check it is ready | Add |
| **Settings** | Where backups are kept, the app's version; sign-in when there is one | |
| **Connect** (iPhone app, first run only) | Tell the app where the server is. The web app never needs this | Connect |

How they connect: Phones leads to A phone; Schedule and history are inside A
phone; Add a phone and Settings hang off Phones. With one or two phones in a
household, that is the whole app. No tab bar.

### A backup, as its owner sees it

1. They tap **Back up now**, or a good moment arrives.
2. "Connecting to your phone." A few seconds.
3. **"Enter your passcode on the phone."** With a 60-second countdown,
   because that is how long the phone waits.
4. "Backing up, 42%." They can put the phone down and leave the app.
5. "Checking the backup."
6. "Backed up just now." The screen goes back to quiet.

When it does not work, the reason and what to do, in a sentence:

| What happened | Says |
|---|---|
| Nobody typed the passcode | "The phone asked for your passcode and nobody answered. It will try again at the next good moment." |
| They tapped Cancel | "You cancelled. It will leave you alone for a few hours." |
| The phone went out of reach | "Lost contact with the phone part-way. Your last good backup is safe." |
| The backup did not check out | "The backup finished but did not pass its checks, so it does not count." |

## Automatic mode

The owner's idea (O26): the schedule says roughly how often, and the service
picks the moment, waiting past the due time until its owner is at the phone.

**The rules, agreed by the owner on 2026-11-24.** A backup is *wanted* once the last good one is
older than "how often" (daily by default). From then on the service gets
steadily less choosy about the moment:

| Once it has been wanted for | It starts when |
|---|---|
| Any time | The phone is plugged in at home, or its owner opens the app |
| 4 hours | Also: the next time the phone is unlocked at home |
| 24 hours | Also: any time it is on a charger at home |

Always, whatever the rung:

- Only at home, and never an unencrypted backup.
- Never inside quiet hours (proposed default: 10 pm to 7 am).
- After a Cancel, leave the phone alone for four hours (D8).
- After a prompt nobody answered, wait for the next good moment instead of
  asking again on a timer; no more than three unanswered prompts in a day.
- **Back up now** ignores all of this.

Why plugging in comes before unlocking: someone plugging in has finished
with the phone, and someone unlocking is about to use it. A prompt at unlock
is harder to miss and more of an interruption, so it is held back until the
backup has been wanted for a while.

What each rung relies on, and whether it is known to work:

| Signal | Measured? |
|---|---|
| Plugged in | Yes (attempts 15 and 16) |
| Unlocked | Yes, seen from the server as it happens (FINDINGS.md, "Lock state, seen from the server"). Not measured: what listening for it costs the battery. So the service only listens once a backup has been wanted for four hours |
| The app is open | Certain once there is an app. The app has to know which phone it is running on; see the open questions |

On the Schedule screen this is three things to set, not a rule editor: how
often, quiet hours, and a switch for each kind of moment. "Only when I ask"
turns the automatic mode off.

**Built 2026-11-25** (DECISIONS.md, D27), except "its owner opens the app",
which waits for the iPhone app. How it differs from the table above:

- An unlock is seen at the service's regular check on the phone, every two
  minutes while a backup is wanted, not by listening for it. A phone
  unlocked for a few seconds between checks is missed.
- "Wait for the next good moment" is exact: a plug-in or a stretch of being
  unlocked is used once. Sitting on a charger is not a moment, so that rung
  asks again four hours after an unanswered prompt.
- A phone that has never been backed up is on the first rung only.

## Look

### Theme

*Chosen by the owner, 2026-11-24:* **System.** The app looks like the
iPhone's own apps: the grouped grey background, white cards, the system's
blue for the main action, and the system's green, orange and red for a
phone's state. The first proposal, warm stone with a green button, was not
liked; two other alternatives (a dark, high-contrast one and a cream and
red one) were shown and passed over.

Why it suits this app: the controls are the phone's own (see [Component
kit](#component-kit)), and they already look like this. A custom palette
would have to fight them.

The name's apple and castle keep appear in the app icon and in the empty
state before any phone is added, and nowhere else.

### Icon

*Chosen by the owner, 2026-11-24, after three rounds:* **a phone that is a
keep, with an apple's leaf.** A white phone on the theme's blue, its top
edge a battlement, with a stem and a green leaf above it. The phone is the
thing being kept; the battlement is the donjon; the leaf is the apple.

The rough drawing the choice was made from is
[design/icon-direction.svg](design/icon-direction.svg). It sets the
direction and is not finished artwork: a real icon still has to be drawn to
Apple's sizes and safe areas.

Passed over on the way: an apple with a battlement, a keep with a leaf
(liked, and folded into the choice), an apple with a keyhole, an apple in a
gate, a shield, a monogram, a portcullis, an iPhone behind bars, and an
apple behind dungeon bars.

### Colour

**On the iPhone, the system's own named colours are used**, not fixed
values: they follow light and dark, and the phone's accessibility settings
(increased contrast, for instance), with nothing for the app to do.

**On the web, these values stand in for them.** Every text pairing was
computed and meets the 4.5 to 1 contrast needed for body text.

| Token | Used for | On the iPhone | Web, light | Web, dark |
|---|---|---|---|---|
| `background` | Behind everything | grouped background | `#F2F2F7` | `#000000` |
| `surface` | Cards, sheets | secondary grouped background | `#FFFFFF` | `#1C1C1E` |
| `ink` | Text | label | `#000000` | `#FFFFFF` |
| `muted` | Secondary text | secondary label | `#6C6C70` | `#AEAEB2` |
| `tint` | The main button, links, a backup in progress | the app's tint, system blue | `#0066CC` | `#4DA3FF` |
| `safe` | Backed up | system green | `#1E7B34` | `#30D158` |
| `due` | Due, never backed up | system orange | `#8A4B00` | `#FF9F0A` |
| `overdue` | Overdue, needs you | system red | `#C4281C` | `#FF6961` |

The web values are darker than the system's in light mode, and the web's
dark button carries dark text, because the system's own blue with white
text measures 3.7 to 1, under the threshold. Lowest contrast measured on the
web: `muted` on `background` in light, 4.7 to 1.

The app follows the system's light or dark setting.

### Type, space and shape

- **Type:** the system font on each platform (San Francisco on the iPhone),
  at the system's own text sizes, so the phone's text-size setting is
  respected. No web fonts to load.
- **Sizes:** 34 for a phone's state, 22 for headings, 17 for body, 15 and 13
  for secondary text.
- **Space:** multiples of 4: 4, 8, 12, 16, 24, 32.
- **Shape:** cards with 12 corners, buttons with 10, as the system's own. Anything tappable is at
  least 44 points tall.
- **Icons:** the system's symbols, one per state: a filled tick, a clock, a
  warning triangle, a progress ring.
- **Motion:** the progress ring and nothing decorative. Respects the
  reduce-motion setting.

### iPhone and web

The same screens and the same components. The differences:

- **iPhone:** native navigation, sheets and controls. "This iPhone" is
  marked and comes first.
- **Web:** a single centred column on a narrow window; on a wide one, the
  list of phones beside the selected phone.
- **Pairing a new phone** can only happen where a cable can reach: on a
  computer, in the web app (O25). The iPhone app can add itself only if it
  was paired before.

## Words

Second person, short sentences, no internal terms.

| Say | Not |
|---|---|
| your passcode | PIN, password |
| pairing; "pair this phone" | pair record, lockdown, trust record |
| backup encryption | encrypted backup password setup |
| at home | on the LAN, reachable |
| checking the backup | verification |
| back up now | trigger, run, sync |

Times are relative when recent ("2 hours ago", "yesterday at 9:01 pm") and
dates after a week.

## Component kit

**Recommended: Expo's own UI kit, used through its universal components,
plus four components of our own.**

- Expo UI's universal components render real SwiftUI controls on the iPhone
  and plain equivalents on the web, from one component tree. Its list covers
  what this app is mostly made of: lists, grouped settings rows, switches,
  pickers, sheets, buttons, text inputs and system symbols.
- Navigation is the platform's own, through Expo Router.
- Ours to build, styled from the tokens above: the state display for a
  phone, the steps of a backup, the history timeline, and the phone card on
  the home screen.

Why this one: the owner wants a real iPhone app (D23), and this is the kit
that puts actual native controls on the phone while still producing the web
app.

**Checked on the web, 2026-11-24,** with the first screen built: its
buttons and switch look right in light and dark and take the theme's blue.
Its list rows come out plain on the web, with no card behind them and no
dividers, so on the web our own card goes around them. Good enough to keep.
Not yet seen: the same components on an iPhone, which is where they are
native. The fallback, if that disappoints, remains NativeWind with React
Native Reusables: one hand-styled look on both platforms, more of it ours
to maintain, and no native controls.

Considered and not recommended: Tamagui (the most capable for web plus
native, and the heaviest to set up for an app this small), gluestack-ui
(sources disagree on its current version).

## Questions for the owner

Answered on 2026-11-24:

- **Quiet hours:** 10 pm to 7 am is the default.
- **Other people's phones:** with no sign-in (D25), anyone who can open the
  app can press any phone's button and change any schedule. Accepted for
  now.
- **The kit:** Expo UI, with the fallback as described.
- **The theme:** System, chosen from three alternatives after the first
  proposal was not liked. See [Look](#look).
- **The icon:** a phone that is a keep, with an apple's leaf. See
  [Icon](#icon).

- **The ladder:** agreed as proposed. Plug-in or opening the app first,
  unlock after four hours, any time on the charger after a day. See
  [Automatic mode](#automatic-mode).

Nothing in this brief is waiting on the owner now. The waits and limits in
the ladder are first guesses; the field trial's record (O16) is what they
get tuned against.

### Which phone is the app running on?

*The owner, 2026-11-24:* not by network address, which changes. It should
be worked out from something that ties the app to the phone the server
backs up.

The obstacle: iOS hides a phone's own identifiers from apps, and the backup
is encrypted, so the app cannot read an id that the server also holds. Two
ways do tie them together without asking anyone:

- **The server proves it when the app first calls.** It connects back to
  the address the call came from and tries each phone's pairing; the phone
  that answers is the phone. The address is only where to knock, and the
  pairing is the proof, exactly as when finding a phone (D6). The server
  then gives the app a token to keep, so this happens once and a changed
  address afterwards does not matter.
- **The server leaves a note in the app's own folder.** A paired computer
  can read and write an app's documents folder over the same connection it
  backs up through, if the app allows file sharing. The server would write
  the phone's id there and the app would read it. This does not depend on
  the network at all. Reported, not tested here; it needs the app to exist
  first.

Proposed: start with the first, and test the second once the app is on a
phone.

## Not in the first version

Sign-in (O27), push notifications (O1), restoring a backup from the app,
how much space each backup takes, and anything for Android.

## Sources

For the component kit: [Expo UI](https://docs.expo.dev/versions/latest/sdk/ui/),
[Expo UI universal components](https://docs.expo.dev/versions/latest/sdk/ui/universal/),
[React Native Reusables](https://reactnativereusables.com), and three
round-ups of the field, read as secondhand:
[LogRocket](https://blog.logrocket.com/best-react-native-ui-component-libraries/),
[motionary](https://motionary.dev/blog/best-react-native-ui-libraries-2026),
[PkgPulse](https://www.pkgpulse.com/guides/nativewind-vs-tamagui-vs-twrnc-react-native-styling-2026).
