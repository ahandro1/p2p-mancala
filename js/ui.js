/**
 * ui.js — board rendering & interaction layer. Phase 4 will implement this.
 *
 * Consumes the pure state/events produced by engine.js and renders them into
 * `#screen-game`. Kept separate from engine.js so the rules can be tested
 * headlessly and so rendering can be swapped/reskinned without touching
 * game logic.
 */

/**
 * One-time setup: caches DOM refs inside #screen-game, wires up pit click
 * handlers, etc. Call once before the first renderBoard().
 * @returns {void}
 */
export function initUI() {
  throw new Error('Phase 4: not implemented');
}

/**
 * Renders a full board state (stone counts per pit/store, whose turn it is)
 * into #screen-game. Does not animate — for instant/initial render or
 * resync; use animateEvents() for move-by-move animation.
 * @param {import('./engine.js').GameState} state
 * @returns {void}
 */
export function renderBoard(state) {
  throw new Error('Phase 4: not implemented');
}

/**
 * Plays back an ordered list of engine events (sow/capture/sweep/extraTurn/
 * gameOver) as visual animation, then leaves the board in sync with the
 * resulting state.
 * @param {import('./engine.js').GameEvent[]} events
 * @returns {Promise<void>} resolves once all animations have finished
 */
export function animateEvents(events) {
  throw new Error('Phase 4: not implemented');
}

/**
 * Applies a visual theme by setting the corresponding CSS custom properties
 * (see css/themes.css for the contract) on the board root element.
 * @param {{board?: string, stones?: string}} theme
 * @returns {void}
 */
export function setTheme(theme) {
  throw new Error('Phase 4: not implemented');
}

/**
 * Appends an incoming chat message to the in-game chat UI.
 * @param {{from: string, text: string, ts: number}} msg
 * @returns {void}
 */
export function showChat(msg) {
  throw new Error('Phase 4: not implemented');
}
