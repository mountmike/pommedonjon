# Away from home: research

Written 2026-11-25. **Nothing here is built.** This is what is known, what
others report, what is only a guess, and the experiments that would settle
it. Each claim is marked:

- **Measured:** seen on the owner's own phone and network (FINDINGS.md).
- **Reported:** from someone else's write-up or documentation, not
  reproduced here.
- **Guess:** follows from the above but has not been tested by anyone I
  can find.

## Two different problems

"Working remotely" is two things, and only one of them is hard.

| | What | How hard |
|---|---|---|
| **A** | Reaching the server from away: opening the app, seeing the phones, changing settings | Solved by any VPN. See [Managing from away](#managing-from-away) |
| **B** | Backing a phone up while it is away from home | Hard. The rest of this document |

B is hard because of the direction. A backup is the *server* opening a
connection *to the phone*, and iOS decides whether to accept it. No app on
the phone can make or send a full backup itself: Apple gives apps no way to
do that, which is why this project talks to the phone the way Finder does.

## What a backup needs from the network

All measured, at home:

- The server connects to the phone on TCP 62078, proves itself with the
  pairing, and the backup then runs on a second port the phone picks
  (49152 to 65535).
- **The phone closes a session that does not come from its own subnet.**
  From another VLAN it accepted the connection and then dropped it. A
  source-NAT rule on the router, so the phone sees an address on its own
  network, fixed that.
- Someone types the passcode on the phone, every time.

## What happens over the tailnet today

**Measured.** The server (dockyard) and the phone are both on the owner's
Tailscale network.

| When | Phone | What was tried, from the server | Result |
|---|---|---|---|
| 2026-11-24 | At home | Read-only probe to the phone's tailnet address | Port 62078 accepted the connection, then the session was dropped; two probes failed after 13 s each |
| 2026-11-25, 9:14 am | Away from home | `tailscale ping` | Answered in about 1 s |
| | | Connect to 62078 on its tailnet address | Silent for 5 s; no refusal |
| | | Connect to 49152 (the newer pairing service) | Silent for 5 s; no refusal |
| | | Read-only probe | Timed out after 14 s |

So Tailscale as it stands does not carry a backup, at home or away. The two
days differ (accepted then dropped, against silent), and I do not know
whether that is because the phone was away, asleep, or on mobile data the
second time.

**Reported**, by one author on iOS 26.5 (the dev.to post under Sources):

- Over a tailnet, port 62078 accepts a connection and resets it on the
  first byte, whatever is sent.
- The newer developer tunnel does work over a tailnet for installing an
  app from Xcode's tools, with a Mac relaying and re-advertising the phone.
  It needed one USB connection first, and it only worked while the phone
  was joined to some WiFi network; on mobile data alone the ports refused.
- The author's reading is that Apple no longer exposes the old protocol
  over the network at all. **That is not what this project measured:** at
  home, over WiFi, the old protocol works and has taken several backups.
  What the author saw is consistent with the subnet rule above.

## Why the tailnet fails: a guess

**Guess.** The phone's rule looks like "the other end must be on a network
this interface is directly attached to". At home that is the WiFi subnet,
and source NAT satisfies it. Tailscale gives the phone a single address
with no subnet around it, so no other address can ever be "on the same
network", and nothing the server does can satisfy the rule.

If that is right, the fix is a VPN that gives the phone an address **inside
a real subnet**, with the server appearing from an address in that same
subnet. Plain WireGuard does exactly that, and the home router already
knows how to rewrite the server's address (it does so today for the WiFi
subnet).

It may be wrong. The phone might only accept backups arriving on WiFi
itself, whatever the addresses say. Nobody I can find has tested it, and it
is cheap to test.

## Routes compared

| Route | What it is | Status | Cost to try |
|---|---|---|---|
| **1. Tailscale as it is** | Server reaches the phone's tailnet address | **Measured: does not work** | Done |
| **2. WireGuard with a real subnet** | Phone joins a WireGuard VPN run by the home router; server reaches it through the same source-NAT trick as at home | **Guess.** Untested by anyone found | An hour, with the phone in hand. No code |
| **3. The developer tunnel** | The newer encrypted tunnel Xcode uses, carried over a VPN, with the backup run inside it | **Reported** to work for app installs over a tailnet. Unknown for backups. pymobiledevice3 documents the tunnel and says most of its commands accept it | Days. Needs a container with network privileges, the phone found without Bonjour, and proof a backup runs through it |
| **4. Back up only at home, manage from anywhere** | Problem A alone | Works today over the tailnet | Nothing |

Route 2 comes first because it needs no code: pommedonjon already takes a
fixed address for a phone and already searches whatever network ranges it
is given. If the phone answers on a VPN subnet, adding that subnet to
**Server → Network range** is the whole change.

Route 3 is the fallback if route 2 fails. It has more moving parts: the
classic tunnel needs root to create a network interface (the container
today runs with no privileges at all), the phone is normally found by
Bonjour, which does not cross a VPN, and the one report of it working
depended on a Mac at home acting as a relay.

## The experiment for route 2

Needs the owner, the phone, and about an hour. It changes one thing on the
phone: a VPN profile is added, which the owner can remove.

1. **On the UniFi gateway,** create a WireGuard VPN server with its own
   subnet, for example `192.168.50.0/24`, and add the phone as a client.
2. **On the phone,** install the WireGuard app and scan the client's QR
   code. Turn WiFi off, so the phone is on mobile data, and connect.
3. **On the gateway,** allow the server (dockyard) to reach the VPN subnet
   on TCP 62078 and 49152 to 65535, and add a source-NAT rule for that
   traffic, the same as the one for the WiFi subnet today.
4. **In pommedonjon,** add `192.168.50.0/24` to Server → Network range,
   open the phone's page and press **Check this phone**.

What the result means:

| Result | Meaning | Next |
|---|---|---|
| "At home: the phone answered. Pairing accepted." | The guess is right. Backups can run over the VPN | Press Back up now with the phone in hand. Then decide the rules for backing up away (below) |
| The phone does not answer | The phone does not accept the old protocol on a VPN interface, or only on WiFi | Repeat step 2 with the phone on a *different* WiFi network instead of mobile data. If that works, backups away need WiFi |
| Still nothing | Route 2 is dead | Route 3 |

Steps 1 and 3 are the owner's to do: they change the router. The app's
check is read-only and shows nothing on the phone.

## If route 2 works, what would change in pommedonjon

Small, and none of it started:

- **Words.** The app says "at home" where it means "reachable". Away, that
  becomes wrong.
- **A rule for away.** A backup over mobile data uses the data allowance
  and the battery. Proposed: away from home, back up only when asked, or
  when the app is opened; never because of a plug-in or an unlock. The
  server can tell home from away by which range the phone answered in.
- **Recognising the phone** (D30) works unchanged: it connects back to
  whatever address the request came from.
- **The VPN has to be up.** The WireGuard app can connect by itself
  whenever the phone is not on the home WiFi. Reported; not tested.

Nothing changes about the passcode: it is typed on the phone, wherever the
phone is.

## Managing from away

Problem A. The server is already on the tailnet, so from any device on the
tailnet the web app opens at the server's tailnet name and port today.
Nothing needs building for that.

What it does need before going further than a private VPN:

- **Sign-in (O27).** The API has none, and it now takes pairings in and
  removes phones (D28). It must never be published to the internet as it
  is. Over a VPN only the owner's devices can reach it, which is the
  protection it has.
- **HTTPS.** The iPhone app is allowed plain HTTP to local addresses only.
  Whether iOS counts a tailnet address as local is not tested. A tailnet
  HTTPS name (Tailscale can issue certificates) would settle it either
  way.
- **Never forward port 62078, or any phone port, from the internet.** The
  pairing is the only thing between that port and the whole phone.

## What does not change, whatever the route

- The passcode, typed on the phone, within a minute.
- The first backup is large; later ones are the changes since.
- The phone decides. Each iOS release can change what it accepts and
  where; everything here was measured or reported on iOS 26.

## Sources

- FINDINGS.md: "From another subnet", "Things the build turned up",
  "Away from home (2026-11-25)".
- [How to remotely iterate & deploy your sideloaded iOS apps over tailnet](https://dev.to/kvnpt/how-to-remotely-iterate-deploy-your-sideloaded-ios-apps-over-tailnet-jak),
  one author's account on iOS 26.5. The source for everything marked
  Reported about the developer tunnel and port 62078 over a tailnet.
- [pymobiledevice3: tunnels on iOS 17 and later](https://doronz88.github.io/pymobiledevice3/guides/ios17-tunnels)
  and its [`remote` commands](https://doronz88.github.io/pymobiledevice3/cli/remote):
  the tunnel needs root except on macOS; `-t wifi` forces a WiFi tunnel.
- [Tailscale: VPN On Demand for iOS](https://tailscale.com/docs/features/client/ios-vpn-on-demand):
  a VPN can connect by itself when the phone leaves a named WiFi network.
