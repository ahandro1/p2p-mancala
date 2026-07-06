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
 * @property {function(string, any, (string|string[])=): Promise<void>} send
 *   Send `data` tagged with `actionName` to all peers, or to `targetPeerId`
 *   (single id or array of ids) if provided.
 * @property {function(string, function(any, {peerId: string}): void): void} on
 *   Register a handler for incoming messages tagged with `actionName`.
 * @property {function(function(string): void): void} onPeerJoin
 * @property {function(function(string): void): void} onPeerLeave
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
    const room = trystero.joinRoom(
      { appId: CONFIG.appId, rtcConfig: CONFIG.rtcConfig },
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

    /** @type {RoomHandle} */
    const handle = {
      room,
      trystero,

      send(actionName, data, targetPeerId) {
        const action = getOrMakeAction(actionName);
        return action.send(data, targetPeerId ? { target: targetPeerId } : undefined);
      },

      on(actionName, handler) {
        const action = getOrMakeAction(actionName);
        action.onMessage = (data, meta) => handler(data, meta);
      },

      onPeerJoin(cb) {
        room.onPeerJoin = cb;
      },

      onPeerLeave(cb) {
        room.onPeerLeave = cb;
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
// Phase 3 stubs — lobby game announcements & join requests.
// Signatures are locked in now so Phase 1/2 code can be written against them.
// ---------------------------------------------------------------------------

/**
 * Starts broadcasting this game's presence in the public lobby so other
 * players can discover and join it. Re-announces on CONFIG.heartbeatMs.
 * @param {RoomHandle} lobby - a connected lobby room handle (connectLobby())
 * @param {{gameId: string, hostName: string, hasPassword: boolean, spectatorsAllowed: boolean}} info
 * @returns {void}
 */
export function announceGame(lobby, info) {
  throw new Error('Phase 3: not implemented');
}

/**
 * Stops any in-flight announceGame() heartbeat for the current game.
 * @returns {void}
 */
export function stopAnnouncing() {
  throw new Error('Phase 3: not implemented');
}

/**
 * Subscribes to live lobby updates (games appearing/heartbeating/expiring).
 * @param {RoomHandle} lobby - a connected lobby room handle (connectLobby())
 * @param {function(Array<{gameId: string, hostName: string, hasPassword: boolean, lastSeen: number}>): void} onUpdate
 *   Called with the current full list of known live games whenever it changes.
 * @returns {function(): void} unsubscribe function
 */
export function watchLobbies(lobby, onUpdate) {
  throw new Error('Phase 3: not implemented');
}

/**
 * Requests to join (as player or spectator) a game advertised in the lobby.
 * @param {RoomHandle} lobby - a connected lobby room handle (connectLobby())
 * @param {{gameId: string, role: 'player'|'spectator', name: string, password?: string}} opts
 * @returns {Promise<{accepted: boolean, reason?: string}>}
 */
export function requestJoin(lobby, opts) {
  throw new Error('Phase 3: not implemented');
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
