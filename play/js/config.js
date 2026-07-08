/**
 * config.js — single source of truth for tunable constants across the app.
 *
 * Everything here is a plain value (no functions, no imports) so it can be
 * read by any module without side effects.
 */

export const CONFIG = {
  /** App/build version, surfaced in the diag panel footer. Bump per release. */
  version: '0.1.0',

  /**
   * Trystero appId — namespaces our peers away from other Trystero apps
   * using the same public relays. Keep stable across releases so existing
   * players can still find each other; change only if you want to hard-cut
   * old clients off from new ones.
   */
  appId: 'p2p-mancala-v1',

  /**
   * Signaling strategy in use. Trystero supports multiple interchangeable
   * transports for peer discovery/signaling (the actual game data always
   * flows peer-to-peer over WebRTC once connected).
   *
   * Current: 'nostr' — free, serverless, no API key, uses public Nostr
   * relays for discovery. This is the zero-cost default for Phase 1+.
   *
   * ---------------------------------------------------------------------
   * FUTURE: swapping to Firebase Realtime Database signaling
   * ---------------------------------------------------------------------
   * If Nostr relays ever prove flaky/slow for players, we can swap to
   * Firebase's free tier as the signaling transport instead:
   *
   *   1. Change `strategy` below to 'firebase'.
   *   2. Fill in the `firebase.databaseURL` field with your project's
   *      Realtime Database URL, e.g.
   *      'https://your-project-id-default-rtdb.firebaseio.com'.
   *   3. js/net.js reads CONFIG.strategy and picks the matching Trystero
   *      import at connect time:
   *        - 'nostr'    -> import('https://esm.run/trystero')
   *        - 'firebase' -> import('https://esm.run/@trystero-p2p/firebase')
   *      No other call sites need to change — connectRoom()'s returned
   *      wrapper shape is identical regardless of strategy.
   *
   * Nothing else in the codebase should need to change for this swap;
   * that contract is the whole point of centralizing it here + in net.js.
   * ---------------------------------------------------------------------
   */
  strategy: 'nostr',

  /**
   * Optional config for the 'firebase' strategy (see comment above).
   * Unused while strategy === 'nostr'; left blank/placeholder until needed.
   */
  firebase: {
    databaseURL: '',
  },

  /**
   * WebRTC ICE server list handed to Trystero's joinRoom({ rtcConfig }).
   * STUN (Google, free/public) resolves most direct connections. TURN
   * (Open Relay Project, free tier) relays traffic when direct P2P is
   * blocked by strict NATs/firewalls — essential for reliable play across
   * arbitrary home/mobile networks.
   */
  /*
   * NOTE (2026-07-06): the Open Relay Project static TURN endpoint
   * (openrelay.metered.ca / openrelayproject:openrelayproject) is DEAD —
   * the hostname no longer resolves (ICE error 701 on every attempt), so
   * the dead entries were removed. STUN-only handles most home/wifi
   * pairings; strict mobile-carrier CGNAT pairings need real TURN again.
   * Free fix: create a free metered.ca account (no credit card), copy the
   * TURN credentials from its dashboard, and add them back here as
   * { urls, username, credential } entries.
   */
  rtcConfig: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun.cloudflare.com:3478' },
    ],
  },

  /** Room ID used for the shared public lobby (Phase 3 game discovery). */
  lobbyRoomId: 'lobby',

  /** How often a hosted game announces itself alive in the lobby (ms). */
  heartbeatMs: 4000,

  /** A lobby entry is considered stale/removed after this much silence (ms). */
  lobbyExpireMs: 10000,

  /** Grace period to allow a dropped peer to rejoin an in-progress game (ms). */
  reconnectGraceMs: 30000,

  /** Max number of simultaneous spectators allowed per game. */
  maxSpectators: 4,

  /** Max character length for a single chat message. */
  chatMaxLen: 280,

  /**
   * Visual theme catalog. Mirrors the id lists baked into ui.js's
   * BOARD_THEMES / STONE_THEMES (the authoritative source — ui.js owns the
   * label/swatch/CSS-variable details; this is just the id list for any
   * other module that needs to know what themes exist without importing
   * ui.js). Keep in sync by hand if ui.js's catalogs change.
   */
  themes: {
    board: ['arcade', 'walnut', 'midnight-neon'],
    stones: ['candy', 'glass', 'neon', 'frog', 'gems'],
  },
};
