/**
 * main.js — single entry point (loaded via <script type="module"> in index.html).
 * Boots the app, shows a brief boot screen, then drives the whole app state
 * machine: boot -> menu -> (create -> waiting -> game) | (browse -> lobby ->
 * join/watch -> game) -> game-over -> (rematch -> game | leave -> menu).
 *
 * This module owns all screen transitions and all wiring between net.js
 * (connection/session) and ui.js (rendering/input). engine.js is imported
 * directly so the host can construct fresh game state and validate/apply
 * moves through the session's host-authoritative path.
 */

import { initDiag } from './diag.js';
import * as engine from './engine.js';
import {
  connectLobby,
  watchLobbies,
  requestJoin,
  createHostedGame,
  joinGameRoom,
  stopAnnouncing,
} from './net.js';
import {
  initUI,
  renderBoard,
  animateEvents,
  skipCurrentAnimation,
  setInteractive,
  lockInteractivity,
  showChat,
  appendChat,
  renderMenu,
  renderLobbyList,
  renderWaiting,
  updateWaitingStatus,
  updateWaitingElapsed,
  showWaitingRetry,
  renderGameHud,
  renderGameOver,
  showResignConfirm,
  hideResignConfirm,
} from './ui.js';

/**
 * Diag panel is now opt-in via ?debug=1 only (Phase 1's FORCE_DIAG is
 * retired). Normal boot goes straight to the menu.
 */
const FORCE_DIAG = false;

/** All top-level screen elements, keyed by their id's suffix (e.g. "menu"). */
const SCREEN_IDS = [
  'screen-boot',
  'screen-menu',
  'screen-lobby',
  'screen-wait',
  'screen-game',
  'screen-over',
  'diag-panel',
];

/** Unambiguous alphabet for generated game codes: no 0/o/1/l/i. */
const GAMEID_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const GAMEID_LENGTH = 6;

/**
 * Hides every `.screen` element and shows only the one matching `id`.
 * Exported so it stays reusable/inspectable the way Phase 1 left it.
 * @param {string} id - element id of the screen to show, e.g. 'screen-menu'
 * @returns {void}
 */
export function showScreen(id) {
  for (const screenId of SCREEN_IDS) {
    const el = document.getElementById(screenId);
    if (!el) continue;
    el.hidden = screenId !== id;
  }
}

/**
 * True if the page was loaded with `?debug=1` (or `&debug=1`) in the URL.
 * @returns {boolean}
 */
function wantsDebug() {
  try {
    return new URLSearchParams(location.search).get('debug') === '1';
  } catch {
    return false;
  }
}

/** @returns {string} a 6-char unambiguous lowercase alphanumeric game code. */
function generateGameId() {
  let id = '';
  for (let i = 0; i < GAMEID_LENGTH; i++) {
    id += GAMEID_ALPHABET[Math.floor(Math.random() * GAMEID_ALPHABET.length)];
  }
  return id;
}

// ---------------------------------------------------------------------------
// App-level mutable state for the current match. Reset on every return to
// the menu. Kept in one place so every screen handler can read/update it
// without threading params through every function.
// ---------------------------------------------------------------------------

/** @type {{
 *   session: import('./net.js').GameSession|null,
 *   hostedGame: {stop: function(): void}|null,
 *   lobby: any|null,
 *   unwatchLobbies: (function(): void)|null,
 *   myPlayer: 0|1|null,
 *   role: 'host'|'player'|'spectator'|null,
 *   name: string,
 *   opponentName: string,
 *   gameId: string|null,
 *   theme: {board:string, stones:string}|null,
 *   disconnectToast: HTMLElement|null,
 *   gameOverShown: boolean,
 *   rematchState: {selfWantsRematch: boolean, peerWantsRematch: boolean}
 * }} */
let app = freshAppState();

function freshAppState() {
  return {
    session: null,
    hostedGame: null,
    lobby: null,
    unwatchLobbies: null,
    myPlayer: null,
    role: null,
    name: '',
    opponentName: 'Opponent',
    gameId: null,
    joinPassword: undefined,
    theme: null,
    disconnectToast: null,
    gameOverShown: false,
    rematchState: { selfWantsRematch: false, peerWantsRematch: false },
  };
}

// ---------------------------------------------------------------------------
// Waiting-screen telemetry
//
// Drives ui.js's wait-screen status line + elapsed counter across the
// connection lifecycle (lobby -> peer connecting -> connected -> game). The
// elapsed counter also doubles as remote debugging telemetry while chasing
// the cross-device waiting-screen deadlock — a stuck screen now visibly
// reports how long it's been stuck and at what stage.
// ---------------------------------------------------------------------------

/** @type {ReturnType<typeof setInterval>|null} */
let waitElapsedTimer = null;
/** Wall-clock start of the current wait, for the elapsed counter. */
let waitStartedAt = 0;

/** Starts the wait-screen elapsed-counter ticker. Call once per wait screen entry. */
function startWaitTelemetry() {
  stopWaitTelemetry();
  waitStartedAt = Date.now();
  updateWaitingElapsed(null);
  waitElapsedTimer = setInterval(() => {
    const secs = Math.floor((Date.now() - waitStartedAt) / 1000);
    if (secs >= 15) {
      updateWaitingElapsed(`still trying — ${secs}s`);
    }
  }, 1000);
}

/** Stops the wait-screen elapsed-counter ticker and hides the elapsed line. */
function stopWaitTelemetry() {
  if (waitElapsedTimer) {
    clearInterval(waitElapsedTimer);
    waitElapsedTimer = null;
  }
  updateWaitingElapsed(null);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot() {
  showScreen('screen-boot');

  if (FORCE_DIAG || wantsDebug()) {
    showScreen('diag-panel');
    await initDiag();
    return;
  }

  initUI();
  wirePageLifecycle();
  goToMenu();
}

// ---------------------------------------------------------------------------
// Page lifecycle (Task 3: iOS Safari suspends timers + WebRTC when Safari is
// backgrounded or the screen locks). We can't prevent that, but on RETURN to
// visible we re-sync so the player isn't left staring at a silently-dead UI.
//
//   - In the lobby: the sweep/heartbeat timers were frozen while hidden, so the
//     list may be stale (dead games lingering, or fresh ones missing). We tear
//     the watch down and re-establish it, forcing a clean re-sync.
//   - In a match/waiting session: if peers dropped while we were away (very
//     common on iOS — the WebRTC connection is torn down on background), show
//     the existing disconnect UI immediately instead of hanging silently.
//
// NOTE ON HOSTING FROM MOBILE: the announce heartbeat is a plain setInterval
// (net.js announceGame) that keeps firing as long as the tab is foregrounded
// and the screen is ON — nothing it depends on is killed by merely being the
// active tab. A LOCKED phone, however, suspends JS timers + WebRTC entirely, so
// hosting necessarily pauses while the screen is off; that is inherent to
// mobile Safari and cannot be worked around from a web page. It resumes when
// the phone is unlocked and this handler re-syncs.
// ---------------------------------------------------------------------------

/** Last observed match-room peer count, to detect drops across a background. */
let lastKnownPeerCount = 0;

/** True once the visibilitychange listener is installed (install once). */
let lifecycleWired = false;

function wirePageLifecycle() {
  if (lifecycleWired) return;
  lifecycleWired = true;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') {
      // Going hidden: snapshot the peer count so we can detect a drop on return.
      if (app.session && typeof app.session.getPeerCount === 'function') {
        lastKnownPeerCount = app.session.getPeerCount();
      }
      return;
    }
    handleReturnToVisible();
  });
}

/** Which screen is currently shown (by SCREEN_IDS suffix), or null. */
function activeScreenId() {
  for (const id of SCREEN_IDS) {
    const el = document.getElementById(id);
    if (el && !el.hidden) return id;
  }
  return null;
}

function handleReturnToVisible() {
  const screen = activeScreenId();

  // Lobby: force a clean re-sync of the (possibly stale) game list.
  if (screen === 'screen-lobby' && app.lobby) {
    teardownLobbyWatch();
    app.unwatchLobbies = watchLobbies(app.lobby, (games) => {
      const mapped = games.map((g) => ({
        id: g.gameId,
        hostName: g.hostName,
        theme: g.theme,
        hasPassword: g.hasPassword,
        allowSpectators: g.allowSpectators,
        status: g.status === 'playing' ? 'playing' : 'open',
      }));
      renderLobbyList(mapped, {
        onJoin: handleJoinGame,
        onWatch: handleWatchGame,
        onBack: goToMenu,
      });
    });
    return;
  }

  // In a session (game or still waiting): if a peer dropped while we were away,
  // surface the disconnect UI now rather than leaving the player hanging.
  if (app.session && typeof app.session.getPeerCount === 'function') {
    const now = app.session.getPeerCount();
    if (now < lastKnownPeerCount) {
      if (enteredGame && !app.gameOverShown) {
        // Mid-game: reuse the standard disconnect toast.
        showDisconnectToast(
          `${app.opponentName || 'Opponent'} may have disconnected — waiting for them to reconnect…`,
        );
      } else if (!enteredGame && activeScreenId() === 'screen-wait'
                 && (app.role === 'player' || app.role === 'spectator')) {
        // Guest/spectator still on the waiting screen: the host peer we were
        // handshaking with is gone. Offer retry instead of an endless spinner.
        // (A HOST waiting for an opponent has no host to retry against — its
        //  own heartbeat resumes automatically, so we leave its screen as-is.)
        stopWaitTelemetry();
        clearJoinBoardTimer();
        showWaitingRetry({
          message: 'Lost the connection to the host while the app was in the background.',
          onRetry: () => retryJoin(),
          onBack: goToMenu,
        });
      }
    }
    lastKnownPeerCount = now;
  }
}

// ---------------------------------------------------------------------------
// Menu screen
// ---------------------------------------------------------------------------

/** Returns to the menu, tearing down any active session/lobby watch first. */
function goToMenu() {
  stopWaitTelemetry();
  clearJoinBoardTimer();
  showWaitingRetry(null);
  teardownMatch();
  teardownLobbyWatch();
  app = freshAppState();
  showScreen('screen-menu');
  renderMenu({
    onCreate: handleCreateGame,
    onBrowse: handleBrowse,
  });
}

/**
 * @param {{name:string, password:string, allowSpectators:boolean}} opts
 */
async function handleCreateGame(opts) {
  app.name = opts.name || 'Player';
  app.gameId = generateGameId();
  app.role = 'host';
  app.myPlayer = 0;

  showScreen('screen-wait');
  renderWaiting({ role: 'host', statusText: 'Getting things ready…', onCancel: handleCancelWaiting });
  startWaitTelemetry();

  const theme = readStoredTheme();

  const lobby = await connectLobby();
  app.lobby = lobby;

  const hostedGame = await createHostedGame(lobby, {
    gameId: app.gameId,
    hostName: app.name,
    theme: theme && theme.board,
    password: opts.password || undefined,
    allowSpectators: opts.allowSpectators,
  });
  app.hostedGame = hostedGame;

  updateWaitingStatus('In the lobby — players can find your game');

  const session = await joinGameRoom({
    gameId: app.gameId,
    role: 'player',
    name: app.name,
    isHost: true,
    engine,
    hostedGame,
  });
  app.session = session;

  wireSessionCommon(session);

  // A match-room peer connecting (guest or spectator) means someone found the
  // game and is handshaking; the 'hello' below confirms who they are.
  const offWaitPeerJoin = session.onPeerJoin(() => {
    updateWaitingStatus('Opponent connecting…');
  });

  // Start the game once the guest player's hello arrives.
  const offHello = session.onPeerHello((info) => {
    if (info.role !== 'player') return; // spectators don't start the match
    app.opponentName = info.name;
    offHello();
    offWaitPeerJoin();
    const state = engine.newGame();
    session.setState(state, { currentPlayer: state.currentPlayer, lastMoveEvents: [] });
    enterGameScreen();
  });
}

function handleCancelWaiting() {
  goToMenu();
}

// ---------------------------------------------------------------------------
// Browse / lobby screen
// ---------------------------------------------------------------------------

async function handleBrowse() {
  showScreen('screen-lobby');
  renderLobbyList([], { onBack: goToMenu });
  // WORKAROUND (source now fixed): ui.js's renderLobbyList() used to return
  // early when games.length===0 (the "No open games" empty state) BEFORE
  // wiring #lobby-back's onclick, leaving Back dead whenever the lobby was
  // empty. That's fixed at the source now (Back is wired before the early
  // return in ui.js), so this is harmless redundant belt-and-suspenders
  // wiring — left in place rather than removed to avoid churn.
  const backBtn = document.getElementById('lobby-back');
  if (backBtn) backBtn.onclick = () => goToMenu();

  const lobby = await connectLobby();
  app.lobby = lobby;

  app.unwatchLobbies = watchLobbies(lobby, (games) => {
    // watchLobbies() entries use {gameId, status:'waiting'|'playing', ...};
    // renderLobbyList() expects {id, status:'open'|'playing', ...}. Adapt here.
    const mapped = games.map((g) => ({
      id: g.gameId,
      hostName: g.hostName,
      theme: g.theme,
      hasPassword: g.hasPassword,
      allowSpectators: g.allowSpectators,
      status: g.status === 'playing' ? 'playing' : 'open',
    }));
    renderLobbyList(mapped, {
      onJoin: handleJoinGame,
      onWatch: handleWatchGame,
      onBack: goToMenu,
    });
    // Re-apply the same workaround after every re-render, since a non-empty
    // list correctly wires Back but a subsequent update back to zero games
    // would hit the early-return again and leave it unwired.
    if (backBtn) backBtn.onclick = () => goToMenu();
  });
}

function teardownLobbyWatch() {
  if (app.unwatchLobbies) {
    app.unwatchLobbies();
    app.unwatchLobbies = null;
  }
}

/**
 * How long we wait for the host's board to arrive before surfacing the retry
 * UI instead of hanging forever. Covers the whole guest handshake: WebRTC peer
 * connect + 'hello' round-trip + first 'state'. 30s per the UX spec.
 */
const JOIN_BOARD_TIMEOUT_MS = 30000;

/** @type {ReturnType<typeof setTimeout>|null} join-timeout handle. */
let joinBoardTimer = null;

function clearJoinBoardTimer() {
  if (joinBoardTimer) {
    clearTimeout(joinBoardTimer);
    joinBoardTimer = null;
  }
}

/**
 * @param {string} gameId
 * @param {string} [password]
 */
async function handleJoinGame(gameId, password) {
  await joinFlow({ gameId, password, role: 'player', myPlayer: 1 });
}

/** @param {string} gameId */
async function handleWatchGame(gameId) {
  await joinFlow({ gameId, role: 'spectator', myPlayer: null });
}

/**
 * Shared guest join/watch flow with clear lifecycle status + a hard timeout.
 *
 * Status line progression surfaced to the player on the waiting screen:
 *   1. "Connecting to host…"            — request accepted, joining the room,
 *                                          no match-room peer yet.
 *   2. "Connected — waiting for the board…" — WebRTC peer is up (onPeerJoin),
 *                                          waiting on the host's first 'state'.
 *   3. (game screen)                    — first 'state' arrives; the queue's
 *                                          enterGameScreen() takes over.
 *
 * If the board hasn't arrived within JOIN_BOARD_TIMEOUT_MS, we stop hanging and
 * show a friendly retry panel ("Try again" / "Back"). Retry tears the session
 * down cleanly (leaveGame() -> room.leave() -> roomCache.delete, so connectRoom
 * can't hand back the stale dead room) and re-runs this same flow.
 *
 * @param {{gameId:string, password?:string, role:'player'|'spectator', myPlayer:0|1|null}} opts
 */
async function joinFlow(opts) {
  const { gameId, password, role, myPlayer } = opts;
  const name = currentPlayerName();
  const lobby = app.lobby || (await connectLobby());
  app.lobby = lobby;

  const result = await requestJoin(lobby, { gameId, role, name, password });
  if (!result.accepted) {
    alert(joinFailureMessage(result.reason));
    return;
  }

  teardownLobbyWatch();
  app.name = name;
  app.gameId = gameId;
  app.role = role;
  app.myPlayer = myPlayer;
  app.joinPassword = password; // remembered so retry can re-run the same join

  showScreen('screen-wait');
  renderWaiting({ role, statusText: 'Connecting to host…', onCancel: handleCancelWaiting });
  startWaitTelemetry();

  const session = await joinGameRoom({ gameId, role, name, isHost: false });
  app.session = session;
  wireSessionCommon(session);

  // WebRTC peer is up (fires before the slower 'hello'/'state' handshake).
  const offWaitPeerJoin = session.onPeerJoin(() => {
    updateWaitingStatus('Connected — waiting for the board…');
    offWaitPeerJoin();
  });

  // Hard timeout: if no board (first onState -> enterGameScreen) lands in time,
  // surface retry instead of hanging. enterGameScreen() clears this timer.
  clearJoinBoardTimer();
  joinBoardTimer = setTimeout(() => {
    if (enteredGame) return; // board already arrived
    stopWaitTelemetry();
    showWaitingRetry({
      message: "Couldn't reach the host. They may have left, or the connection is blocked.",
      onRetry: () => retryJoin(),
      onBack: goToMenu,
    });
  }, JOIN_BOARD_TIMEOUT_MS);
}

/**
 * Retries a timed-out guest join. Tears down the dead session/room first (so
 * net.js's roomCache doesn't return the stale room on rejoin), clears the
 * retry UI, and re-runs joinFlow with the same parameters.
 */
async function retryJoin() {
  const gameId = app.gameId;
  const role = app.role === 'spectator' ? 'spectator' : 'player';
  const myPlayer = app.role === 'spectator' ? null : 1;
  const password = app.joinPassword;
  if (!gameId) { goToMenu(); return; }

  clearJoinBoardTimer();
  showWaitingRetry(null);
  // Clean teardown: leaveGame() -> room.leave() -> roomCache.delete(gameId),
  // guaranteeing connectRoom() builds a FRESH room on the retry rather than
  // reusing the cached (now-dead) one.
  teardownMatch();
  enteredGame = false;

  await joinFlow({ gameId, password, role, myPlayer });
}

/** @param {string|undefined} reason */
function joinFailureMessage(reason) {
  switch (reason) {
    case 'wrongPassword': return 'Wrong password.';
    case 'full': return 'That game is already full.';
    case 'gone': return 'That game is no longer available.';
    case 'timeout': return 'Could not reach the host — try again.';
    default: return 'Could not join that game.';
  }
}

function currentPlayerName() {
  try {
    return localStorage.getItem('mancala.name') || 'Player';
  } catch {
    return 'Player';
  }
}

function readStoredTheme() {
  try {
    const raw = localStorage.getItem('mancala.theme');
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Game screen — shared wiring for host/player/spectator
// ---------------------------------------------------------------------------

/** True once the first real state render has happened (vs. the wait screen). */
let enteredGame = false;

function wireSessionCommon(session) {
  enteredGame = false;
  app.gameOverShown = false;
  app.rematchState = { selfWantsRematch: false, peerWantsRematch: false };
  resetStateQueue();

  session.onState((data) => {
    handleIncomingState(data);
  });

  session.onChat((msg, fromPeerId) => {
    // net.js echoes our own sent chat locally with fromPeerId === '(self)',
    // AND ui.js's chat form already optimistically appends what we typed.
    // Suppress that echo here to avoid a duplicate line. Also guard on name
    // in case some future path re-delivers our own message by identity.
    if (fromPeerId === '(self)') return;
    if (msg.from === app.name) return;
    const role = msg.from === app.opponentName ? 'opponent' : 'spectator';
    appendChat({ from: msg.from, text: msg.text, role });
  });

  session.onPeerGone((peerId, role) => {
    if (role === 'player') {
      showDisconnectToast(`${app.opponentName || 'Opponent'} disconnected — waiting 30s for them to reconnect…`);
    } else if (role === 'player-final') {
      hideDisconnectToast();
      // Remaining player wins by forfeit.
      if (app.myPlayer !== null) {
        showGameOverForForfeit();
      }
    }
    // Spectators leaving needs no UI reaction.
  });

  session.onPeerHello((info) => {
    if (info.role === 'player') {
      // A reconnecting player clears any disconnect toast.
      hideDisconnectToast();
    }
    // Keep the visibilitychange baseline fresh so a later background/return
    // correctly detects a genuine drop rather than false-positiving.
    if (typeof session.getPeerCount === 'function') {
      lastKnownPeerCount = session.getPeerCount();
    }
  });

  // Track live peer count so the page-lifecycle handler can detect a drop that
  // happened while the app was backgrounded.
  session.onPeerJoin(() => {
    if (typeof session.getPeerCount === 'function') {
      lastKnownPeerCount = session.getPeerCount();
    }
  });

  session.onRematch(() => {
    app.rematchState.peerWantsRematch = true;
    tryStartRematch();
  });
}

// ---------------------------------------------------------------------------
// Serial, loss-proof incoming-state queue (Task 1: rapid-move race)
//
// ROOT CAUSE of the bug: handleIncomingState() used to call animateEvents()
// directly for every 'state' that arrived. animateEvents() is async, and
// nothing serialized the calls — so when a player took two moves fast (or an
// extra-turn chain landed two authoritative states close together), a second
// 'state' could arrive MID-ANIMATION and kick off a SECOND animateEvents()
// concurrently. The two share ui.js module globals (currentState, animating,
// skipToEnd, the travelling sow pile), so they corrupt each other and the
// board can end up out of sync with the engine's real output.
//
// FIX: funnel every incoming state through ONE queue drained serially. We
// never run two animations at once, we never drop the final authoritative
// state, and if states stack up we fast-forward the current animation, snap
// to the intermediate state instantly, and animate only the LATEST one.
//
// Ordering: states carry a monotonically increasing `seq` from net.js. We
// ignore any state whose seq is <= the last one we've already applied (stale /
// duplicate), and keep the queue seq-sorted so out-of-order delivery is
// corrected before we render.
// ---------------------------------------------------------------------------

/** @type {any[]} pending authoritative states awaiting serial processing. */
let stateQueue = [];
/** Highest seq we've already applied to the board (drops stale/duplicate states). */
let lastAppliedSeq = -Infinity;

/** True while an animateEvents() call is in flight (guards against overlap). */
let animationInFlight = false;

function handleIncomingState(data) {
  if (!data) return;
  // Drop stale/duplicate states by seq. Initial-sync states from net.js carry
  // a seq too; only strictly-newer states are worth queueing.
  if (typeof data.seq === 'number' && data.seq <= lastAppliedSeq) return;
  stateQueue.push(data);
  // Keep seq-ordered (states without a seq keep insertion order, sorted last).
  stateQueue.sort((a, b) => {
    const sa = typeof a.seq === 'number' ? a.seq : Number.MAX_SAFE_INTEGER;
    const sb = typeof b.seq === 'number' ? b.seq : Number.MAX_SAFE_INTEGER;
    return sa - sb;
  });

  // If a state landed while an animation is running, cut that animation short
  // so the queue advances to the newer state promptly. skipCurrentAnimation()
  // synchronously fires the running animation's onDone, which re-enters
  // drainStateQueue() — hence the re-entrancy guard inside it.
  if (animationInFlight) {
    skipCurrentAnimation();
    return;
  }
  drainStateQueue();
}

/**
 * Drains the queue, never overlapping animations. Re-entrancy-safe: the ONLY
 * place an animation is kicked off is here, guarded by `animationInFlight`; the
 * animation's onDone re-enters this function to pull the next state. Between
 * states we snap (no animation) any that already have a newer state queued
 * behind them — so a burst collapses to "snap the intermediates, animate only
 * the newest" without ever running two animations at once.
 *
 * The loop runs synchronously through every snap-able (intermediate) state,
 * then either animates the final state (returning; onDone re-enters) or stops.
 */
function drainStateQueue() {
  if (animationInFlight) return; // an animation owns the drain; it will re-enter

  while (stateQueue.length > 0) {
    const data = stateQueue[0];

    const isIntermediate = stateQueue.length > 1;
    const hasEvents = data.lastMoveEvents && data.lastMoveEvents.length > 0;
    const animate = hasEvents && !isIntermediate;

    // Commit this state now (before rendering) so re-entrant pushes see the
    // updated lastAppliedSeq and the queue head is consistent.
    stateQueue.shift();
    if (typeof data.seq === 'number') lastAppliedSeq = data.seq;

    if (animate) {
      animationInFlight = true;
      applyStateToScreens(data, () => {
        animationInFlight = false;
        // Continue draining whatever arrived while we animated.
        drainStateQueue();
      }, true);
      return; // yield to the animation; onDone re-enters
    }

    // Snap this intermediate/eventless state instantly and keep looping.
    applyStateToScreens(data, null, false);
  }
}

/**
 * Renders one authoritative state onto every screen, optionally animating the
 * move that produced it. `animate` selects animated vs. instant application.
 * @param {any} data - the authoritative state payload from net.js
 * @param {() => void} onAnimationDone - called after the animation finishes
 *   (only when animate === true)
 * @param {boolean} animate
 */
function applyStateToScreens(data, onAnimationDone, animate) {
  const state = data.board;

  if (!enteredGame) {
    enteredGame = true;
    enterGameScreen();
  } else if (!data.gameOver && app.gameOverShown) {
    // A fresh (non-game-over) state after a game-over screen was shown means
    // a rematch just started (host called setState() with a new newGame()).
    // Every role — not just the host, who already flips the screen itself in
    // tryStartRematch() — needs to leave #screen-over and return to the board.
    app.gameOverShown = false;
    showScreen('screen-game');
  }

  const afterRender = () => {
    renderBoard(state);
    updateHud(state);
    updateInteractivity(state);
    if (data.gameOver) {
      // A resignation carries an explicit winner + who conceded; pass those
      // through so the over-screen shows "[name] resigned" for every role.
      showGameOver(state, data.resigned
        ? { resignedBy: data.resignedBy, winner: data.winner }
        : null);
    }
  };

  if (animate) {
    animateEvents(data.lastMoveEvents, {
      onDone: () => {
        afterRender();
        if (typeof onAnimationDone === 'function') onAnimationDone();
      },
    });
  } else {
    // Snap: render instantly, no animation.
    afterRender();
  }
}

/** Reset the state queue on every new session/match (called from wireSessionCommon). */
function resetStateQueue() {
  stateQueue = [];
  animationInFlight = false;
  lastAppliedSeq = -Infinity;
}

function enterGameScreen() {
  stopWaitTelemetry();
  clearJoinBoardTimer();
  showWaitingRetry(null);
  showScreen('screen-game');
  showChat({
    messages: [],
    onSend: (text) => {
      if (app.session) app.session.sendChat(text);
    },
  });
}

function updateHud(state) {
  // Only the two seated players may resign, and only while the game is still
  // active (not already over). Spectators never get the button.
  const isPlayer = app.role === 'host' || app.role === 'player';
  const canResign = isPlayer && !app.gameOverShown;
  renderGameHud({
    names: hudNamesFor(),
    scores: [state.pits[6], state.pits[13]],
    currentPlayer: state.currentPlayer,
    myPlayer: app.myPlayer,
    role: app.role === 'host' ? 'player' : app.role,
    canResign,
    onResign: handleResignClick,
  });
}

/**
 * Opens the resign confirmation. On confirm, sends the resign through the
 * session (guest -> host 'resign'; host ends the game directly). The
 * authoritative game-over 'state' then drives every client's over-screen.
 */
function handleResignClick() {
  if (!app.session) return;
  const isPlayer = app.role === 'host' || app.role === 'player';
  if (!isPlayer || app.gameOverShown) return;
  showResignConfirm({
    opponentName: app.opponentName || 'your opponent',
    onConfirm: () => {
      if (app.session) app.session.sendResign();
    },
  });
}

/** Names in [P1, P2] board order regardless of local role. */
function hudNamesFor() {
  if (app.myPlayer === 0) return [app.name, app.opponentName];
  if (app.myPlayer === 1) return [app.opponentName, app.name];
  // Spectator: host is always P1, guest player is always P2.
  return [app.opponentName === 'Opponent' ? 'Host' : app.opponentName, app.opponentName];
}

function updateInteractivity(state) {
  if (state.currentPlayer === undefined) return;
  const isMyTurn =
    (app.role === 'host' && state.currentPlayer === 0) ||
    (app.role === 'player' && state.currentPlayer === 1);

  if (!isMyTurn || !app.session) {
    setInteractive([], () => {});
    return;
  }

  const legal = engine.legalMoves(state);
  setInteractive(legal, (pit) => {
    app.session.sendMove(pit);
  });
}

// ---------------------------------------------------------------------------
// Disconnect toast (simple DOM; no CSS file changes allowed, minimal inline
// styling only).
// ---------------------------------------------------------------------------

function showDisconnectToast(text) {
  hideDisconnectToast();
  const el = document.createElement('div');
  el.textContent = text;
  el.setAttribute('role', 'status');
  el.style.position = 'fixed';
  el.style.left = '50%';
  el.style.bottom = '1.5rem';
  el.style.transform = 'translateX(-50%)';
  el.style.background = 'rgba(20, 20, 20, 0.9)';
  el.style.color = '#fff';
  el.style.padding = '0.6em 1.2em';
  el.style.borderRadius = '8px';
  el.style.fontFamily = 'sans-serif';
  el.style.fontSize = '0.9rem';
  el.style.zIndex = '9999';
  el.style.maxWidth = '90vw';
  el.style.textAlign = 'center';
  document.body.appendChild(el);
  app.disconnectToast = el;
}

function hideDisconnectToast() {
  if (app.disconnectToast) {
    app.disconnectToast.remove();
    app.disconnectToast = null;
  }
}

// ---------------------------------------------------------------------------
// Game over / rematch
// ---------------------------------------------------------------------------

/**
 * @param {any} state
 * @param {{resignedBy?:string, winner?:0|1}|null} [resign] - resignation info
 *   when the game ended by concession; null for a normal end-of-game.
 */
function showGameOver(state, resign = null) {
  if (app.gameOverShown) return;
  app.gameOverShown = true;
  setInteractive([], () => {});
  hideResignConfirm();

  // A resignation dictates the winner explicitly; otherwise derive from score.
  const gameWinner = resign && resign.winner != null
    ? resign.winner
    : engine.winner(state);
  showScreen('screen-over');
  renderGameOver({
    winner: gameWinner,
    myPlayer: app.myPlayer,
    score: [state.pits[6], state.pits[13]],
    names: hudNamesFor(),
    resignedBy: resign ? resign.resignedBy : null,
    onRematch: handleRematchClick,
    onLeave: handleLeave,
  });
}

function showGameOverForForfeit() {
  if (app.gameOverShown) return;
  app.gameOverShown = true;
  setInteractive([], () => {});

  showScreen('screen-over');
  renderGameOver({
    winner: app.myPlayer,
    myPlayer: app.myPlayer,
    score: app.session && app.session.getState()
      ? [app.session.getState().pits[6], app.session.getState().pits[13]]
      : [0, 0],
    names: hudNamesFor(),
    onRematch: handleRematchClick,
    onLeave: handleLeave,
  });
}

function handleRematchClick() {
  if (app.role === 'spectator' || !app.session) return;
  app.rematchState.selfWantsRematch = true;
  app.session.sendRematch();
  tryStartRematch();
}

function tryStartRematch() {
  if (!app.rematchState.selfWantsRematch || !app.rematchState.peerWantsRematch) return;
  if (app.role !== 'host') return; // only the host resets + broadcasts

  app.rematchState = { selfWantsRematch: false, peerWantsRematch: false };
  app.gameOverShown = false;
  // Host status flow: the announcement is already 'playing' from when the
  // guest first joined (createHostedGame flips it on player accept) and
  // stays that way through a rematch — nothing to patch here.
  const state = engine.newGame();
  app.session.setState(state, { currentPlayer: state.currentPlayer, lastMoveEvents: [] });
  showScreen('screen-game');
}

function handleLeave() {
  teardownMatch();
  goToMenu();
}

function teardownMatch() {
  hideDisconnectToast();
  if (app.session) {
    try { app.session.leaveGame('left'); } catch { /* best effort */ }
    app.session = null;
  }
  if (app.hostedGame) {
    // leaveGame() above already calls hostedGame.stop() when present, but
    // guard here too in case a session was never created (e.g. cancelled
    // while still connecting).
    try { app.hostedGame.stop(); } catch { /* already stopped */ }
    app.hostedGame = null;
  }
  if (app.role === 'host') {
    stopAnnouncing();
  }
}

boot();
