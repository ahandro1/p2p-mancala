/**
 * net.js — the connection core. Wraps Trystero so the rest of the app never
 * talks to the library directly; that keeps the Nostr -> Firebase swap (see
 * config.js) contained to this one file.
 *
 * ---------------------------------------------------------------------------
 * Import path note (verified 2026-07-06):
 * Trystero was restructured into scoped packages (@trystero-p2p/*) at some
 * point in 2025. The plain `trystero` package on npm (currently 0.25.x) is
 * now a thin re-export that forwards everything from `@trystero-p2p/nostr`,
 * i.e. Nostr is the default/plain strategy. Confirmed by inspecting the
 * built module at https://cdn.jsdelivr.net/npm/trystero/+esm, which contains
 * a single `export * from "/npm/@trystero-p2p/nostr@x.y.z/+esm"` line.
 * esm.run is jsDelivr's dedicated ESM endpoint and 301-redirects
 * 'https://esm.run/trystero' -> 'https://cdn.jsdelivr.net/npm/trystero/+esm',
 * so importing plain 'trystero' via esm.run already gets us the Nostr
 * strategy with no subpath needed. We import it explicitly here anyway
 * (rather than relying on the redirect) for clarity and so the Firebase
 * swap documented in config.js is a one-line change to this constant.
 *
 * Confirmed named exports of the Nostr build: joinRoom, selfId,
 * getRelaySockets, subscribe, createEvent, defaultRelayUrls,
 * pauseRelayReconnection, resumeRelayReconnection. There is NO top-level
 * `makeAction` export — it is a method on the room object returned by
 * joinRoom (room.makeAction(actionId)), matching current Trystero docs.
 * ---------------------------------------------------------------------------
 * API-shape verification (2026-07-06), from the actual shipped source
 * (@trystero-p2p/core@0.25.2 dist/room.mjs + dist/actions.mjs, fetched and
 * read directly — not docs/memory):
 *
 *  - room.onPeerJoin / room.onPeerLeave are get/set ACCESSOR PROPERTIES on
 *    the object returned by the room factory (dist/room.mjs, `listeners`
 *    object + `get onPeerJoin()/set onPeerJoin(handler)` pair). Plain
 *    assignment (`room.onPeerJoin = cb`) is therefore the correct and only
 *    way to register — there is no separate call-style registration form,
 *    and the setter replays current peers into a freshly-assigned handler.
 *  - room.makeAction(actionId) (dist/actions.mjs `makeActionImpl`) returns a
 *    SINGLE object (not a [send, receive] tuple) with a `send` method and an
 *    `onMessage` get/set ACCESSOR PROPERTY (same assignable-property pattern
 *    as onPeerJoin/onPeerLeave) — `action.onMessage = handler` is correct.
 *  - action.send(data, options) takes an OPTIONS OBJECT as its second arg
 *    (`{ target, metadata, onProgress, signal }`), not a positional peer-id
 *    arg — `{ target: targetPeerId }` below is correct.
 *  - joinRoom's config is read via plain destructuring/property access
 *    (dist/peer.mjs: `{ trickleIce, rtcConfig, rtcPolyfill, turnConfig }`),
 *    confirming `rtcConfig` is the right top-level config key.
 *  - Custom relay selection (undocumented but present in shipped code) is
 *    `config.relayConfig.urls` (array) / `config.relayConfig.redundancy`
 *    (count) — see dist/utils.mjs `getRelays()`. NOT a top-level
 *    `relayUrls` key. Not currently used; documented here for future
 *    reference only, no behavior change.
 * ---------------------------------------------------------------------------
 */

import { CONFIG } from './config.js';

const STRATEGY_IMPORTS = {
  nostr: 'https://esm.run/trystero',
  firebase: 'https://esm.run/@trystero-p2p/firebase',
};

/** Lazily-resolved, cached import of the active strategy's Trystero build. */
let trysteroModulePromise = null;

/**
 * Dynamically imports the Trystero build matching CONFIG.strategy.
 * Cached after first call so repeated connects don't re-fetch the module.
 * @returns {Promise<any>} the imported Trystero module namespace
 */
export function loadTrystero() {
  if (!trysteroModulePromise) {
    const url = STRATEGY_IMPORTS[CONFIG.strategy];
    if (!url) {
      throw new Error(`net.js: unknown CONFIG.strategy "${CONFIG.strategy}"`);
    }
    trysteroModulePromise = import(/* @vite-ignore */ url);
  }
  return trysteroModulePromise;
}

/**
 * Re-exported selfId — a promise, since it depends on the dynamically
 * imported Trystero module. Most callers should prefer reading
 * `net.selfId` off a connected room wrapper's underlying module via
 * `getSelfId()` below, which resolves once Trystero has loaded.
 */
export async function getSelfId() {
  const trystero = await loadTrystero();
  return trystero.selfId;
}

/**
 * Rooms are cached by roomId so repeated connectRoom() calls for the same
 * room return the same wrapper instead of joining twice.
 * @type {Map<string, Promise<RoomHandle>>}
 */
const roomCache = new Map();

/**
 * Per-room action cache, keyed by actionId. Trystero throws if the same
 * actionId is registered twice on the same room via makeAction(), so we
 * cache the {send, onMessage-registered} pair per (room, actionName).
 * @type {WeakMap<object, Map<string, {send: Function}>>}
 */
const actionCache = new WeakMap();

/**
 * @typedef {Object} RoomHandle
 * @property {any} room - the raw Trystero room object
 * @property {any} trystero - the imported Trystero module namespace
 * @property {function(string, any, (string|string[])=): Promise<void>} send
 *   Send `data` tagged with `actionName` to all peers, or to `targetPeerId`
 *   (single id or array of ids) if provided.
 * @property {function(string, function(any, {peerId: string}): void): (function(): void)} on
 *   Register a handler for incoming messages tagged with `actionName`.
 *   Returns an unsubscribe function that removes just this handler.
 * @property {function(function(string): void): (function(): void)} onPeerJoin
 *   Register a peer-join handler. Returns an unsubscribe function.
 * @property {function(function(string): void): (function(): void)} onPeerLeave
 *   Register a peer-leave handler. Returns an unsubscribe function.
 * @property {function(): string[]} getPeers - connected peer IDs (excludes self)
 * @property {function(string): Promise<number>} ping - round-trip ms to a peer
 * @property {function(): void} leave
 */

/**
 * Connects to (or returns the cached connection to) a Trystero room.
 * @param {string} roomId
 * @returns {Promise<RoomHandle>}
 */
export function connectRoom(roomId) {
  if (roomCache.has(roomId)) return roomCache.get(roomId);

  const handlePromise = (async () => {
    const trystero = await loadTrystero();
    /*
     * Match rooms use a SEPARATE appId namespace from the lobby room.
     * Empirically verified (2026-07-06, live cross-device test): when one
     * page joins two Trystero rooms under the SAME appId, the first room's
     * announcements stop being delivered within seconds (internal state
     * collision in the Nostr strategy), which silently removed every
     * hosting player from the lobby list the moment they created a match.
     * Namespacing match rooms under `${appId}-match` fully isolates the
     * two rooms; both peers derive the same namespace, so compatibility
     * is unaffected. Do NOT "simplify" this back to one appId.
     */
    const appId =
      roomId === CONFIG.lobbyRoomId ? CONFIG.appId : `${CONFIG.appId}-match`;
    const room = trystero.joinRoom(
      { appId, rtcConfig: CONFIG.rtcConfig },
      roomId
    );

    actionCache.set(room, new Map());

    /** @param {string} actionName */
    const getOrMakeAction = (actionName) => {
      const cache = actionCache.get(room);
      let action = cache.get(actionName);
      if (!action) {
        action = room.makeAction(actionName);
        cache.set(actionName, action);
      }
      return action;
    };

    // -----------------------------------------------------------------------
    // Multi-listener dispatch.
    //
    // Trystero exposes a SINGLE assignable handler per action (action.onMessage)
    // and a single room.onPeerJoin/onPeerLeave. A naive wrapper that assigns
    // straight through means a second caller silently clobbers the first — and
    // in this app the diag panel and the game code both attach to the shared
    // lobby room, so they WOULD clobber each other. To let them coexist we
    // register exactly ONE trystero-level handler per action/event that fans
    // the call out to an array of listeners, and hand each caller back an
    // unsubscribe closure that removes just its own entry. Existing callers
    // (diag.js) ignore the returned function, which stays compatible.
    // -----------------------------------------------------------------------

    /** Per-action listener arrays; the fan-out handler is installed lazily. @type {Map<string, Function[]>} */
    const messageListeners = new Map();
    /** @type {Array<function(string): void>} */
    const peerJoinListeners = [];
    /** @type {Array<function(string): void>} */
    const peerLeaveListeners = [];

    // Install one room-level fan-out for peer join/leave. Trystero's setter
    // replays currently-known peers into a freshly-assigned handler, so we
    // assign these once up front and never reassign.
    room.onPeerJoin = (peerId) => {
      // Iterate over a copy so a listener that unsubscribes mid-dispatch
      // (e.g. a one-shot) can't corrupt the loop.
      for (const cb of peerJoinListeners.slice()) cb(peerId);
    };
    room.onPeerLeave = (peerId) => {
      for (const cb of peerLeaveListeners.slice()) cb(peerId);
    };

    /** @type {RoomHandle} */
    const handle = {
      room,
      trystero,

      send(actionName, data, targetPeerId) {
        const action = getOrMakeAction(actionName);
        return action.send(data, targetPeerId ? { target: targetPeerId } : undefined);
      },

      on(actionName, handler) {
        let listeners = messageListeners.get(actionName);
        if (!listeners) {
          listeners = [];
          messageListeners.set(actionName, listeners);
          // Install the single trystero-level fan-out for this action once.
          const action = getOrMakeAction(actionName);
          action.onMessage = (data, meta) => {
            for (const cb of listeners.slice()) cb(data, meta);
          };
        }
        listeners.push(handler);
        return () => {
          const i = listeners.indexOf(handler);
          if (i !== -1) listeners.splice(i, 1);
        };
      },

      onPeerJoin(cb) {
        peerJoinListeners.push(cb);
        return () => {
          const i = peerJoinListeners.indexOf(cb);
          if (i !== -1) peerJoinListeners.splice(i, 1);
        };
      },

      onPeerLeave(cb) {
        peerLeaveListeners.push(cb);
        return () => {
          const i = peerLeaveListeners.indexOf(cb);
          if (i !== -1) peerLeaveListeners.splice(i, 1);
        };
      },

      getPeers() {
        return Object.keys(room.getPeers());
      },

      ping(peerId) {
        return room.ping(peerId);
      },

      leave() {
        room.leave();
        roomCache.delete(roomId);
      },
    };

    return handle;
  })();

  roomCache.set(roomId, handlePromise);
  return handlePromise;
}

/** Connects to the shared public lobby room defined in CONFIG.lobbyRoomId. */
export function connectLobby() {
  return connectRoom(CONFIG.lobbyRoomId);
}

// ---------------------------------------------------------------------------
// Phase 3 — lobby game announcements & join requests.
//
// Protocol (all over the shared lobby room from connectLobby()):
//   'announce'  host  -> broadcast  {gameId, hostName, theme, hasPassword,
//                                     status, createdAt}
//   'joinReq'   guest -> host       {gameId, role, name, passwordHash}  (targeted)
//   'joinRes'   host  -> guest      {gameId, ok, role, reason?}         (targeted)
//
// The lobby room is SHARED with diag.js and (potentially) multiple hosts and
// browsers at once, so every message carries its gameId and every handler
// filters on it. Targeted sends use the announcing host's Trystero peerId,
// which watchLobbies() records from the meta.peerId of each 'announce'.
// ---------------------------------------------------------------------------

/**
 * Tracks the active announcement heartbeat so stopAnnouncing() can cancel it
 * without needing the handle returned by announceGame(). Only one game is
 * ever announced per tab in practice, so a single module-level slot suffices.
 * @type {{gameId: string, stop: function(): void}|null}
 */
let activeAnnouncement = null;

/**
 * Starts broadcasting this game's presence in the public lobby so other
 * players can discover and join it. Broadcasts once immediately, then every
 * CONFIG.heartbeatMs, and immediately whenever the announcement is patched
 * (e.g. a status change from 'waiting' to 'playing').
 * @param {RoomHandle} lobby - a connected lobby room handle (connectLobby())
 * @param {{gameId: string, hostName: string, theme?: string, hasPassword: boolean, status?: 'waiting'|'playing'|'full', createdAt?: number}} info
 * @returns {{updateAnnouncement: function(Object): void, stop: function(): void}}
 *   `updateAnnouncement(patch)` merges `patch` into the announced payload and
 *   broadcasts immediately; `stop()` halts the heartbeat.
 */
export function announceGame(lobby, info) {
  // Any prior announcement from this tab is superseded.
  if (activeAnnouncement) activeAnnouncement.stop();

  const payload = {
    gameId: info.gameId,
    hostName: info.hostName,
    theme: info.theme ?? null,
    hasPassword: !!info.hasPassword,
    status: info.status ?? 'waiting',
    createdAt: info.createdAt ?? Date.now(),
  };

  const broadcast = () => {
    // Fire-and-forget: a transient send failure is corrected by the next
    // heartbeat, so we don't want to reject or throw out of the interval.
    Promise.resolve(lobby.send('announce', payload)).catch(() => {});
  };

  broadcast(); // immediate presence
  const timer = setInterval(broadcast, CONFIG.heartbeatMs);

  const stop = () => {
    clearInterval(timer);
    if (activeAnnouncement && activeAnnouncement.gameId === info.gameId) {
      activeAnnouncement = null;
    }
  };

  /** @param {Object} patch */
  const updateAnnouncement = (patch) => {
    Object.assign(payload, patch);
    broadcast(); // reflect the change without waiting for the next heartbeat
  };

  activeAnnouncement = { gameId: info.gameId, stop };
  return { updateAnnouncement, stop };
}

/**
 * Stops the active announceGame() heartbeat, if any. Safe to call when
 * nothing is being announced.
 * @returns {void}
 */
export function stopAnnouncing() {
  if (activeAnnouncement) activeAnnouncement.stop();
}

/**
 * Subscribes to live lobby updates (games appearing/heartbeating/expiring).
 * Maintains a Map keyed by gameId, refreshed by each incoming 'announce'.
 * An entry is dropped when either (a) no heartbeat arrives within
 * CONFIG.lobbyExpireMs (swept by a periodic timer) or (b) the announcing
 * peer leaves the lobby room. `onUpdate` is invoked with a fresh sorted
 * array on every change (add / update-with-status-change / removal).
 * @param {RoomHandle} lobby - a connected lobby room handle (connectLobby())
 * @param {function(Array<{gameId: string, hostName: string, theme: any, hasPassword: boolean, status: string, createdAt: number, hostPeerId: string, lastSeen: number}>): void} onUpdate
 *   Called with the current full list of known live games whenever it changes.
 * @returns {function(): void} unsubscribe function (removes listeners + timer)
 */
export function watchLobbies(lobby, onUpdate) {
  /** @type {Map<string, any>} */
  const games = new Map();

  const emit = () => {
    // Sort newest-first by createdAt for a stable, sensible browse order.
    const list = Array.from(games.values()).sort(
      (a, b) => b.createdAt - a.createdAt
    );
    onUpdate(list);
  };

  const offAnnounce = lobby.on('announce', (data, meta) => {
    if (!data || typeof data.gameId !== 'string') return;
    const prev = games.get(data.gameId);
    const entry = {
      gameId: data.gameId,
      hostName: data.hostName,
      theme: data.theme ?? null,
      hasPassword: !!data.hasPassword,
      status: data.status ?? 'waiting',
      createdAt: data.createdAt ?? Date.now(),
      hostPeerId: meta.peerId,
      lastSeen: Date.now(),
    };
    games.set(data.gameId, entry);

    // Only re-emit when something the UI cares about actually changed; a bare
    // heartbeat (same status/host) just refreshes lastSeen and stays quiet.
    const changed =
      !prev ||
      prev.status !== entry.status ||
      prev.hostName !== entry.hostName ||
      prev.hasPassword !== entry.hasPassword ||
      prev.hostPeerId !== entry.hostPeerId;
    if (changed) emit();
  });

  // Drop any game whose announcing peer has left the lobby.
  const offLeave = lobby.onPeerLeave((peerId) => {
    let removed = false;
    for (const [gameId, entry] of games) {
      if (entry.hostPeerId === peerId) {
        games.delete(gameId);
        removed = true;
      }
    }
    if (removed) emit();
  });

  // Sweep stale entries (missed heartbeats). Runs at the heartbeat cadence so
  // expiry is detected within roughly one heartbeat of the deadline.
  const sweepTimer = setInterval(() => {
    const now = Date.now();
    let removed = false;
    for (const [gameId, entry] of games) {
      if (now - entry.lastSeen > CONFIG.lobbyExpireMs) {
        games.delete(gameId);
        removed = true;
      }
    }
    if (removed) emit();
  }, CONFIG.heartbeatMs);

  return () => {
    offAnnounce();
    offLeave();
    clearInterval(sweepTimer);
  };
}

/**
 * Requests to join (as player or spectator) a game advertised in the lobby.
 * Resolves the announcing host's peerId from live lobby announcements, sends
 * a targeted 'joinReq', and awaits the matching targeted 'joinRes'. The
 * password (if any) is hashed with hashPassword() before it leaves this tab;
 * plaintext is never sent.
 * @param {RoomHandle} lobby - a connected lobby room handle (connectLobby())
 * @param {{gameId: string, role: 'player'|'spectator', name: string, password?: string}} opts
 * @returns {Promise<{accepted: boolean, role?: string, reason?: 'wrongPassword'|'full'|'gone'|'timeout'}>}
 */
export async function requestJoin(lobby, opts) {
  const { gameId, role, name, password } = opts;

  // Find the host's peerId by listening for the game's announcement. We may
  // already have seen it (announcements heartbeat every few seconds), so also
  // start a short watch and resolve on the first matching announce.
  const hostPeerId = await new Promise((resolve) => {
    let settled = false;
    const finish = (peerId) => {
      if (settled) return;
      settled = true;
      off();
      clearTimeout(findTimer);
      resolve(peerId);
    };
    const off = lobby.on('announce', (data, meta) => {
      if (data && data.gameId === gameId) finish(meta.peerId);
    });
    // If no announcement arrives, treat the game as gone.
    const findTimer = setTimeout(() => finish(null), 10000);
  });

  if (!hostPeerId) {
    return { accepted: false, reason: 'gone' };
  }

  const passwordHash = await hashPassword(gameId, password || '');

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      offRes();
      clearTimeout(timeoutTimer);
      resolve(result);
    };

    const offRes = lobby.on('joinRes', (data) => {
      // Filter to THIS request: same game, and (defensively) our role. Other
      // browsers' responses to other joiners share the lobby action channel.
      if (!data || data.gameId !== gameId) return;
      finish({
        accepted: !!data.ok,
        role: data.role,
        reason: data.ok ? undefined : data.reason,
      });
    });

    const timeoutTimer = setTimeout(
      () => finish({ accepted: false, reason: 'timeout' }),
      10000
    );

    Promise.resolve(
      lobby.send('joinReq', { gameId, role, name, passwordHash }, hostPeerId)
    ).catch(() => {
      // Send failure is indistinguishable from a lost request from the
      // caller's side; let the timeout path report it uniformly.
    });
  });
}

/**
 * Wires the HOST side of the lobby join handshake for a single hosted game.
 * Listens for targeted 'joinReq' messages addressed to this game and answers
 * each with a targeted 'joinRes', enforcing password, seat, and spectator
 * limits. Also drives the announcement's status field (waiting -> playing /
 * full) as seats fill.
 *
 * Seat rules:
 *   - Exactly one guest 'player' seat (P2). The FIRST accepted player claims
 *     it; the announcement flips to status 'playing' and later player requests
 *     are rejected with reason 'full'.
 *   - Up to CONFIG.maxSpectators spectators, accepted while under the cap and
 *     rejected with 'full' once at the cap.
 *   - Password: when hasPassword is true, the request's passwordHash must
 *     equal hashPassword(gameId, password); mismatch is rejected with
 *     'wrongPassword'. When hasPassword is false, the check is skipped.
 *
 * @param {RoomHandle} lobby - a connected lobby room handle (connectLobby())
 * @param {{gameId: string, hostName: string, theme?: string, password?: string}} opts
 * @returns {Promise<{announcement: {updateAnnouncement: function(Object): void, stop: function(): void}, stop: function(): void, getState: function(): {playerTaken: boolean, spectatorCount: number}}>}
 *   Resolves once the expected password hash is computed and listeners are
 *   installed. `stop()` tears down the join listener AND stops announcing.
 */
export async function createHostedGame(lobby, opts) {
  const { gameId, hostName, theme, password } = opts;
  const hasPassword = !!password;
  // Precompute the expected hash once; joinReq handling stays synchronous and
  // therefore race-free against concurrent requests (see message-flow notes).
  const expectedHash = hasPassword
    ? await hashPassword(gameId, password)
    : null;

  const announcement = announceGame(lobby, {
    gameId,
    hostName,
    theme,
    hasPassword,
    status: 'waiting',
  });

  // Authoritative seat state, mutated synchronously inside the joinReq handler.
  let playerTaken = false;
  const spectators = new Set(); // peerIds of accepted spectators

  const offReq = lobby.on('joinReq', (data, meta) => {
    if (!data || data.gameId !== gameId) return; // not our game

    const reply = (ok, replyRole, reason) => {
      Promise.resolve(
        lobby.send(
          'joinRes',
          { gameId, ok, role: replyRole, reason },
          meta.peerId
        )
      ).catch(() => {});
    };

    // 1) Password gate (skipped entirely when the game is open).
    if (hasPassword && data.passwordHash !== expectedHash) {
      reply(false, data.role, 'wrongPassword');
      return;
    }

    // 2) Seat allocation. This block is fully synchronous, so two joinReqs
    //    are processed one-at-a-time in arrival order — the first 'player'
    //    wins the seat and any later 'player' sees playerTaken === true.
    if (data.role === 'player') {
      if (playerTaken) {
        reply(false, 'player', 'full');
        return;
      }
      playerTaken = true;
      reply(true, 'player');
      // Second player present -> the match is on; flip the ad to 'playing'
      // so browsers stop offering the (now-taken) player seat.
      announcement.updateAnnouncement({ status: 'playing' });
      return;
    }

    // role === 'spectator'
    if (spectators.size >= CONFIG.maxSpectators) {
      reply(false, 'spectator', 'full');
      return;
    }
    spectators.add(meta.peerId);
    reply(true, 'spectator');
  });

  // If an accepted spectator's lobby peer leaves, free their slot so a new
  // spectator can take it. (Player seat is handled in the game session, which
  // has reconnect-grace semantics; we don't free it on lobby leave.)
  const offLeave = lobby.onPeerLeave((peerId) => {
    spectators.delete(peerId);
  });

  const stop = () => {
    offReq();
    offLeave();
    announcement.stop();
  };

  return {
    announcement,
    stop,
    getState: () => ({ playerTaken, spectatorCount: spectators.size }),
  };
}

/**
 * Hashes a join password scoped to a specific game so it's never sent or
 * compared in plaintext. Pure and self-contained, so it's implemented now
 * rather than stubbed.
 * @param {string} gameId
 * @param {string} password
 * @returns {Promise<string>} lowercase hex-encoded SHA-256 digest of `gameId:password`
 */
export async function hashPassword(gameId, password) {
  const bytes = new TextEncoder().encode(`${gameId}:${password}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// ---------------------------------------------------------------------------
// Game session — per-match room (connectRoom(gameId)).
//
// Once two players have found each other through the lobby, both sides join a
// dedicated room named by gameId and play there. The design is
// HOST-AUTHORITATIVE:
//
//   - The host is the ONLY node that mutates game state. It applies every
//     move (its own and the guest's) through the injected engine, then
//     broadcasts the full resulting 'state' to everyone. This makes cheating
//     and desync impossible: guests and spectators are pure renderers of
//     whatever 'state' the host last sent.
//   - Guests send a 'move' {pitIndex, seq} and wait for the next 'state'.
//     Spectators never send moves; the host ignores any 'move' from a peer it
//     hasn't handshaked as the player.
//   - Every peer announces itself with 'hello' {name, role} on join so the
//     host can map peerId -> role and enforce the above.
//
// Reconnect: if the guest player's peer drops, the host keeps the room open
// and starts a CONFIG.reconnectGraceMs timer. A fresh 'hello' from a peer
// with the SAME name within the grace window is treated as the same player
// resuming — the host re-sends the current 'state' and cancels the timer. If
// the grace elapses first, onPeerGone fires with role 'player-final'.
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} GameEngine
 * @property {function(any, number): {state: any, events: any[]}} applyMove
 *   Pure move application: (state, pitIndex) -> {state, events}.
 * @property {function(any): number[]} legalMoves
 *   Returns the pit indices the current player may legally sow from.
 */

/**
 * @typedef {Object} GameSession
 * @property {'host'|'guest'|'spectator'} role
 * @property {function(any): void} setEngine - inject/replace the engine
 *   (host-only; ignored for guests/spectators). Call before starting play.
 * @property {function(any, {currentPlayer?: number, gameOver?: boolean, lastMoveEvents?: any[]}=): void} setState
 *   HOST-ONLY: set the authoritative starting state and broadcast it.
 * @property {function(number): void} sendMove - submit a move by pit index.
 *   On the host this applies + broadcasts; on a guest it sends a 'move'.
 * @property {function(string): void} sendChat - send a chat line (trimmed +
 *   sliced to CONFIG.chatMaxLen).
 * @property {function(): void} sendRematch - request/accept a rematch.
 * @property {function((function(any): void)): (function(): void)} onState
 * @property {function((function({text:string,ts:number,from:string}, string): void)): (function(): void)} onChat
 * @property {function((function({name:string,role:string}, string): void)): (function(): void)} onPeerHello
 * @property {function((function(string, string): void)): (function(): void)} onPeerGone
 *   Fires (peerId, role) when a peer leaves. For the guest player, role is
 *   'player' on the initial drop and 'player-final' after grace elapses.
 * @property {function((function(string): void)): (function(): void)} onRematch
 * @property {function(): any} getState - the last known state (host: authoritative).
 * @property {function(string=): void} leaveGame - leave + clean up timers/announcements.
 */

/**
 * Joins the per-match room for `gameId` and returns a session object that
 * speaks the game protocol. Host and guest/spectator share this one entry
 * point; behavior branches on `isHost`.
 *
 * @param {{gameId: string, role: 'player'|'spectator', name: string, isHost: boolean, engine?: GameEngine, hostedGame?: {stop: function(): void}}} opts
 *   - gameId: the match room id (same string the lobby announced).
 *   - role: this peer's role — 'player' or 'spectator'. The host is a player.
 *   - name: display name, used for chat attribution and reconnect matching.
 *   - isHost: true on the authoritative node.
 *   - engine: host-only move engine ({applyMove, legalMoves}). May instead be
 *     supplied later via session.setEngine().
 *   - hostedGame: optional handle from createHostedGame() whose stop() should
 *     be called from leaveGame() (tears down lobby announcement + listeners).
 * @returns {Promise<GameSession>}
 */
export async function joinGameRoom(opts) {
  const { gameId, role, name, isHost } = opts;
  const room = await connectRoom(gameId);

  /** @type {GameEngine|null} */
  let engine = opts.engine || null;
  /** Last authoritative/received state, plus a monotonically increasing seq. */
  let currentState = null;
  let seq = 0;

  // peerId -> {name, role}. Populated from 'hello'. The host consults this to
  // decide whose 'move' to honor.
  /** @type {Map<string, {name: string, role: string}>} */
  const peerInfo = new Map();

  // The peerId currently holding the guest 'player' seat (host bookkeeping).
  /** @type {string|null} */
  let playerPeerId = null;
  // Reconnect-grace timers, keyed by the departed player's display name.
  /** @type {Map<string, ReturnType<typeof setTimeout>>} */
  const graceTimers = new Map();

  // ---- listener registries (each returns an unsubscribe) --------------------
  const stateCbs = [];
  const chatCbs = [];
  const helloCbs = [];
  const goneCbs = [];
  const rematchCbs = [];
  const fan = (arr) => (cb) => {
    arr.push(cb);
    return () => {
      const i = arr.indexOf(cb);
      if (i !== -1) arr.splice(i, 1);
    };
  };
  const dispatch = (arr, ...args) => {
    for (const cb of arr.slice()) cb(...args);
  };

  // ---- wire protocol actions ------------------------------------------------

  const offHello = room.on('hello', (data, meta) => {
    if (!data || typeof data.name !== 'string') return;
    peerInfo.set(meta.peerId, { name: data.name, role: data.role });
    dispatch(helloCbs, data, meta.peerId);

    if (isHost) {
      // A returning player (same name, within grace) resumes the seat.
      if (data.role === 'player') {
        const pending = graceTimers.get(data.name);
        if (pending) {
          clearTimeout(pending);
          graceTimers.delete(data.name);
        }
        // Claim/rebind the player seat. The seat is claimable when it's empty
        // (initial join, or after a drop where we just cleared playerPeerId).
        // A returning player whose grace timer we just cancelled above lands
        // here too, re-taking the seat under their (possibly new) peerId.
        if (playerPeerId === null) {
          playerPeerId = meta.peerId;
        }
      }
      // Bring any newly-arrived peer (guest or spectator) up to date.
      if (currentState) {
        room.send(
          'state',
          {
            board: currentState,
            currentPlayer: currentState.currentPlayer,
            lastMoveEvents: [],
            seq,
            gameOver: isGameOverState(currentState),
          },
          meta.peerId
        );
      }
    }
  });

  const offState = room.on('state', (data) => {
    if (!data) return;
    // Guests/spectators trust the host's state wholesale. Guard against
    // out-of-order delivery using seq (a stale packet is ignored).
    if (typeof data.seq === 'number' && data.seq < seq) return;
    if (typeof data.seq === 'number') seq = data.seq;
    currentState = data.board;
    dispatch(stateCbs, data);
  });

  const offMove = room.on('move', (data, meta) => {
    if (!isHost || !engine || !currentState) return; // only host applies moves
    if (!data || typeof data.pitIndex !== 'number') return;

    const info = peerInfo.get(meta.peerId);
    // Reject moves from anyone who isn't the seated guest player.
    if (!info || info.role !== 'player' || meta.peerId !== playerPeerId) return;

    // Reject out-of-turn moves. Guest player is always P2 (currentPlayer 1).
    if (currentState.currentPlayer !== 1) return;

    applyAndBroadcast(data.pitIndex);
  });

  const offChat = room.on('chat', (data, meta) => {
    if (!data || typeof data.text !== 'string') return;
    dispatch(chatCbs, data, meta.peerId);
  });

  const offRematch = room.on('rematch', (_data, meta) => {
    dispatch(rematchCbs, meta.peerId);
  });

  const offBye = room.on('bye', (data, meta) => {
    handlePeerGone(meta.peerId);
  });

  const offPeerLeave = room.onPeerLeave((peerId) => {
    handlePeerGone(peerId);
  });

  // ---- host move application ------------------------------------------------

  /**
   * HOST-ONLY: apply a pit move through the engine and broadcast the new
   * authoritative state to every peer. Silently ignores illegal moves (the
   * engine throws; a bad move must not crash the session or desync anyone).
   * @param {number} pitIndex
   */
  function applyAndBroadcast(pitIndex) {
    if (!engine || !currentState) return;
    let result;
    try {
      result = engine.applyMove(currentState, pitIndex);
    } catch {
      return; // illegal move -> no state change, no broadcast
    }
    currentState = result.state;
    seq += 1;
    const payload = {
      board: currentState,
      currentPlayer: currentState.currentPlayer,
      lastMoveEvents: result.events,
      seq,
      gameOver: isGameOverState(currentState),
    };
    room.send('state', payload); // broadcast to all
    dispatch(stateCbs, payload); // and update the host's own view
  }

  // ---- peer departure / reconnect grace ------------------------------------

  /** @param {string} peerId */
  function handlePeerGone(peerId) {
    const info = peerInfo.get(peerId);
    if (!info) return;
    peerInfo.delete(peerId);

    if (isHost && info.role === 'player' && peerId === playerPeerId) {
      // Keep the room + state; start the grace window. Report the soft drop.
      playerPeerId = null;
      dispatch(goneCbs, peerId, 'player');
      const timer = setTimeout(() => {
        graceTimers.delete(info.name);
        dispatch(goneCbs, peerId, 'player-final');
      }, CONFIG.reconnectGraceMs);
      graceTimers.set(info.name, timer);
      return;
    }

    // Spectators (and the guest's view of the host leaving) report immediately.
    dispatch(goneCbs, peerId, info.role);
  }

  // ---- send self 'hello' now that listeners are attached --------------------
  // Broadcast once for anyone already connected...
  room.send('hello', { name, role: isHost ? 'player' : role });
  // ...and re-introduce ourselves to every peer that connects AFTER us.
  // Trystero sends only reach peers connected at send time, so the initial
  // broadcast lands on nobody when we're first into the room — which
  // deadlocked host+guest on "waiting for opponent" (verified live
  // 2026-07-06). Repeat hellos are idempotent on the receiving side
  // (peerInfo.set overwrite; main.js host unsubscribes after first player
  // hello), so re-sending per peer-join is safe.
  room.onPeerJoin((peerId) => {
    room.send('hello', { name, role: isHost ? 'player' : role }, peerId);
  });

  // ---- session object -------------------------------------------------------

  /** @type {GameSession} */
  const session = {
    role: isHost ? 'host' : role,

    setEngine(e) {
      if (isHost) engine = e;
    },

    setState(state, meta) {
      if (!isHost) return;
      currentState = meta && meta.currentPlayer != null
        ? { ...state, currentPlayer: meta.currentPlayer }
        : state;
      seq += 1;
      const payload = {
        board: currentState,
        currentPlayer: currentState.currentPlayer,
        lastMoveEvents: (meta && meta.lastMoveEvents) || [],
        seq,
        gameOver: (meta && meta.gameOver) || isGameOverState(currentState),
      };
      room.send('state', payload);
      dispatch(stateCbs, payload);
    },

    sendMove(pitIndex) {
      if (isHost) {
        // Host is P1 (currentPlayer 0); only move on its own turn.
        if (currentState && currentState.currentPlayer === 0) {
          applyAndBroadcast(pitIndex);
        }
        return;
      }
      // Guest: fire the move at the host and await the resulting 'state'.
      room.send('move', { pitIndex, seq });
    },

    sendChat(text) {
      const clean = String(text).trim().slice(0, CONFIG.chatMaxLen);
      if (!clean) return;
      const payload = { text: clean, ts: Date.now(), from: name };
      room.send('chat', payload);
      // Echo locally so the sender sees their own line without a round-trip.
      dispatch(chatCbs, payload, '(self)');
    },

    sendRematch() {
      room.send('rematch', {});
    },

    onState: fan(stateCbs),
    onChat: fan(chatCbs),
    onPeerHello: fan(helloCbs),
    onPeerGone: fan(goneCbs),
    onRematch: fan(rematchCbs),

    getState: () => currentState,

    leaveGame(reason) {
      // Politely tell peers we're going so they don't wait out the grace timer
      // unnecessarily, then tear everything down.
      try {
        room.send('bye', { reason: reason || 'left' });
      } catch {
        /* best effort */
      }
      offHello();
      offState();
      offMove();
      offChat();
      offRematch();
      offBye();
      offPeerLeave();
      for (const t of graceTimers.values()) clearTimeout(t);
      graceTimers.clear();
      if (opts.hostedGame && typeof opts.hostedGame.stop === 'function') {
        opts.hostedGame.stop();
      }
      if (isHost) stopAnnouncing();
      room.leave();
    },
  };

  return session;
}

/**
 * Best-effort game-over probe used when the injected engine doesn't hand us an
 * explicit flag. Recognizes the engine's 14-length pits layout (either row of
 * six empty ends the game). Returns false for any shape it doesn't understand,
 * leaving authority with whatever gameOver the caller passed to setState().
 * @param {any} state
 * @returns {boolean}
 */
function isGameOverState(state) {
  const pits = state && state.pits;
  if (!Array.isArray(pits) || pits.length !== 14) return false;
  const rowEmpty = (idxs) => idxs.every((i) => pits[i] === 0);
  return rowEmpty([0, 1, 2, 3, 4, 5]) || rowEmpty([7, 8, 9, 10, 11, 12]);
}
