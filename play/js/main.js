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
  setInteractive,
  showChat,
  appendChat,
  renderMenu,
  renderLobbyList,
  renderWaiting,
  renderGameHud,
  renderGameOver,
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
    theme: null,
    disconnectToast: null,
    gameOverShown: false,
    rematchState: { selfWantsRematch: false, peerWantsRematch: false },
  };
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
  goToMenu();
}

// ---------------------------------------------------------------------------
// Menu screen
// ---------------------------------------------------------------------------

/** Returns to the menu, tearing down any active session/lobby watch first. */
function goToMenu() {
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
  renderWaiting({ code: app.gameId, onCancel: handleCancelWaiting });

  const theme = readStoredTheme();

  const lobby = await connectLobby();
  app.lobby = lobby;

  const hostedGame = await createHostedGame(lobby, {
    gameId: app.gameId,
    hostName: app.name,
    theme: theme && theme.board,
    password: opts.password || undefined,
  });
  app.hostedGame = hostedGame;

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

  // Start the game once the guest player's hello arrives.
  const offHello = session.onPeerHello((info) => {
    if (info.role !== 'player') return; // spectators don't start the match
    app.opponentName = info.name;
    offHello();
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
  // WORKAROUND: ui.js's renderLobbyList() returns early when games.length===0
  // (the "No open games" empty state), before it reaches the code that wires
  // #lobby-back's onclick — so the Back button is left dead whenever the
  // lobby is empty (which includes this very first call, and any time the
  // list drops back to zero games). Wire it directly here so Back always
  // works regardless of ui.js's internal early return.
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
 * @param {string} gameId
 * @param {string} [password]
 */
async function handleJoinGame(gameId, password) {
  const name = currentPlayerName();
  const lobby = app.lobby || (await connectLobby());
  app.lobby = lobby;

  const result = await requestJoin(lobby, {
    gameId,
    role: 'player',
    name,
    password,
  });

  if (!result.accepted) {
    alert(joinFailureMessage(result.reason));
    return;
  }

  teardownLobbyWatch();
  app.name = name;
  app.gameId = gameId;
  app.role = 'player';
  app.myPlayer = 1;

  const session = await joinGameRoom({
    gameId,
    role: 'player',
    name,
    isHost: false,
  });
  app.session = session;
  wireSessionCommon(session);

  showScreen('screen-wait');
  renderWaiting({ code: gameId, onCancel: handleCancelWaiting });

  // The host pushes 'state' as soon as our hello arrives; onState (wired in
  // wireSessionCommon) will call enterGameScreen() the first time it fires.
}

/** @param {string} gameId */
async function handleWatchGame(gameId) {
  const name = currentPlayerName();
  const lobby = app.lobby || (await connectLobby());
  app.lobby = lobby;

  const result = await requestJoin(lobby, {
    gameId,
    role: 'spectator',
    name,
  });

  if (!result.accepted) {
    alert(joinFailureMessage(result.reason));
    return;
  }

  teardownLobbyWatch();
  app.name = name;
  app.gameId = gameId;
  app.role = 'spectator';
  app.myPlayer = null;

  const session = await joinGameRoom({
    gameId,
    role: 'spectator',
    name,
    isHost: false,
  });
  app.session = session;
  wireSessionCommon(session);

  showScreen('screen-wait');
  renderWaiting({ code: gameId, onCancel: handleCancelWaiting });
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
  });

  session.onRematch(() => {
    app.rematchState.peerWantsRematch = true;
    tryStartRematch();
  });
}

function handleIncomingState(data) {
  const state = data.board;
  const isInitialSync = !data.lastMoveEvents || data.lastMoveEvents.length === 0;

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
      showGameOver(state);
    }
  };

  if (isInitialSync) {
    afterRender();
  } else {
    animateEvents(data.lastMoveEvents, {
      onDone: afterRender,
    });
  }
}

function enterGameScreen() {
  showScreen('screen-game');
  showChat({
    messages: [],
    onSend: (text) => {
      if (app.session) app.session.sendChat(text);
    },
  });
}

function updateHud(state) {
  renderGameHud({
    names: hudNamesFor(),
    scores: [state.pits[6], state.pits[13]],
    currentPlayer: state.currentPlayer,
    myPlayer: app.myPlayer,
    role: app.role === 'host' ? 'player' : app.role,
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

function showGameOver(state) {
  if (app.gameOverShown) return;
  app.gameOverShown = true;
  setInteractive([], () => {});

  const gameWinner = engine.winner(state);
  showScreen('screen-over');
  renderGameOver({
    winner: gameWinner,
    myPlayer: app.myPlayer,
    score: [state.pits[6], state.pits[13]],
    names: hudNamesFor(),
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
