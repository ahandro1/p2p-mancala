# P2P Mancala

Serverless peer-to-peer multiplayer Mancala (Kalah rules) running entirely in the browser. Play with friends without accounts, servers, or sign-ups—just open a room and share the link.

**Live:** https://ahandro1.github.io/p2p-mancala/play/ | **Diagnostics:** https://ahandro1.github.io/p2p-mancala/play/?debug=1

## What's Inside

- **Peer-to-peer gameplay** via WebRTC over Trystero; Nostr relays for zero-cost signaling
- **Lobbies hosted in the player's browser** — the host's tab is the room authority; guests connect peer-to-peer
- **Spectator support** — up to 4 spectators per game with live chat
- **Mobile-first UI** with 3 board themes and 4 stone sets
- **Free, forever** — GitHub Pages hosting, no credits required

## Features

- **Lobby browser** — browse & join public games or create password-protected rooms
- **Optional lobby passwords** — private game sessions
- **In-game chat** — all players + spectators talk in real time
- **Board animations** — stone placement, pit counters update live
- **Multiple themes** — 3 board themes (Arcade, Walnut, Midnight Neon) + 4 stone sets (Candy, Glass, Neon, Frog)
- **Responsive design** — tiles across desktop, tablet, and mobile

## How It Works

### Architecture

**Files:**
- `play/index.html` — entry point
- `play/js/config.js` — tunable constants (Trystero appId, TURN servers, theme catalogs)
- `play/js/engine.js` — Kalah game rules engine
- `play/js/net.js` — Trystero wrapper (Nostr → WebRTC); host-authoritative message routing
- `play/js/ui.js` — lobby, board, theme picker, chat UI
- `play/js/main.js` — bootstrap app state machine
- `play/js/diag.js` — debug panel (connection/relay status, peer discovery, echo tests)
- `play/css/base.css`, `board.css`, `themes.css` — layout, board, theme overrides
- `tests/engine.test.js` — 17 test cases for game rules

**Network model:**
- **Signaling**: Players broadcast their presence on a shared Nostr relay (public, free, serverless). Each room gets its own Nostr channel (`appId/lobby` for room discovery, `appId/match/{roomId}` for in-game).
- **Data**: Once peers discover each other, WebRTC data channels carry all game messages point-to-point (the relays are only for initial discovery).
- **Authority**: The host (first player to create/join a room) validates all game moves. Guests send intent, host echoes back the canonical game state.

**AppId namespacing** (see `net.js` header comments):
- All peers using the same Trystero `appId` find each other on shared relays.
- Lobby and match rooms are _separate Nostr channels_ scoped by room ID: lobby discovery is in the `lobby` room, active games are in `match/{roomId}`.
- Changing `appId` in `config.js` creates a hard cutoff from old clients.

## Running Locally

### Quick Start

Any static server works:
```bash
python -m http.server 8737
# or
npx http-server -p 8737
```
Then open http://localhost:8737/play/

### Testing

Run the engine test suite:
```bash
node --test tests/engine.test.js
```

**Important caveat:** Two browser tabs on the *same machine* often will not connect to each other (ISP/router loopback restrictions). Test with:
- Two different browsers (Chrome + Firefox), or
- Two different devices (laptop + phone), or
- For reliable results: browser A on device A, browser B on device B

### Custom Skins

Board themes live in `play/css/themes.css` and use a CSS custom-property contract:

```css
:root {
  --board-bg: #f2c400;
  --pit-bg: radial-gradient(...);
  --stone-image: url('assets/stones.png');
  --stone-image: url('assets/animation.gif'); /* GIF or animated WebP work */
}
```

Add new themes with a `[data-theme="myname"]` selector and override the above variables. Static and animated images (GIF / animated WebP) are supported under `play/assets/`.

## Embedding in Webflow

The game is a static site deployed to GitHub Pages. Embed it in Webflow via `<iframe>`:

1. Add a **Custom Element** with tag `iframe` and attributes:
   - `src`: `https://ahandro1.github.io/p2p-mancala/play/` (trailing slash required)
   - `allow`: `fullscreen`
   - `loading`: `lazy`
   - `title`: `Mancala`

2. Size with a Webflow class: `width: 100%; height: 85vh; border: none`

3. Test with the diagnostics panel (`?debug=1`) on both sides — all checks should go green.

See `webflow/snippets.md` for detailed Webflow instructions and HTMLtoFlow conversion steps.

## Known Limitations & TODOs

- **No TURN server** — gameplay works well on home WiFi and most mobile networks (STUN handles direct connections). Strict NAT/corporate firewall pairings may fail to connect. Fix: create a free [metered.ca](https://metered.ca) account, copy the TURN credentials, and paste them into `config.js` `rtcConfig.iceServers`.

- **10-minute asset cache** — GitHub Pages caches files up to 10 minutes (`max-age=600`). After deployment, browsers may serve stale game code. Workaround: test in a private/incognito window, which bypasses the cache.

- **Single strategy implementation** — currently Nostr only. Firebase Realtime Database signaling is documented in `config.js` as a one-line swap if Nostr relays prove unreliable.

## Zero-Cost Infrastructure

- **Game host**: Your browser (no dedicated server).
- **Signaling**: Free public Nostr relays.
- **Deployment**: GitHub Pages ($0, unlimited bandwidth).
- **No credit card required**, ever.

---

**Version:** 0.1.0 | **License:** (see repo) | **Built with:** Trystero, Kalah rules engine, pure vanilla JS/CSS
