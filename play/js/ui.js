/**
 * ui.js — board rendering, animation, theming, chat, and screen views.
 *
 * Consumes the pure state/events produced by engine.js and renders them into
 * the screen <section>s in play/index.html. Kept import-free of net.js: every
 * view takes plain-data props + callbacks so the integration phase can wire
 * them to the network layer without this file knowing anything about peers.
 *
 * ---------------------------------------------------------------------------
 * Board index map (matches engine.js):
 *   0-5   = Player 1 pits      6  = Player 1 store
 *   7-12  = Player 2 pits      13 = Player 2 store
 * ---------------------------------------------------------------------------
 *
 * DEV PREVIEW HOOK: load play/index.html?uidev=1 to render the game screen
 * with a demo mid-game state, a sample animation, and fake chat. See the
 * bottom of this file. Harmless in production. NOTE: main.js currently has
 * FORCE_DIAG=true, so normal boot routes everything to the diag panel; the
 * uidev hook works AROUND that by self-invoking here and force-showing
 * #screen-game itself (it does not touch main.js).
 */

/* ==========================================================================
   Theme catalog (kept here so the menu picker + setTheme() agree). The
   authoritative colors live in css/themes.css; these are just id + label +
   a swatch gradient for the picker preview.
   ========================================================================== */

/** @type {{id:string,label:string,board:string,edge:string}[]} */
const BOARD_THEMES = [
  { id: 'arcade', label: 'Arcade', board: 'radial-gradient(120% 140% at 50% 0%, #ffe066, #f2c400 45%, #d99e00)', edge: '#a86e00' },
  { id: 'walnut', label: 'Walnut', board: 'radial-gradient(120% 140% at 50% 0%, #8a5f3a, #6b4a2f 55%, #4a3220)', edge: '#2c1d10' },
  { id: 'midnight-neon', label: 'Neon', board: 'linear-gradient(180deg, #1a2244, #10162e)', edge: '#00e5ff' },
];

/** @type {{id:string,label:string,hue:string,outline:string,spec:string}[]} */
const STONE_THEMES = [
  { id: 'candy', label: 'Candy', hue: '#e02a2a', outline: '#1a1a2e', spec: '#ffffffcc' },
  { id: 'glass', label: 'Glass', hue: '#a7c7e7', outline: '#ffffff55', spec: '#ffffff' },
  { id: 'neon', label: 'Neon', hue: '#00ffa3', outline: '#05070f', spec: '#ffffff' },
  { id: 'frog', label: 'Frog', hue: '#4caf3a', outline: '#1c3a12', spec: '#ffffffcc' },
];

const DEFAULT_THEME = { board: 'arcade', stones: 'candy' };
const STORAGE_THEME = 'mancala.theme';
const STORAGE_NAME = 'mancala.name';

/** Which stone hue var to use for a pit's Nth stone (candy cycling). */
const STONE_HUE_VARS = ['--stone-c1', '--stone-c2', '--stone-c3', '--stone-c4', '--stone-c5'];

/** Animation timing (ms). Overridable via animateEvents(events,{speed}). */
const HOP_MS = 200;         // one sow hop
const CAPTURE_MS = 420;     // capture sweep flash
const SWEEP_MS = 500;       // end-game gather
const EXTRA_MS = 1100;      // extra-turn splash

/* ==========================================================================
   Module state
   ========================================================================== */

/** Cached DOM refs, filled by initUI(). */
const dom = {
  /** @type {HTMLElement|null} */ board: null,
  /** @type {HTMLElement|null} */ hud: null,
  /** @type {HTMLElement|null} */ chat: null,
};

/** Last rendered engine state, so a mid-animation skip can snap to final. */
let currentState = null;

/** Chat unread counter (badge on the drawer handle). */
let chatUnread = 0;

/** True while an animation sequence is running (enables tap-to-skip). */
let animating = false;

/** Set by animateEvents; calling it fast-forwards to the final state. */
let skipToEnd = null;

/* ==========================================================================
   Small utilities
   ========================================================================== */

/** @param {string} id @returns {HTMLElement|null} */
const $ = (id) => document.getElementById(id);

/**
 * HTML-escape a string for safe insertion as text content in innerHTML.
 * @param {string} s
 * @returns {string}
 */
function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Deterministic pseudo-random in [0,1) seeded by two integers. Used so a
 * pit's stone scatter is stable across renders (no jitter on re-render).
 * @param {number} a
 * @param {number} b
 * @returns {number}
 */
function seededRand(a, b) {
  let h = (a * 73856093) ^ (b * 19349663);
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * Deterministic scatter offset (percentage of pit box) for stone `i` of a pit.
 * Returns {sx, sy} percentages relative to pit center.
 * @param {number} pitIndex
 * @param {number} stoneIndex
 * @returns {{sx:number, sy:number}}
 */
function stoneOffset(pitIndex, stoneIndex) {
  const r = 12 + seededRand(pitIndex, stoneIndex) * 12;           // radius %
  const ang = seededRand(pitIndex * 7 + 1, stoneIndex * 13 + 3) * Math.PI * 2;
  // Pits are wide ellipses: scatter more horizontally, less vertically so
  // stones stay inside the oval instead of spilling out the top/bottom.
  return { sx: Math.cos(ang) * r * 1.9, sy: Math.sin(ang) * r * 0.85 };
}

/** @returns {Promise<void>} resolves after `ms`, but early if skip fires. */
function wait(ms) {
  return new Promise((resolve) => {
    if (!animating) return resolve();
    const t = setTimeout(resolve, ms);
    // If skipToEnd fires, the sequence resolves its own way; this timer is
    // harmless because the loop checks `animating` between steps.
    void t;
  });
}

/* ==========================================================================
   initUI
   ========================================================================== */

/**
 * One-time setup: caches DOM refs inside #screen-game, wires chat + tap-to-skip,
 * applies the persisted (or default) theme. Safe to call more than once.
 * @returns {void}
 */
export function initUI() {
  dom.board = $('board');
  dom.hud = $('game-hud');
  dom.chat = $('chat');

  applyStoredTheme();
  wireChat();
  wireSkipTap();
}

/** Load persisted theme (or default) and apply it. */
function applyStoredTheme() {
  let theme = DEFAULT_THEME;
  try {
    const raw = localStorage.getItem(STORAGE_THEME);
    if (raw) theme = { ...DEFAULT_THEME, ...JSON.parse(raw) };
  } catch { /* ignore */ }
  setTheme(theme);
}

/** Tapping the board during animation skips to the final state. */
function wireSkipTap() {
  if (!dom.board || dom.board.dataset.skipWired) return;
  dom.board.dataset.skipWired = '1';
  const skip = () => { if (animating && skipToEnd) skipToEnd(); };
  dom.board.addEventListener('click', skip);
  dom.board.addEventListener('touchstart', skip, { passive: true });
}

/* ==========================================================================
   Board rendering
   ========================================================================== */

/**
 * Renders a full board state instantly (no animation). Builds pit/store/stone
 * DOM the first time, then updates counts + stone piles on subsequent calls.
 * @param {import('./engine.js').GameState} state
 * @returns {void}
 */
export function renderBoard(state) {
  if (!dom.board) dom.board = $('board');
  if (!dom.board) return;
  currentState = state;
  ensureBoardStructure();

  for (let pit = 0; pit < 14; pit++) {
    if (pit === 6 || pit === 13) {
      renderStore(pit, state.pits[pit]);
    } else {
      renderPit(pit, state.pits[pit]);
    }
  }
  renderHudTurn(state.currentPlayer);
}

/** Build the 12 pits + 2 stores once. */
function ensureBoardStructure() {
  if (dom.board.dataset.built) return;
  dom.board.dataset.built = '1';
  dom.board.innerHTML = '';

  // Stores.
  dom.board.appendChild(makeStore(6, 'p1'));
  dom.board.appendChild(makeStore(13, 'p2'));

  // Pits (DOM order irrelevant; CSS grid-area places them).
  for (const pit of [0, 1, 2, 3, 4, 5, 7, 8, 9, 10, 11, 12]) {
    const el = document.createElement('div');
    el.className = 'pit';
    el.dataset.pit = String(pit);
    const stones = document.createElement('div');
    stones.className = 'pit-stones';
    el.appendChild(stones);
    const count = document.createElement('span');
    count.className = 'pit-count';
    count.dataset.count = String(pit);
    el.appendChild(count);
    dom.board.appendChild(el);
  }
}

/** @param {number} idx @param {string} side @returns {HTMLElement} */
function makeStore(idx, side) {
  const el = document.createElement('div');
  el.className = `store store--${side}`;
  el.dataset.pit = String(idx);
  const stones = document.createElement('div');
  stones.className = 'store-stones';
  el.appendChild(stones);
  const count = document.createElement('span');
  count.className = 'store-count';
  count.dataset.count = String(idx);
  el.appendChild(count);
  return el;
}

/** Update one pit's count badge + scattered stones. */
function renderPit(pit, n) {
  const el = dom.board.querySelector(`.pit[data-pit="${pit}"]`);
  if (!el) return;
  el.querySelector('.pit-count').textContent = String(n);
  paintStones(el.querySelector('.pit-stones'), pit, n, false);
}

/** Update one store's count badge + stones. */
function renderStore(idx, n) {
  const el = dom.board.querySelector(`.store[data-pit="${idx}"]`);
  if (!el) return;
  el.querySelector('.store-count').textContent = String(n);
  paintStones(el.querySelector('.store-stones'), idx, n, true);
}

/**
 * Rebuild the scattered stone divs in a container. Deterministic offsets keep
 * placement stable. Stores show a capped pile (perf) but the badge shows the
 * true count.
 * @param {HTMLElement} container
 * @param {number} pit
 * @param {number} n
 * @param {boolean} isStore
 */
function paintStones(container, pit, n, isStore) {
  const shown = isStore ? Math.min(n, 18) : n;
  container.innerHTML = '';
  for (let i = 0; i < shown; i++) {
    container.appendChild(makeStone(pit, i, isStore));
  }
}

/** @returns {HTMLElement} a single positioned stone. */
function makeStone(pit, i, isStore) {
  const s = document.createElement('div');
  s.className = 'stone';
  const hueVar = STONE_HUE_VARS[i % STONE_HUE_VARS.length];
  s.style.setProperty('--stone-hue', `var(${hueVar})`);
  if (isStore) {
    // Stores are tall slots (portrait) / wide slots (landscape): spread mostly
    // along the long axis but keep within the slot so stones don't spill out.
    s.style.setProperty('--sx', `${(seededRand(pit + 5, i) - 0.5) * 55}%`);
    s.style.setProperty('--sy', `${(seededRand(pit, i) - 0.5) * 110}%`);
  } else {
    const { sx, sy } = stoneOffset(pit, i);
    s.style.setProperty('--sx', `${sx}%`);
    s.style.setProperty('--sy', `${sy}%`);
  }
  return s;
}

/** Update the HUD turn attribute + indicator text (score handled elsewhere). */
function renderHudTurn(currentPlayer) {
  if (!dom.hud) dom.hud = $('game-hud');
  if (dom.hud) dom.hud.dataset.turn = String(currentPlayer);
}

/* ==========================================================================
   Animation
   ========================================================================== */

/**
 * Plays an ordered engine event list as animation, then leaves the board in
 * sync with the final derived state. Tapping the board skips to the end.
 *
 * Event types handled: pickup, sow, capture, extraTurn, sweep, gameOver.
 *
 * @param {import('./engine.js').GameEvent[]} events
 * @param {{onDone?:()=>void, speed?:number}} [opts]
 *   speed multiplies durations (0.5 = half time / faster is <1... use >1 to
 *   slow down). Default 1.
 * @returns {Promise<void>} resolves once animation (or skip) completes.
 */
export function animateEvents(events, opts = {}) {
  const { onDone, speed = 1 } = opts;
  const hop = HOP_MS * speed;

  // Compute the final pit counts by replaying the (data-only) events onto a
  // copy of the current counts, so a skip can snap straight to the end.
  const finalCounts = currentState ? currentState.pits.slice() : new Array(14).fill(0);
  applyEventsToCounts(finalCounts, events);
  let finalTurn = currentState ? currentState.currentPlayer : 0;
  for (const e of events) if (e.type === 'extraTurn') finalTurn = e.player;
  // (turn flip on non-extra moves is decided by the engine's resulting state;
  //  integration passes the real next state to renderBoard afterwards. For the
  //  standalone animation we only need the counts to be correct on skip.)

  return new Promise((resolve) => {
    animating = true;
    let done = false;

    const finish = () => {
      if (done) return;
      done = true;
      animating = false;
      skipToEnd = null;
      // Snap to authoritative final counts.
      for (let p = 0; p < 14; p++) {
        if (p === 6 || p === 13) renderStore(p, finalCounts[p]);
        else renderPit(p, finalCounts[p]);
      }
      if (typeof onDone === 'function') onDone();
      resolve();
    };

    skipToEnd = finish;
    runSequence(events, hop, finish).catch(() => finish());
  });
}

/**
 * Fold the numeric effect of each event into a counts array (no DOM).
 * @param {number[]} counts
 * @param {import('./engine.js').GameEvent[]} events
 */
function applyEventsToCounts(counts, events) {
  for (const e of events) {
    switch (e.type) {
      case 'pickup':
        counts[e.pit] = 0;
        break;
      case 'sow':
        counts[e.pit] += 1;
        break;
      case 'capture': {
        const total = (counts[e.pit] || 0) + (counts[e.oppositePit] || 0);
        counts[e.pit] = 0;
        counts[e.oppositePit] = 0;
        counts[e.store] += total;
        break;
      }
      case 'sweep': {
        let total = 0;
        for (const p of e.pits) { total += counts[p]; counts[p] = 0; }
        counts[e.store] += (e.count != null ? e.count : total);
        break;
      }
      default:
        break; // extraTurn / gameOver: no count change
    }
  }
}

/**
 * Step through events with real DOM updates + delays. Bails immediately if a
 * skip was requested (animating flips false).
 */
async function runSequence(events, hop, finish) {
  const live = currentState ? currentState.pits.slice() : new Array(14).fill(0);

  for (const e of events) {
    if (!animating) return; // skipped

    switch (e.type) {
      case 'pickup': {
        live[e.pit] = 0;
        liftPit(e.pit);
        setCount(e.pit, 0);
        clearStones(e.pit);
        await wait(hop * 0.6);
        break;
      }
      case 'sow': {
        live[e.pit] += 1;
        addStone(e.pit, live[e.pit] - 1);
        setCount(e.pit, live[e.pit]);
        await wait(hop);
        break;
      }
      case 'capture': {
        const total = (live[e.pit] || 0) + (live[e.oppositePit] || 0);
        flashPit(e.pit);
        flashPit(e.oppositePit);
        await wait(CAPTURE_MS * 0.5);
        live[e.pit] = 0;
        live[e.oppositePit] = 0;
        live[e.store] += total;
        setCount(e.pit, 0); clearStones(e.pit);
        setCount(e.oppositePit, 0); clearStones(e.oppositePit);
        setCount(e.store, live[e.store]);
        refillStore(e.store, live[e.store]);
        await wait(CAPTURE_MS * 0.5);
        break;
      }
      case 'extraTurn': {
        showSplash('EXTRA TURN!');
        await wait(EXTRA_MS);
        break;
      }
      case 'sweep': {
        for (const p of e.pits) { flashPit(p); }
        await wait(SWEEP_MS * 0.4);
        let total = 0;
        for (const p of e.pits) { total += live[p]; live[p] = 0; setCount(p, 0); clearStones(p); }
        live[e.store] += total;
        setCount(e.store, live[e.store]);
        refillStore(e.store, live[e.store]);
        await wait(SWEEP_MS * 0.6);
        break;
      }
      case 'gameOver':
        // No board mutation; integration transitions to #screen-over.
        break;
      default:
        break;
    }
  }
  finish();
}

/* ---- Animation DOM helpers ---------------------------------------------- */

function pitEl(idx) {
  const sel = (idx === 6 || idx === 13) ? `.store[data-pit="${idx}"]` : `.pit[data-pit="${idx}"]`;
  return dom.board && dom.board.querySelector(sel);
}
function setCount(idx, n) {
  const el = pitEl(idx);
  if (el) el.querySelector('.pit-count, .store-count').textContent = String(n);
}
function clearStones(idx) {
  const el = pitEl(idx);
  if (el) {
    const c = el.querySelector('.pit-stones, .store-stones');
    if (c) c.innerHTML = '';
  }
}
function addStone(idx, i) {
  const el = pitEl(idx);
  if (!el) return;
  const c = el.querySelector('.pit-stones, .store-stones');
  if (c) c.appendChild(makeStone(idx, i, idx === 6 || idx === 13));
}
function refillStore(idx, n) {
  const el = pitEl(idx);
  if (!el) return;
  paintStones(el.querySelector('.store-stones'), idx, n, true);
}
function liftPit(idx) {
  const el = pitEl(idx);
  if (el) { el.classList.add('pit--capture'); setTimeout(() => el.classList.remove('pit--capture'), 300); }
}
function flashPit(idx) {
  const el = pitEl(idx);
  if (el) { el.classList.add('pit--capture'); setTimeout(() => el.classList.remove('pit--capture'), 420); }
}
function showSplash(text) {
  if (!dom.board) return;
  const s = document.createElement('div');
  s.className = 'splash';
  s.innerHTML = `<div class="splash-text">${esc(text)}</div>`;
  dom.board.appendChild(s);
  setTimeout(() => s.remove(), EXTRA_MS + 100);
}

/* ==========================================================================
   Interactivity
   ========================================================================== */

/**
 * Highlights only the current player's legal pits and wires taps. Clears any
 * previous highlights/handlers first. Pass an empty array to disable all.
 * @param {number[]} legalPits - pit indices the local player may play
 * @param {(pit:number)=>void} onPitTap - called with the tapped pit index
 * @returns {void}
 */
export function setInteractive(legalPits, onPitTap) {
  if (!dom.board) dom.board = $('board');
  if (!dom.board) return;
  const legal = new Set(legalPits || []);

  for (const el of dom.board.querySelectorAll('.pit')) {
    const idx = Number(el.dataset.pit);
    el.classList.toggle('pit--legal', legal.has(idx));
    // Replace handler cleanly by cloning dataset-tracked listeners.
    el.onclick = legal.has(idx)
      ? () => { if (!animating && typeof onPitTap === 'function') onPitTap(idx); }
      : null;
    el.setAttribute('role', legal.has(idx) ? 'button' : 'presentation');
    if (legal.has(idx)) el.tabIndex = 0; else el.removeAttribute('tabindex');
  }
}

/* ==========================================================================
   Theming
   ========================================================================== */

/**
 * Applies a board/stone theme by setting attributes on #board (which css/
 * themes.css keys off) and persists the choice to localStorage 'mancala.theme'.
 * Missing fields fall back to the current/default theme.
 * @param {{board?:string, stones?:string}} theme
 * @returns {void}
 */
export function setTheme(theme) {
  if (!dom.board) dom.board = $('board');
  const board = theme.board || (dom.board && dom.board.dataset.boardTheme) || DEFAULT_THEME.board;
  const stones = theme.stones || (dom.board && dom.board.dataset.stoneTheme) || DEFAULT_THEME.stones;
  if (dom.board) {
    dom.board.dataset.boardTheme = board;
    dom.board.dataset.stoneTheme = stones;
    // Also expose --stone-image on the board so the image-skin CSS selector
    // (.board[style*="--stone-image"]) matches for any image-based set.
    const st = STONE_THEMES.find((t) => t.id === stones);
    if (st && stones === 'frog') dom.board.style.setProperty('--use-image', '1');
    else dom.board.style.removeProperty('--use-image');
  }
  try {
    localStorage.setItem(STORAGE_THEME, JSON.stringify({ board, stones }));
  } catch { /* ignore */ }
}

/* ==========================================================================
   Chat
   ========================================================================== */

/** onSend callback captured by wireChat so the form submit can reach it. */
let chatOnSend = null;

/**
 * Populates the chat drawer with existing messages and wires the send form.
 * Messages are HTML-escaped. Roles style differently (self/opponent/spectator).
 * Spectators may chat.
 * @param {{messages?:Array<{from:string,text:string,role?:'self'|'opponent'|'spectator',ts?:number}>,
 *          onSend?:(text:string)=>void}} opts
 * @returns {void}
 */
export function showChat({ messages = [], onSend } = {}) {
  const log = $('chat-log');
  if (!log) return;
  chatOnSend = onSend || null;
  log.innerHTML = '';
  for (const m of messages) appendChatMessage(m, false);
  scrollChat();
}

/** Wire the chat form + handle toggle once. */
function wireChat() {
  const form = $('chat-form');
  const handle = $('chat-handle');
  const chat = dom.chat || $('chat');
  if (handle && chat && !handle.dataset.wired) {
    handle.dataset.wired = '1';
    handle.addEventListener('click', () => {
      const open = chat.dataset.open === 'true';
      chat.dataset.open = open ? 'false' : 'true';
      handle.setAttribute('aria-expanded', String(!open));
      if (!open) { chatUnread = 0; updateUnreadBadge(); }
    });
  }
  if (form && !form.dataset.wired) {
    form.dataset.wired = '1';
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const input = $('chat-input');
      const text = (input.value || '').trim();
      if (!text) return;
      if (typeof chatOnSend === 'function') chatOnSend(text);
      // Optimistic local echo as self.
      appendChatMessage({ from: 'You', text, role: 'self' }, false);
      input.value = '';
      scrollChat();
    });
  }
}

/**
 * Appends one incoming chat message to the log (public API for integration).
 * Increments the unread badge when the drawer is closed.
 * @param {{from:string,text:string,role?:'self'|'opponent'|'spectator',ts?:number}} msg
 * @returns {void}
 */
export function appendChat(msg) {
  appendChatMessage(msg, true);
  scrollChat();
}

/** Internal: render one message; countUnread bumps the badge if closed. */
function appendChatMessage(msg, countUnread) {
  const log = $('chat-log');
  if (!log) return;
  const role = msg.role || 'opponent';
  const el = document.createElement('div');
  el.className = `chat-msg chat-msg--${role}`;
  el.innerHTML =
    `<span class="chat-msg-who">${esc(msg.from || '')}</span>${esc(msg.text || '')}`;
  log.appendChild(el);

  if (countUnread) {
    const chat = dom.chat || $('chat');
    if (chat && chat.dataset.open !== 'true') {
      chatUnread += 1;
      updateUnreadBadge();
    }
  }
}

function updateUnreadBadge() {
  const badge = $('chat-unread');
  if (!badge) return;
  badge.textContent = String(chatUnread);
  badge.hidden = chatUnread === 0;
}

function scrollChat() {
  const log = $('chat-log');
  if (log) log.scrollTop = log.scrollHeight;
}

/* ==========================================================================
   Screen views (plain-data props + callbacks; no net.js imports)
   ========================================================================== */

/**
 * Renders the main menu: name input (persisted), theme picker with live swatch
 * preview, create-game form, and Browse button.
 * @param {{
 *   name?:string,
 *   theme?:{board:string,stones:string},
 *   onCreate?:(opts:{name:string,password:string,allowSpectators:boolean})=>void,
 *   onBrowse?:()=>void,
 *   onThemeChange?:(theme:{board:string,stones:string})=>void
 * }} [props]
 * @returns {void}
 */
export function renderMenu(props = {}) {
  const nameInput = $('menu-name');
  const stored = safeGet(STORAGE_NAME) || '';
  if (nameInput) nameInput.value = props.name || stored;
  if (nameInput && !nameInput.dataset.wired) {
    nameInput.dataset.wired = '1';
    nameInput.addEventListener('input', () => safeSet(STORAGE_NAME, nameInput.value.trim()));
  }

  const theme = { ...DEFAULT_THEME, ...(props.theme || readStoredTheme()) };
  buildSwatches(theme, props.onThemeChange);
  updatePreview(theme);

  const form = $('menu-create-form');
  if (form && !form.dataset.wired) {
    form.dataset.wired = '1';
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      if (typeof props.onCreate === 'function') {
        props.onCreate({
          name: (nameInput && nameInput.value.trim()) || 'Player',
          password: ($('menu-password').value || '').trim(),
          allowSpectators: $('menu-spectators').checked,
        });
      }
    });
    // Re-read latest onCreate each submit by re-binding via closure over props.
    form._props = props;
  } else if (form) {
    form._props = props;
  }

  const browse = $('menu-browse');
  if (browse) browse.onclick = () => props.onBrowse && props.onBrowse();
}

/** Build board+stone swatch buttons and their selection behavior. */
function buildSwatches(theme, onChange) {
  const boardRow = $('menu-board-swatches');
  const stoneRow = $('menu-stone-swatches');
  const state = { board: theme.board, stones: theme.stones };

  const commit = () => {
    setTheme(state);
    updatePreview(state);
    markSelected(boardRow, state.board);
    markSelected(stoneRow, state.stones);
    if (typeof onChange === 'function') onChange({ ...state });
  };

  if (boardRow && !boardRow.dataset.built) {
    boardRow.dataset.built = '1';
    boardRow.innerHTML = '';
    for (const t of BOARD_THEMES) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'swatch';
      b.dataset.value = t.id;
      b.setAttribute('role', 'radio');
      b.style.background = t.board;
      b.style.borderColor = t.edge;
      b.innerHTML = `<span class="swatch-label">${esc(t.label)}</span>`;
      b.addEventListener('click', () => { state.board = t.id; commit(); });
      boardRow.appendChild(b);
    }
  }
  if (stoneRow && !stoneRow.dataset.built) {
    stoneRow.dataset.built = '1';
    stoneRow.innerHTML = '';
    for (const t of STONE_THEMES) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'swatch';
      b.dataset.value = t.id;
      b.setAttribute('role', 'radio');
      b.style.background =
        `radial-gradient(circle at 35% 30%, ${t.spec} 0%, transparent 45%), radial-gradient(circle at 50% 60%, ${t.hue}, #000)`;
      b.style.borderColor = t.outline === '#ffffff55' ? '#888' : t.outline;
      b.innerHTML = `<span class="swatch-label">${esc(t.label)}</span>`;
      b.addEventListener('click', () => { state.stones = t.id; commit(); });
      stoneRow.appendChild(b);
    }
  }
  markSelected(boardRow, state.board);
  markSelected(stoneRow, state.stones);
}

function markSelected(row, value) {
  if (!row) return;
  for (const b of row.querySelectorAll('.swatch')) {
    b.setAttribute('aria-checked', String(b.dataset.value === value));
  }
}

/** Update the live board preview strip in the menu. */
function updatePreview(theme) {
  const prev = $('menu-theme-preview');
  if (!prev) return;
  const bt = BOARD_THEMES.find((t) => t.id === theme.board) || BOARD_THEMES[0];
  const st = STONE_THEMES.find((t) => t.id === theme.stones) || STONE_THEMES[0];
  prev.style.setProperty('--tp-board', bt.board);
  prev.style.setProperty('--tp-edge', bt.edge);
  prev.style.setProperty('--tp-stone-outline', st.outline);
  prev.style.setProperty('--tp-stone-spec', st.spec);
  prev.style.setProperty('--tp-hue', st.hue);
  prev.innerHTML = '<span class="tp-stone"></span><span class="tp-stone"></span><span class="tp-stone"></span>';
}

/**
 * Renders the lobby list. Rows show host name, theme chip, lock icon when the
 * game has a password (prompts for it on join), status, and a watch button for
 * games in progress. Empty state prompts creating a game.
 * @param {Array<{
 *   id:string, hostName:string, theme?:string, hasPassword?:boolean,
 *   status?:'open'|'playing', allowSpectators?:boolean
 * }>} games
 * @param {{onJoin?:(id:string, password?:string)=>void, onWatch?:(id:string)=>void}} [handlers]
 * @returns {void}
 */
export function renderLobbyList(games = [], handlers = {}) {
  const list = $('lobby-list');
  if (!list) return;
  list.innerHTML = '';

  // Wire Back BEFORE the empty-games early return below — it used to sit
  // after the row-building loop, so Back was left dead whenever the list was
  // empty (including the very first render). main.js also wires #lobby-back
  // itself as a belt-and-suspenders workaround; that's harmless now but kept.
  const back = $('lobby-back');
  if (back) back.onclick = () => handlers.onBack && handlers.onBack();

  if (!games.length) {
    const empty = document.createElement('li');
    empty.className = 'lobby-empty';
    empty.textContent = 'No open games — create one!';
    list.appendChild(empty);
    return;
  }

  for (const g of games) {
    const row = document.createElement('li');
    row.className = 'lobby-row';
    const playing = g.status === 'playing';
    row.innerHTML = `
      <div class="lobby-row-main">
        <div class="lobby-host">
          ${g.hasPassword ? '<span title="Password required">🔒</span>' : ''}
          <span>${esc(g.hostName || 'Host')}</span>
        </div>
        <div class="lobby-meta">
          ${g.theme ? `<span class="theme-chip">${esc(g.theme)}</span>` : ''}
          <span class="status-chip status-chip--${playing ? 'playing' : 'open'}">
            ${playing ? 'playing' : 'open'}
          </span>
        </div>
      </div>
      <div class="lobby-actions"></div>`;

    const actions = row.querySelector('.lobby-actions');
    if (playing && g.allowSpectators !== false) {
      const watch = document.createElement('button');
      watch.type = 'button';
      watch.className = 'btn btn--secondary';
      watch.textContent = 'Watch';
      watch.onclick = () => handlers.onWatch && handlers.onWatch(g.id);
      actions.appendChild(watch);
    } else if (!playing) {
      const join = document.createElement('button');
      join.type = 'button';
      join.className = 'btn btn--primary';
      join.textContent = 'Join';
      join.onclick = () => {
        let pw;
        if (g.hasPassword) {
          pw = prompt(`Password for ${g.hostName || 'this game'}:`) || '';
          if (pw === '') return; // cancelled / empty
        }
        handlers.onJoin && handlers.onJoin(g.id, pw);
      };
      actions.appendChild(join);
    }
    list.appendChild(row);
  }
}

/**
 * Renders the waiting room shown after creating or joining a game. No game
 * code is displayed here (Phase 4 removed it — it confused players and had
 * no purpose once the lobby handles discovery). Instead this screen shows a
 * role-appropriate heading, a spinner, and a status line that the caller
 * drives across the connection lifecycle via updateWaitingStatus().
 * @param {{role?:'host'|'player'|'spectator', statusText?:string, onCancel?:()=>void}} props
 * @returns {void}
 */
export function renderWaiting({ role = 'host', statusText = 'Getting things ready…', onCancel } = {}) {
  const heading = $('wait-heading');
  if (heading) {
    heading.textContent = role === 'host' ? 'Waiting for an opponent…' : 'Joining game…';
  }
  updateWaitingStatus(statusText);
  const elapsed = $('wait-elapsed');
  if (elapsed) { elapsed.hidden = true; elapsed.textContent = ''; }
  const cancel = $('wait-cancel');
  if (cancel) cancel.onclick = () => onCancel && onCancel();
}

/**
 * Updates just the wait screen's status line, without touching the heading
 * or re-wiring Cancel. Used by main.js to reflect connection-lifecycle
 * progress (lobby -> peer connecting -> connected) without a full re-render.
 * @param {string} text
 * @returns {void}
 */
export function updateWaitingStatus(text) {
  const statusEl = $('wait-status-text');
  if (statusEl) statusEl.textContent = text;
}

/**
 * Shows/updates the "still trying — Ns" elapsed line on the wait screen.
 * Pass null/undefined to hide it. Doubles as debugging telemetry for
 * diagnosing stalled handshakes.
 * @param {string|null} [text]
 * @returns {void}
 */
export function updateWaitingElapsed(text) {
  const el = $('wait-elapsed');
  if (!el) return;
  if (!text) {
    el.hidden = true;
    el.textContent = '';
  } else {
    el.hidden = false;
    el.textContent = text;
  }
}

/**
 * Updates the in-game HUD: both names, whose-turn indicator, live scores, and
 * the SPECTATING badge for spectator role.
 * @param {{
 *   names:[string,string], scores?:[number,number], currentPlayer:0|1,
 *   myPlayer?:0|1|null, role?:'player'|'spectator'
 * }} props
 * @returns {void}
 */
export function renderGameHud({ names = ['Player 1', 'Player 2'], scores = [0, 0], currentPlayer = 0, myPlayer = 0, role = 'player' } = {}) {
  if (!dom.hud) dom.hud = $('game-hud');
  $('hud-name-0') && ($('hud-name-0').textContent = names[0]);
  $('hud-name-1') && ($('hud-name-1').textContent = names[1]);
  $('hud-score-0') && ($('hud-score-0').textContent = String(scores[0]));
  $('hud-score-1') && ($('hud-score-1').textContent = String(scores[1]));
  if (dom.hud) dom.hud.dataset.turn = String(currentPlayer);

  const spectating = role === 'spectator';
  const badge = $('spectate-badge');
  if (badge) badge.hidden = !spectating;

  const ind = $('turn-indicator');
  if (ind) {
    if (spectating) {
      ind.textContent = `${names[currentPlayer]}'s turn`;
    } else if (myPlayer === currentPlayer) {
      ind.textContent = 'Your turn';
    } else {
      ind.textContent = `${names[currentPlayer]}'s turn`;
    }
  }
}

/**
 * Renders the game-over screen: win/lose/tie banner + score, Rematch + Leave.
 * @param {{
 *   winner:0|1|null, myPlayer?:0|1|null, score:[number,number],
 *   names?:[string,string], onRematch?:()=>void, onLeave?:()=>void
 * }} props
 * @returns {void}
 */
export function renderGameOver({ winner, myPlayer = null, score = [0, 0], names = ['Player 1', 'Player 2'], onRematch, onLeave } = {}) {
  const banner = $('over-banner');
  const scoreEl = $('over-score');
  if (banner) {
    banner.classList.remove('over-banner--win', 'over-banner--lose', 'over-banner--tie');
    if (winner === null || winner === undefined) {
      banner.textContent = "It's a tie!";
      banner.classList.add('over-banner--tie');
    } else if (myPlayer !== null && winner === myPlayer) {
      banner.textContent = 'You win!';
      banner.classList.add('over-banner--win');
    } else if (myPlayer !== null) {
      banner.textContent = 'You lose';
      banner.classList.add('over-banner--lose');
    } else {
      banner.textContent = `${names[winner]} wins!`;
      banner.classList.add('over-banner--win');
    }
  }
  if (scoreEl) scoreEl.textContent = `${score[0]} – ${score[1]}`;
  const rematch = $('over-rematch');
  const leave = $('over-leave');
  if (rematch) rematch.onclick = () => onRematch && onRematch();
  if (leave) leave.onclick = () => onLeave && onLeave();
}

/* ---- localStorage helpers ------------------------------------------------ */
function safeGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function safeSet(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } }
function readStoredTheme() {
  try { const r = localStorage.getItem(STORAGE_THEME); return r ? JSON.parse(r) : DEFAULT_THEME; }
  catch { return DEFAULT_THEME; }
}

/* ==========================================================================
   DEV PREVIEW HOOK  (?uidev=1)
   Renders the game screen with a demo mid-game state, runs a sample sow+
   capture+extraTurn animation, and shows fake chat. Self-invokes because
   main.js's FORCE_DIAG routes normal boot to the diag panel; here we force
   #screen-game visible without touching main.js. Harmless in production.
   ========================================================================== */

/** @returns {boolean} */
function wantsUiDev() {
  try { return new URLSearchParams(location.search).get('uidev') === '1'; }
  catch { return false; }
}

function runUiDevPreview() {
  const gameScreen = $('screen-game');
  if (!gameScreen) return;

  // Force ONLY the game screen visible (bypasses main.js routing). main.js has
  // FORCE_DIAG=true and calls showScreen('diag-panel') asynchronously during
  // boot(), which would re-hide us. We cannot edit main.js, so we re-assert our
  // screen: once now, again after boot's async settles, and defensively via a
  // short-lived MutationObserver that flips visibility back if boot clobbers it.
  const forceGameOnly = () => {
    for (const s of document.querySelectorAll('.screen')) s.hidden = (s !== gameScreen);
  };
  forceGameOnly();
  setTimeout(forceGameOnly, 0);
  setTimeout(forceGameOnly, 150);
  const obs = new MutationObserver(() => { if (gameScreen.hidden) forceGameOnly(); });
  for (const s of document.querySelectorAll('.screen')) {
    obs.observe(s, { attributes: true, attributeFilter: ['hidden'] });
  }
  setTimeout(() => obs.disconnect(), 2000);

  initUI();

  // Demo mid-game state (varied counts so scatter + badges are visible).
  const demo = {
    pits: [4, 0, 3, 1, 6, 2, 8, 3, 4, 0, 5, 2, 1, 5],
    currentPlayer: 0,
  };
  renderBoard(demo);
  renderGameHud({
    names: ['Ada', 'Grace'], scores: [demo.pits[6], demo.pits[13]],
    currentPlayer: 0, myPlayer: 0, role: 'player',
  });

  // Fake chat.
  showChat({
    messages: [
      { from: 'Grace', text: 'good luck!', role: 'opponent' },
      { from: 'You', text: 'you too 🙂', role: 'self' },
      { from: 'Watcher', text: 'nice board', role: 'spectator' },
    ],
    onSend: (t) => console.log('[uidev] chat send:', t),
  });
  // Simulate an incoming message to exercise the unread badge.
  setTimeout(() => appendChat({ from: 'Grace', text: 'watch this move…', role: 'opponent' }), 1200);

  // Highlight legal pits so the affordance is visible.
  setInteractive([0, 2, 3, 4, 5], (pit) => {
    console.log('[uidev] tapped pit', pit);
    // Play a small sample animation from pit 4 (6 stones -> sow, land in store).
    const events = [
      { type: 'pickup', pit: 4, count: 6 },
      { type: 'sow', pit: 5 },
      { type: 'sow', pit: 6 },   // own store -> extra turn
      { type: 'sow', pit: 7 },
      { type: 'sow', pit: 8 },
      { type: 'sow', pit: 9 },
      { type: 'sow', pit: 10 },
    ];
    setInteractive([], () => {});
    animateEvents(events, {
      onDone: () => {
        setInteractive([0, 1, 2, 3, 5], () => {});
      },
    });
  });

  // Auto-run one sample animation shortly after load so the preview is lively.
  setTimeout(() => {
    const events = [
      { type: 'pickup', pit: 2, count: 3 },
      { type: 'sow', pit: 3 },
      { type: 'sow', pit: 4 },
      { type: 'sow', pit: 5 },
      { type: 'extraTurn', player: 0 },
    ];
    animateEvents(events, { onDone: () => renderBoard(demo) });
  }, 500);
}

if (wantsUiDev()) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', runUiDevPreview);
  } else {
    runUiDevPreview();
  }
}
