# Wavelength — two-player online

A browser version of the party game *Wavelength*, built for exactly two people.
One player sees a hidden target on a spectrum and gives a clue; the other moves
the dial to where they think it is. You score together.

**Play:** https://abigailecarrera-crypto.github.io/wavelength/

## How a round works

1. A **spectrum** card appears — two opposing ideas, e.g. *Cold ↔ Hot*.
2. The **Psychic** lifts the screen, sees where the target landed, and lowers it again.
   (The clue box stays locked until the screen is down, same as the physical game.)
3. The Psychic types one clue that sits at that exact point on the spectrum.
4. The **Guesser** drags the dial and locks in an answer. The Psychic watches
   the needle move in real time but can't say anything more.
5. The screen swings open and you score.
6. Roles swap; play the chosen number of rounds and try to beat your best total.

## Scoring

Two profiles, chosen when you create the room:

| Profile | Bands (left → right) | Best round |
|---|---|---|
| Official | 2 · 3 · 4 · 3 · 2 | 4 |
| Simple | 1 · 3 · 1 | 3 |

The target wedge covers a fixed slice of the dial and can sit anywhere, including
partly off the rim — a target near an edge is simply harder to score on, exactly
as on the physical board.

## How the connection works

GitHub Pages serves static files only, so there is no game server. Both
browsers make **outbound WebSocket connections** to public MQTT relays and
exchange messages on a shared topic.

**Why not peer-to-peer?** The first version used WebRTC, and it failed to
connect for real players on different networks. WebRTC needs a TURN relay
whenever either side is behind a symmetric NAT or a strict firewall — common on
home routers, office wifi and mobile data — and every free public TURN server
has now shut down (verified: they no longer resolve). Outbound WSS works from
essentially any network, so this connects where WebRTC silently would not.

Routing through someone else's relay would normally mean handing them your
game, so:

- The **topic name is a SHA-256 hash** of the room code, not the code itself —
  watching the relay doesn't reveal live codes to walk into.
- Every payload is **AES-256-GCM encrypted** under a key derived from the room
  code with PBKDF2 (120k iterations). A relay sees an opaque topic carrying
  opaque bytes, and undecryptable traffic is simply ignored.
- The host's browser stays authoritative for game state, and snapshots sent to
  the guesser have the target position **stripped out** until the reveal.
- The page is served over HTTPS with a restrictive Content-Security-Policy, and
  stores nothing — no cookies, no accounts, no analytics.

Public relays drop messages under load, so the transport adds its own
reliability on top of MQTT QoS 0: game messages are sequenced, retransmitted
until acknowledged, delivered in order, and de-duplicated. Each client connects
to **all three relays at once**, so the two players only need one relay in
common — which removes the "each side failed over to a different server" trap.
Game traffic then rides a single relay known to reach the partner, with retries
fanning out to all of them.

Room codes are drawn from a 31-character alphabet (no look-alike characters),
giving about 900 million combinations. A room only accepts one guest; a third
connection is turned away.

### Trade-off, stated plainly

A relay can see *that* two anonymous clients are exchanging traffic, and how
much. It cannot read the contents. That is a real change from the WebRTC
version, which leaked nothing to any middleman but frequently refused to
connect at all. Reliability won.

## Running locally

No build step and no dependencies to install:

```sh
python3 -m http.server 8000
```

Then open `http://localhost:8000` in two tabs or on two devices.

## Layout

```
index.html               markup and CSP
assets/styles.css        dark theme
assets/spectrums.js      the card deck
assets/game.js           pure rules: scoring, bands, shuffle
assets/dial.js           SVG dial, screen animation, drag + keyboard input
assets/mqtt.js           minimal MQTT 3.1.1 over WebSocket (no dependencies)
assets/net.js            rooms, encryption, ordering, retransmission
assets/app.js            screens, host-authoritative state, message handling
test/relay-test.html     open in a browser; runs unit + live relay tests
```

## Tests

Open `test/relay-test.html` (served over http, not `file://`). It checks the
MQTT varint and string encoding, then stands up a real host and guest against
the live relays and asserts that 40 rapid messages all arrive **in order**, that
a 30 KB payload survives packet fragmentation, that unicode round-trips, and
that a wrong room code cannot join.

## Accessibility

The dial is focusable and operable from the keyboard (arrow keys to nudge,
Shift for larger steps, Home/End for the extremes), exposes `role="slider"`
with live values, and all motion is disabled under `prefers-reduced-motion`.

## Credit

*Wavelength* is a game by Wolfgang Warsch, Alex Hague and Justin Vickers,
published by CMYK. This is an unofficial fan implementation for playing with a
friend remotely, with an original spectrum list.
