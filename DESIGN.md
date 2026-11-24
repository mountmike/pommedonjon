# Design brief

How the app should look, read and behave, before any screen is built.
A proposal for the owner's review ([DECISIONS.md](DECISIONS.md) O23); nothing
here is built. Where something rests on a measurement it says so and points
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
| Backing up | "Enter your passcode on the phone", then "Backing up, 42%", then "Checking" | Busy | A run is in progress |
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

**A proposal for the rules.** A backup is *wanted* once the last good one is
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

## Look

### Theme

The name is an apple (*pomme*) and a castle keep (*donjon*): something
ordinary, kept somewhere solid. The look should be calm and sturdy with a
little warmth, and not a medieval costume.

- Warm stone for surfaces, in place of pure grey.
- Colour carries state and nothing else. There is no brand colour competing
  with it.
- The motif appears in two places only: the app icon, and the empty state
  before any phone is added. Direction for the icon: an apple whose top edge
  is a battlement.

### Colour

Four state colours on warm neutrals, for light and dark. Every text pairing
below was computed and meets the 4.5 to 1 contrast needed for body text.

| Token | Used for | Light | Dark |
|---|---|---|---|
| `background` | Behind everything | `#F6F4F0` | `#151412` |
| `surface` | Cards, sheets | `#FFFFFF` | `#201E1B` |
| `ink` | Text | `#1F1D1A` | `#F1EEE8` |
| `muted` | Secondary text | `#5F5A52` | `#A8A297` |
| `line` | Hairlines, decorative only | `#DDD8CF` | `#38342E` |
| `safe` | Backed up; the main button | `#256B45` | `#6FD19A` |
| `due` | Due, never backed up | `#8A5A0B` | `#F0C062` |
| `overdue` | Overdue, needs you | `#A8321F` | `#F59480` |
| `busy` | A backup in progress | `#2B5C94` | `#8FBBEE` |

Each state colour also has a pale tint for the area behind it (for example
`safe` on `#E3F1E8` in light, `#1C3327` in dark). Lowest contrast measured:
`due` text on its own tint in light, 5.1 to 1; `muted` on `background`,
6.2 to 1.

The app follows the system's light or dark setting.

### Type, space and shape

- **Type:** the system font on each platform (San Francisco on the iPhone),
  at the system's own text sizes, so the phone's text-size setting is
  respected. No web fonts to load.
- **Sizes:** 34 for a phone's state, 22 for headings, 17 for body, 15 and 13
  for secondary text.
- **Space:** multiples of 4: 4, 8, 12, 16, 24, 32.
- **Shape:** cards with 16 corners, buttons with 12. Anything tappable is at
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

**What is not yet known,** and the first screen will settle: how polished
its web output is, and its release status. If either disappoints, the
fallback is NativeWind with React Native Reusables: one hand-styled look on
both platforms, more of it ours to maintain, and no native controls.

Considered and not recommended: Tamagui (the most capable for web plus
native, and the heaviest to set up for an app this small), gluestack-ui
(sources disagree on its current version).

## Questions for the owner

1. **The ladder.** Is plug-in first, unlock after four hours, any time on
   the charger after a day the right order and the right waits?
2. **Quiet hours.** Is 10 pm to 7 am a sensible default?
3. **Which phone am I?** The app cannot read the phone's identity. Two ways
   to know: the server recognises the phone by the address the request came
   from, or the owner picks "this is my phone" once. Proposed: recognise by
   address, fall back to asking.
4. **Other people's phones.** With no sign-in (D25), anyone who can open the
   app can press any phone's button and change any schedule. Acceptable for
   the proof of concept?
5. **The kit.** Go with Expo UI and the fallback as described?
6. **The icon.** Is "an apple with a battlement" the right direction?

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
