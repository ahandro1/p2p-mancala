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

/**
 * @type {{id:string,label:string,hue:string,outline:string,spec:string,images?:string[]}[]}
 *
 * `images` (optional): a per-theme LIST of stone image URLs. Even though
 * ui.js assigns these as an inline --stone-image custom property per stone
 * element, the url() is actually resolved by the CSS spec relative to the
 * STYLESHEET that consumes it via var() (board.css, in play/css/) — NOT
 * relative to this JS file and NOT relative to the document. So these paths
 * must match board.css's own asset references (e.g. frog's
 * '../assets/stones/frog.gif' in themes.css), i.e. from play/css/ ->
 * ../assets/... When present, each stone picks ONE entry deterministically
 * (see pickStoneImage()) instead of using a single --stone-image. This is
 * the JS-side half of the "image LIST" theme contract described in
 * css/themes.css; board.css's [data-stone-theme="gems"] rule renders
 * whichever URL ui.js assigns via an inline --stone-image.
 */
const STONE_THEMES = [
  { id: 'candy', label: 'Candy', hue: '#e02a2a', outline: '#1a1a2e', spec: '#ffffffcc' },
  { id: 'glass', label: 'Glass', hue: '#a7c7e7', outline: '#ffffff55', spec: '#ffffff' },
  { id: 'neon', label: 'Neon', hue: '#00ffa3', outline: '#05070f', spec: '#ffffff' },
  { id: 'frog', label: 'Frog', hue: '#4caf3a', outline: '#1c3a12', spec: '#ffffffcc' },
  {
    id: 'gems', label: 'Gems', hue: '#c9a8ff', outline: '#3a2a5c', spec: '#ffffffee',
    images: [
      '../assets/stones/gem-theme-1/ruby.png',
      '../assets/stones/gem-theme-1/emerald.png',
      '../assets/stones/gem-theme-1/opal.png',
      '../assets/stones/gem-theme-1/pink-diamond.png',
      '../assets/stones/gem-theme-1/sapphire.png',
    ],
  },
];

/** @type {{[id:string]: {id:string,label:string,hue:string,outline:string,spec:string,images?:string[]}}} */
const STONE_THEME_BY_ID = Object.fromEntries(STONE_THEMES.map((t) => [t.id, t]));

const DEFAULT_THEME = { board: 'arcade', stones: 'candy' };
const STORAGE_THEME = 'mancala.theme';
const STORAGE_NAME = 'mancala.name';

/** Which stone hue var to use for a pit's Nth stone (candy cycling). */
const STONE_HUE_VARS = ['--stone-c1', '--stone-c2', '--stone-c3', '--stone-c4', '--stone-c5'];

/** Animation timing (ms). Overridable via animateEvents(events,{speed}). */
const HOP_MS = 280;         // one sow hop (pile pit -> pit), per UX spec
const DROP_MS = 220;        // a stone settling into a pit
const CAPTURE_MS = 420;     // capture sweep flash
const SWEEP_MS = 500;       // end-game gather
const EXTRA_MS = 1100;      // extra-turn splash

/** @returns {boolean} true when the user prefers reduced motion. */
function prefersReducedMotion() {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; }
  catch { return false; }
}

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

/**
 * Hard interactivity lock. Independent of `animating`: it's raised the instant
 * a move is TAPPED (before any state/animation has arrived over the network)
 * and lowered only when the resulting animation completes via onDone ->
 * setInteractive. This closes the rapid-move race where a second tap could
 * fire in the network gap between sendMove() and the animation actually
 * starting, while `animating` was still false. See lockInteractivity().
 */
let interactivityLocked = false;

/** Set by animateEvents; calling it fast-forwards to the final state. */
let skipToEnd = null;

/**
 * Monotonic animation generation. Bumped on every animateEvents() call. Each
 * runSequence() captures the generation it belongs to and bails the instant a
 * newer animation supersedes it — this is what makes back-to-back animations
 * safe: when main.js's queue skips the current animation and immediately starts
 * the next, the OLD runSequence (which may still be suspended at an `await
 * wait()`) resumes to find its generation stale and returns WITHOUT touching
 * the DOM, so it can't interleave with / corrupt the new animation.
 */
let animGeneration = 0;

/**
 * The travelling sow pile element (a small stone cluster), while a sow is in
 * flight. Null when idle.
 * @type {HTMLElement|null}
 */
let sowPile = null;

/**
 * Pit/store center coordinates in the board's UNSCALED internal layout space
 * (offsetLeft/offsetTop-based, so immune to the board's transform: scale()).
 * Measured once per animation by measurePitCenters().
 * @type {Array<{x:number, y:number}>}
 */
let pitCenters = new Array(14).fill(null);

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

/**
 * Deterministically picks one image from a theme's `images` list for stone
 * `i` of `pit`, seeded the same way as stoneOffset (pit index + stone index)
 * so the assignment is STABLE across re-renders (no reshuffling mid-game)
 * and IDENTICAL on both peers, who each derive the board purely from the
 * synced pit/stone counts. Uses a distinct seed offset from stoneOffset's so
 * the scatter position and the gem choice are independent random streams —
 * otherwise a stone's position and its image would be correlated, which can
 * look patterned rather than randomly mixed.
 * @param {string[]} images
 * @param {number} pitIndex
 * @param {number} stoneIndex
 * @returns {string}
 */
function pickStoneImage(images, pitIndex, stoneIndex) {
  const r = seededRand(pitIndex * 31 + 17, stoneIndex * 47 + 11);
  const idx = Math.floor(r * images.length) % images.length;
  return images[idx];
}

/**
 * Registry of pending wait() resolvers so a skip can flush them immediately,
 * unblocking the animation loop (it then checks `animating` and returns).
 * @type {Set<() => void>}
 */
const pendingWaits = new Set();

/** Resolve every in-flight wait() at once (used by skipToEnd). */
function flushWaits() {
  for (const r of Array.from(pendingWaits)) r();
  pendingWaits.clear();
}

/** @returns {Promise<void>} resolves after `ms`, or immediately on skip. */
function wait(ms) {
  return new Promise((resolve) => {
    if (!animating) return resolve();
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      pendingWaits.delete(done);
      resolve();
    };
    const t = setTimeout(done, ms);
    pendingWaits.add(done);
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

/**
 * Tapping the board OUTSIDE any pit/store during an animation skips it to the
 * final state. We deliberately ignore taps that land on a pit or store (or
 * their children) so a "skip" gesture can never be confused with a move tap:
 * a player who taps a legal pit is making a MOVE, not asking to skip. Only the
 * board's empty frame area triggers a skip. (During animation pits are locked
 * non-interactive anyway — see setInteractive/isInteractive — so this is a
 * belt-and-suspenders separation of the two gestures.)
 */
function wireSkipTap() {
  if (!dom.board || dom.board.dataset.skipWired) return;
  dom.board.dataset.skipWired = '1';
  const skip = (ev) => {
    if (!animating || !skipToEnd) return;
    // Ignore taps on a pit/store (or anything inside one): those are the
    // move-affordance region, never the skip region.
    if (ev.target && ev.target.closest && ev.target.closest('.pit, .store')) return;
    skipToEnd();
  };
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
  fitBoardToStage();
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

  // Image-list themes (e.g. 'gems'): assign this stone ONE image from the
  // theme's list via a deterministic hash of (pit, stone index) — same
  // pattern as stoneOffset — so the mix looks randomly uneven across the
  // board but never reshuffles on re-render and matches on both peers
  // (both derive it from the same synced counts, not from network data).
  const stoneTheme = (dom.board && dom.board.dataset.stoneTheme) || DEFAULT_THEME.stones;
  const themeDef = STONE_THEME_BY_ID[stoneTheme];
  if (themeDef && Array.isArray(themeDef.images) && themeDef.images.length) {
    const url = pickStoneImage(themeDef.images, pit, i);
    s.style.setProperty('--stone-image', `url('${url}')`);
  }

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
   Board scaling (Tasks 2 & 3)

   The board has FIXED internal design dimensions (see board.css) and is
   scaled as a single unit via transform: scale(). This keeps every pit's
   relative position + size (and circularity) identical at any viewport —
   no internal reflow. We measure the stage once per fit and set two things:
     - #board[data-orientation]  -> 'horizontal' | 'vertical' (layout choice)
     - #board style --board-scale -> uniform scale factor to fit the stage
   Orientation is chosen from the stage's own aspect ratio (not a CSS
   orientation media query), so a NARROW-BUT-LANDSCAPE desktop window or a
   Webflow iframe correctly gets the vertical board.
   ========================================================================== */

/** Design pixel dimensions of each layout (must match board.css). */
const BOARD_DESIGN = {
  horizontal: { w: 1000, h: 380 },
  vertical: { w: 460, h: 820 },
};

/** True once the resize listener is installed (install exactly once). */
let boardResizeWired = false;

/**
 * Decides which layout the board should use for the current stage size.
 * Vertical when the available stage area is portrait-ish OR narrow (phone /
 * narrow embed); horizontal otherwise.
 * @param {number} stageW
 * @param {number} stageH
 * @returns {'horizontal'|'vertical'}
 */
function pickOrientation(stageW, stageH) {
  if (stageH > stageW) return 'vertical';        // taller than wide -> vertical
  if (stageW <= 700) return 'vertical';          // narrow embed / phone landscape
  return 'horizontal';
}

/**
 * Measures the board's stage and uniformly scales the fixed-geometry board to
 * fit it, choosing horizontal/vertical layout from the stage aspect ratio.
 * Safe to call anytime; no-ops if the board/stage aren't in the DOM yet.
 * @returns {void}
 */
export function fitBoardToStage() {
  const board = dom.board || $('board');
  if (!board) return;
  const stage = board.parentElement;
  if (!stage) return;

  const stageW = stage.clientWidth;
  const stageH = stage.clientHeight;
  if (stageW <= 0 || stageH <= 0) return;

  const orientation = pickOrientation(stageW, stageH);
  board.dataset.orientation = orientation;

  // Read the design dims for the chosen layout. Because the layout switch is
  // a class/attr toggle that CSS applies synchronously, the fixed w/h are the
  // authoritative design size — we don't need to re-measure the board itself.
  const design = BOARD_DESIGN[orientation];
  // Leave a little breathing room so the board never kisses the stage edges.
  const margin = 0.96;
  const scale = Math.min(
    (stageW * margin) / design.w,
    (stageH * margin) / design.h,
  );
  // Clamp to something sane; never upscale beyond the design size (crisp) and
  // never collapse to zero on a transient 0-height measure.
  const clamped = Math.max(0.05, Math.min(scale, 1));
  board.style.setProperty('--board-scale', String(clamped));

  if (!boardResizeWired) {
    boardResizeWired = true;
    const refit = () => fitBoardToStage();
    window.addEventListener('resize', refit);
    window.addEventListener('orientationchange', refit);
  }
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
  // Keep the CSS pile transition in sync with the JS hop duration.
  if (dom.board) dom.board.style.setProperty('--hop-ms', `${hop}ms`);

  // Compute the final pit counts by replaying the (data-only) events onto a
  // copy of the current counts, so a skip can snap straight to the end.
  const finalCounts = currentState ? currentState.pits.slice() : new Array(14).fill(0);
  applyEventsToCounts(finalCounts, events);
  let finalTurn = currentState ? currentState.currentPlayer : 0;
  for (const e of events) if (e.type === 'extraTurn') finalTurn = e.player;
  // (turn flip on non-extra moves is decided by the engine's resulting state;
  //  integration passes the real next state to renderBoard afterwards. For the
  //  standalone animation we only need the counts to be correct on skip.)

  // This animation's generation. Any previously-running runSequence is now
  // stale and will self-abort on its next loop check / await resume.
  const myGen = ++animGeneration;

  return new Promise((resolve) => {
    animating = true;
    let done = false;

    const finish = () => {
      if (done) return;
      done = true;
      // Only clear the shared "animating"/skip state if WE are still the
      // current generation. A superseded finish (old animation skipped after a
      // newer one already started) must not clobber the live animation's flags.
      if (myGen === animGeneration) {
        animating = false;
        skipToEnd = null;
      }
      flushWaits();
      removeSowPile();
      // Snap to authoritative final counts.
      for (let p = 0; p < 14; p++) {
        if (p === 6 || p === 13) renderStore(p, finalCounts[p]);
        else renderPit(p, finalCounts[p]);
      }
      if (typeof onDone === 'function') onDone();
      resolve();
    };

    skipToEnd = finish;

    // Respect reduced-motion: skip straight to the authoritative result.
    if (prefersReducedMotion()) {
      finish();
      return;
    }

    runSequence(events, hop, finish, myGen).catch(() => finish());
  });
}

/**
 * Fast-forwards any in-flight animation to its end IMMEDIATELY (synchronously
 * snapping the board to that animation's authoritative final counts and firing
 * its onDone). No-op when nothing is animating. Used by main.js's serial state
 * queue: when newer authoritative states have stacked up behind the one being
 * animated, we skip the current animation, let its onDone run (which renders
 * the intermediate board), and then animate only the LATEST state — so a burst
 * of moves never runs two animations at once and never drops the final state.
 * @returns {void}
 */
export function skipCurrentAnimation() {
  if (animating && typeof skipToEnd === 'function') skipToEnd();
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
 * Step through events with the travelling-pile animation, then finish().
 *
 * The centerpiece: on `pickup` we lift the source pit's stones into a moving
 * PILE element; each `sow` hops the pile to the next pit and drops ONE stone
 * out of it (settle bounce + badge bump), the pile visually shrinking as it
 * goes. Store deposits, captures, sweeps and the extra-turn splash follow.
 *
 * Bails immediately if a skip was requested (animating flips false) OR if a
 * newer animation superseded this one (generation mismatch); finish() then
 * snaps the board to the authoritative counts. The generation check is what
 * prevents a suspended-at-await old sequence from resuming and corrupting a
 * newer animation's DOM (the rapid-move race).
 * @param {import('./engine.js').GameEvent[]} events
 * @param {number} hop - per-hop duration (ms)
 * @param {() => void} finish
 * @param {number} myGen - the animation generation this sequence belongs to
 */
async function runSequence(events, hop, finish, myGen) {
  const live = currentState ? currentState.pits.slice() : new Array(14).fill(0);
  measurePitCenters(); // one measurement pass for the whole animation

  /** True once this sequence has been skipped or superseded — stop mutating. */
  const stale = () => !animating || myGen !== animGeneration;

  /** Number of stones currently riding in the travelling pile. */
  let pileCount = 0;
  /** The pit the pile is currently hovering over. */
  let pileAt = -1;

  for (const e of events) {
    if (stale()) return; // skipped or superseded -> finish() snaps to final

    switch (e.type) {
      case 'pickup': {
        live[e.pit] = 0;
        pileCount = e.count != null ? e.count : 0;
        pileAt = e.pit;
        clearStones(e.pit);
        setCount(e.pit, 0);
        liftPit(e.pit);
        makeSowPile(e.pit, pileCount);
        // Brief beat so the lift reads before the first hop.
        await wait(hop * 0.55);
        break;
      }
      case 'sow': {
        // Hop the pile from its current pit to this one, then drop a stone.
        movePileTo(e.pit);
        await wait(hop);
        if (stale()) return;
        pileAt = e.pit;
        live[e.pit] += 1;
        pileCount = Math.max(0, pileCount - 1);
        shrinkSowPile(pileCount);
        dropStoneInto(e.pit, live[e.pit] - 1);
        bumpCount(e.pit, live[e.pit]);
        await wait(DROP_MS * 0.6);
        break;
      }
      case 'capture': {
        removeSowPile();
        const total = (live[e.pit] || 0) + (live[e.oppositePit] || 0);
        flashPit(e.pit);
        flashPit(e.oppositePit);
        // Sweep both pits' stones toward the store.
        sweepStonesToStore(e.pit, e.store);
        sweepStonesToStore(e.oppositePit, e.store);
        await wait(CAPTURE_MS * 0.6);
        if (stale()) return;
        live[e.pit] = 0;
        live[e.oppositePit] = 0;
        live[e.store] += total;
        setCount(e.pit, 0); clearStones(e.pit);
        setCount(e.oppositePit, 0); clearStones(e.oppositePit);
        refillStore(e.store, live[e.store]);
        bumpCount(e.store, live[e.store]);
        await wait(CAPTURE_MS * 0.4);
        break;
      }
      case 'extraTurn': {
        removeSowPile();
        showSplash('EXTRA TURN!');
        await wait(EXTRA_MS);
        break;
      }
      case 'sweep': {
        removeSowPile();
        for (const p of e.pits) {
          flashPit(p);
          sweepStonesToStore(p, e.store);
        }
        await wait(SWEEP_MS * 0.5);
        if (stale()) return;
        let total = 0;
        for (const p of e.pits) { total += live[p]; live[p] = 0; setCount(p, 0); clearStones(p); }
        live[e.store] += total;
        refillStore(e.store, live[e.store]);
        bumpCount(e.store, live[e.store]);
        await wait(SWEEP_MS * 0.5);
        break;
      }
      case 'gameOver':
        // No board mutation; integration transitions to #screen-over.
        break;
      default:
        break;
    }
  }
  if (stale()) return; // superseded at the tail — don't double-finish
  removeSowPile();
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

/* ---- Travelling sow pile ------------------------------------------------- */

/**
 * Measure each pit/store CENTER in the board's own unscaled layout coordinate
 * space, once per animation. We use offsetLeft/offsetTop (+ half size) rather
 * than getBoundingClientRect so the values are in the board's internal
 * (pre-transform) pixel space — the pile is a board child and therefore lives
 * in that same space, so it scales with the board automatically and needs no
 * per-frame rect math (60fps-friendly: measure once, transform after).
 */
function measurePitCenters() {
  pitCenters = new Array(14).fill(null);
  if (!dom.board) return;
  for (let idx = 0; idx < 14; idx++) {
    const el = pitEl(idx);
    if (!el) continue;
    pitCenters[idx] = {
      x: el.offsetLeft + el.offsetWidth / 2,
      y: el.offsetTop + el.offsetHeight / 2,
    };
  }
}

/**
 * Create the travelling pile at the source pit, holding `count` little stones
 * (capped for perf; the badge/logic still use the true count).
 * @param {number} pit
 * @param {number} count
 */
function makeSowPile(pit, count) {
  removeSowPile();
  if (!dom.board) return;
  const center = pitCenters[pit];
  if (!center) return;
  const pile = document.createElement('div');
  pile.className = 'sow-pile';
  pile.style.setProperty('--px', `${center.x}px`);
  pile.style.setProperty('--py', `${center.y}px`);
  const shown = Math.min(count, 8);
  for (let i = 0; i < shown; i++) {
    const s = makeStone(pit, i, false);
    // Tight scatter so the cluster reads as a small heap.
    s.style.setProperty('--sx', `${(seededRand(pit + 3, i) - 0.5) * 60}%`);
    s.style.setProperty('--sy', `${(seededRand(pit + 9, i) - 0.5) * 60}%`);
    pile.appendChild(s);
  }
  dom.board.appendChild(pile);
  sowPile = pile;
}

/**
 * Ease the pile from its current position to `pit`'s center (one hop). The CSS
 * transition on the pile animates the transform smoothly.
 * @param {number} pit
 */
function movePileTo(pit) {
  if (!sowPile) return;
  const center = pitCenters[pit];
  if (!center) return;
  sowPile.style.setProperty('--px', `${center.x}px`);
  sowPile.style.setProperty('--py', `${center.y}px`);
}

/** Trim the pile down to `count` visible stones (shrinks as stones drop). */
function shrinkSowPile(count) {
  if (!sowPile) return;
  const stones = sowPile.querySelectorAll('.stone');
  // Keep at most `count` (but never fewer than what's left of our capped set).
  const target = Math.min(count, stones.length);
  for (let i = stones.length - 1; i >= target; i--) stones[i].remove();
  if (count <= 0) removeSowPile();
}

/** Remove the travelling pile if present. */
function removeSowPile() {
  if (sowPile) { sowPile.remove(); sowPile = null; }
}

/**
 * Add a stone to a pit/store with the drop-settle animation. Falls back to a
 * plain add if reduced motion is on.
 * @param {number} idx
 * @param {number} i - stone ordinal within the pit (for deterministic scatter)
 */
function dropStoneInto(idx, i) {
  const el = pitEl(idx);
  if (!el) return;
  const c = el.querySelector('.pit-stones, .store-stones');
  if (!c) return;
  const s = makeStone(idx, i, idx === 6 || idx === 13);
  if (!prefersReducedMotion()) {
    s.classList.add('stone--dropping');
    s.addEventListener('animationend', () => s.classList.remove('stone--dropping'), { once: true });
  }
  c.appendChild(s);
}

/**
 * Set a pit/store count and bump its badge. The bump is the visible "tick" at
 * the exact moment a stone lands.
 * @param {number} idx
 * @param {number} n
 */
function bumpCount(idx, n) {
  const el = pitEl(idx);
  if (!el) return;
  const badge = el.querySelector('.pit-count, .store-count');
  if (!badge) return;
  badge.textContent = String(n);
  if (prefersReducedMotion()) return;
  const cls = (idx === 6 || idx === 13) ? 'store-count--bump' : 'pit-count--bump';
  badge.classList.remove(cls);
  // Force reflow so re-adding the class restarts the animation.
  void badge.offsetWidth;
  badge.classList.add(cls);
  badge.addEventListener('animationend', () => badge.classList.remove(cls), { once: true });
}

/**
 * Sweep a pit's currently-rendered stones toward a store during a capture or
 * end-game sweep. Transform-only glide, then the caller repaints the store.
 * @param {number} fromPit
 * @param {number} store
 */
function sweepStonesToStore(fromPit, store) {
  if (prefersReducedMotion()) return;
  const fromEl = pitEl(fromPit);
  const target = pitCenters[store];
  const from = pitCenters[fromPit];
  if (!fromEl || !target || !from) return;
  const c = fromEl.querySelector('.pit-stones, .store-stones');
  if (!c) return;
  const dx = target.x - from.x;
  const dy = target.y - from.y;
  for (const stone of c.querySelectorAll('.stone')) {
    stone.classList.add('stone--sweeping');
    // Translate is relative to the stone's own scattered position; a shared
    // pit->store delta reads as the whole handful sliding across together.
    stone.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
    stone.style.opacity = '0';
  }
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
  // Any explicit (re-)wire of interactivity clears the hard lock: this is the
  // single point where interactivity is re-enabled (onDone -> setInteractive),
  // so it must drop the lock raised when the move was tapped.
  interactivityLocked = false;
  const legal = new Set(legalPits || []);

  for (const el of dom.board.querySelectorAll('.pit')) {
    const idx = Number(el.dataset.pit);
    el.classList.toggle('pit--legal', legal.has(idx));
    // Replace handler cleanly by cloning dataset-tracked listeners. The handler
    // guards on BOTH animating and the hard lock so a tap fired in the
    // network gap between sendMove() and the animation starting is dropped.
    el.onclick = legal.has(idx)
      ? () => {
          if (animating || interactivityLocked) return;
          if (typeof onPitTap !== 'function') return;
          // Raise the lock the instant a move is tapped; the very next line's
          // onPitTap() sends the move. Interactivity re-opens only when the
          // resulting animation's onDone calls setInteractive() again.
          lockInteractivity();
          onPitTap(idx);
        }
      : null;
    el.setAttribute('role', legal.has(idx) ? 'button' : 'presentation');
    if (legal.has(idx)) el.tabIndex = 0; else el.removeAttribute('tabindex');
  }
}

/**
 * Raises the hard interactivity lock and visually clears the legal-pit
 * highlight so no pit looks tappable. Called the instant a move is tapped (see
 * setInteractive) and available to callers (main.js) that need to lock input
 * before a move round-trips. Idempotent.
 * @returns {void}
 */
export function lockInteractivity() {
  interactivityLocked = true;
  if (!dom.board) dom.board = $('board');
  if (!dom.board) return;
  for (const el of dom.board.querySelectorAll('.pit')) {
    el.classList.remove('pit--legal');
    el.onclick = null;
    el.removeAttribute('tabindex');
    el.setAttribute('role', 'presentation');
  }
}

/** @returns {boolean} true while an animation sequence is playing. */
export function isAnimating() {
  return animating;
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
    // board.css keys the image-skin rule off [data-stone-theme="…"] directly
    // (frog: single theme-wide --stone-image; gems: per-stone --stone-image
    // set inline by makeStone()), so no extra board-level flag is needed here.
    // Re-render existing stones so switching themes mid-game immediately
    // picks up (or drops) image assignments without waiting for the next
    // engine event. renderBoard() rebuilds pit/store stone DOM from counts.
    if (currentState) renderBoard(currentState);
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
  // Clear any leftover retry panel from a prior failed attempt on re-entry.
  showWaitingRetry(null);
  updateWaitingStatus(statusText);
  const elapsed = $('wait-elapsed');
  if (elapsed) { elapsed.hidden = true; elapsed.textContent = ''; }
  const cancel = $('wait-cancel');
  if (cancel) { cancel.hidden = false; cancel.onclick = () => onCancel && onCancel(); }
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
 * Shows a friendly "couldn't connect" retry panel ON the waiting screen, in
 * place of the spinner/status, with "Try again" and "Back" actions. Used by
 * main.js when the guest join handshake times out (30s) instead of hanging
 * forever. Pass null to hide the panel and restore the normal waiting UI.
 * @param {{message?:string, onRetry?:()=>void, onBack?:()=>void}|null} opts
 * @returns {void}
 */
export function showWaitingRetry(opts) {
  const card = $('wait-heading') && $('wait-heading').closest('.wait-card');
  const dots = card && card.querySelector('.wait-dots');
  const status = card && card.querySelector('.wait-status');
  const elapsed = $('wait-elapsed');
  const cancel = $('wait-cancel');
  let retry = $('wait-retry');

  if (!opts) {
    // Restore normal waiting UI.
    if (retry) retry.hidden = true;
    if (dots) dots.hidden = false;
    if (status) status.hidden = false;
    if (cancel) cancel.hidden = false;
    return;
  }

  const { message = "Couldn't reach the host.", onRetry, onBack } = opts;

  // Hide the "still working" affordances; the connection has given up.
  if (dots) dots.hidden = true;
  if (status) status.hidden = true;
  if (elapsed) { elapsed.hidden = true; elapsed.textContent = ''; }
  if (cancel) cancel.hidden = true;

  const heading = $('wait-heading');
  if (heading) heading.textContent = 'Connection trouble';

  if (!retry && card) {
    retry = document.createElement('div');
    retry.id = 'wait-retry';
    retry.className = 'wait-retry';
    retry.innerHTML =
      `<p class="wait-retry-msg"></p>
       <div class="wait-retry-actions">
         <button type="button" class="btn btn--primary" data-act="retry">Try again</button>
         <button type="button" class="btn btn--secondary" data-act="back">Back</button>
       </div>`;
    card.appendChild(retry);
  }
  if (retry) {
    retry.hidden = false;
    const msgEl = retry.querySelector('.wait-retry-msg');
    if (msgEl) msgEl.textContent = message;
    const retryBtn = retry.querySelector('[data-act="retry"]');
    const backBtn = retry.querySelector('[data-act="back"]');
    if (retryBtn) retryBtn.onclick = () => { if (typeof onRetry === 'function') onRetry(); };
    if (backBtn) backBtn.onclick = () => { if (typeof onBack === 'function') onBack(); };
  }
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
 *   myPlayer?:0|1|null, role?:'player'|'spectator',
 *   canResign?:boolean, onResign?:()=>void
 * }} props
 *   canResign: show the Resign button (only true for the two seated players
 *   while the game is active). onResign: opens the resign confirmation.
 * @returns {void}
 */
export function renderGameHud({ names = ['Player 1', 'Player 2'], scores = [0, 0], currentPlayer = 0, myPlayer = 0, role = 'player', canResign = false, onResign } = {}) {
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

  // Resign button: visible only to seated players while active. Spectators
  // never see it. Wiring is (re)bound each render so onResign stays fresh.
  const resignBtn = $('resign-btn');
  if (resignBtn) {
    resignBtn.hidden = !canResign || spectating;
    resignBtn.onclick = () => { if (typeof onResign === 'function') onResign(); };
  }
}

/**
 * Opens the resign confirmation overlay for the given opponent name. The
 * overlay blocks board input while open (it sits above the board via z-index
 * and covers the viewport). Wires its two buttons to the supplied callbacks.
 * @param {{opponentName?:string, onConfirm?:()=>void, onCancel?:()=>void}} opts
 * @returns {void}
 */
export function showResignConfirm({ opponentName = 'your opponent', onConfirm, onCancel } = {}) {
  const overlay = $('resign-overlay');
  if (!overlay) return;
  const text = $('resign-overlay-text');
  if (text) text.textContent = `Concede this game to ${opponentName}?`;
  overlay.hidden = false;

  const cancel = $('resign-cancel');
  const confirm = $('resign-confirm');
  const close = () => { overlay.hidden = true; };
  if (cancel) cancel.onclick = () => { close(); if (typeof onCancel === 'function') onCancel(); };
  if (confirm) confirm.onclick = () => { close(); if (typeof onConfirm === 'function') onConfirm(); };
}

/** Force-close the resign confirmation overlay (e.g. game ended remotely). */
export function hideResignConfirm() {
  const overlay = $('resign-overlay');
  if (overlay) overlay.hidden = true;
}

/**
 * Renders the game-over screen: win/lose/tie banner + score, Rematch + Leave.
 * When `resignedBy` is set, an extra line notes who resigned (shown to every
 * role including spectators).
 * @param {{
 *   winner:0|1|null, myPlayer?:0|1|null, score:[number,number],
 *   names?:[string,string], resignedBy?:string|null,
 *   onRematch?:()=>void, onLeave?:()=>void
 * }} props
 * @returns {void}
 */
export function renderGameOver({ winner, myPlayer = null, score = [0, 0], names = ['Player 1', 'Player 2'], resignedBy = null, onRematch, onLeave } = {}) {
  // The confirm overlay must never linger over the game-over screen.
  hideResignConfirm();

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

  // Resignation note (added/removed each render so a later normal game-over
  // doesn't keep showing it).
  const card = banner && banner.closest('.over-card');
  let note = $('over-resign-note');
  if (resignedBy) {
    if (!note && card && scoreEl) {
      note = document.createElement('div');
      note.id = 'over-resign-note';
      note.className = 'over-resign-note';
      scoreEl.insertAdjacentElement('afterend', note);
    }
    if (note) note.textContent = `${resignedBy} resigned`;
  } else if (note) {
    note.remove();
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
    canResign: true,
    onResign: () => showResignConfirm({
      opponentName: 'Grace',
      onConfirm: () => console.log('[uidev] resign confirmed'),
      onCancel: () => console.log('[uidev] resign cancelled'),
    }),
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
