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

GitHub Pages serves static files only, so there is no game server. The two
browsers talk directly over a **WebRTC data channel**:

- The host's browser registers a random six-character room code with a public
  PeerJS broker. The broker's only job is to introduce the two peers.
- Once introduced, all game traffic — cards, clues, guesses, the target position —
  flows **directly between the two browsers**, encrypted with DTLS as WebRTC
  requires. It never reaches the broker or any server we run.
- The host's browser is authoritative for game state. Snapshots sent to the
  guesser have the target position **stripped out** until the reveal, so the
  answer isn't sitting in the other client's memory.
- The page is served over HTTPS, sets a restrictive Content-Security-Policy,
  and stores nothing — no cookies, no accounts, no analytics.

Room codes are drawn from a 31-character alphabet (no look-alike characters),
giving about 900 million combinations. A room only accepts one guest; a third
connection is turned away.

## Running locally

No build step and no dependencies to install:

```sh
python3 -m http.server 8000
```

Then open `http://localhost:8000` in two tabs or on two devices.

## Layout

```
index.html            markup and CSP
assets/styles.css     dark theme
assets/spectrums.js   the card deck
assets/game.js        pure rules: scoring, bands, shuffle
assets/dial.js        SVG dial, screen animation, drag + keyboard input
assets/net.js         PeerJS host/join, reconnect, error mapping
assets/app.js         screens, host-authoritative state, message handling
vendor/peerjs.min.js  vendored so no third-party script loads at runtime
```

## Accessibility

The dial is focusable and operable from the keyboard (arrow keys to nudge,
Shift for larger steps, Home/End for the extremes), exposes `role="slider"`
with live values, and all motion is disabled under `prefers-reduced-motion`.

## Credit

*Wavelength* is a game by Wolfgang Warsch, Alex Hague and Justin Vickers,
published by CMYK. This is an unofficial fan implementation for playing with a
friend remotely, with an original spectrum list.
