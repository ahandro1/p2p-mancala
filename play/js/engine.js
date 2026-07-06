/**
 * engine.js — pure Mancala (Kalah) rules engine. Phase 2 will implement this.
 *
 * Deliberately has NO DOM access and NO imports: it must be usable both in
 * the browser and headlessly (unit tests, or re-simulated by a peer to
 * verify a received move). All state is plain, structurally-cloneable data
 * so it can be sent over the wire as-is.
 *
 * ---------------------------------------------------------------------------
 * State shape
 * ---------------------------------------------------------------------------
 * @typedef {Object} GameState
 * @property {number[]} pits - length-14 array of stone counts:
 *   - indices 0-5:  Player 1's six pits
 *   - index 6:      Player 1's store (Kalah)
 *   - indices 7-12: Player 2's six pits
 *   - index 13:     Player 2's store (Kalah)
 * @property {0|1} currentPlayer - whose turn it is (0 = Player 1, 1 = Player 2)
 *
 * ---------------------------------------------------------------------------
 * Event shape (returned by applyMove, ordered for animation playback)
 * ---------------------------------------------------------------------------
 * @typedef {Object} GameEvent
 * @property {'sow'|'capture'|'sweep'|'extraTurn'|'gameOver'} type
 * @property {number} [pit] - pit index the event concerns, where applicable
 * @property {number} [count] - number of stones involved, where applicable
 * @property {0|1} [player] - player the event concerns, where applicable
 *
 * @typedef {Object} MoveResult
 * @property {GameState} state - the resulting state after the move
 * @property {GameEvent[]} events - ordered animation ops describing what happened
 */

/**
 * Creates a fresh game state: 4 stones in each of the 12 player pits, 0 in
 * both stores, Player 1 to move.
 * @returns {GameState}
 */
export function newGame() {
  throw new Error('Phase 2: not implemented');
}

/**
 * Returns the list of pit indices the current player may legally sow from
 * (i.e. their own non-empty pits).
 * @param {GameState} state
 * @returns {number[]}
 */
export function legalMoves(state) {
  throw new Error('Phase 2: not implemented');
}

/**
 * Applies sowing a move starting at `pit` for state.currentPlayer, including
 * capture and extra-turn rules, and returns the resulting state plus an
 * ordered list of events describing what happened (for animation).
 * @param {GameState} state
 * @param {number} pit - pit index to sow from; must belong to the current player
 * @returns {MoveResult}
 */
export function applyMove(state, pit) {
  throw new Error('Phase 2: not implemented');
}

/**
 * True if either player's row of 6 pits is all empty, ending the game.
 * @param {GameState} state
 * @returns {boolean}
 */
export function isGameOver(state) {
  throw new Error('Phase 2: not implemented');
}

/**
 * Determines the winner of a finished game (remaining stones are swept into
 * the owning player's store before comparing store totals).
 * @param {GameState} state
 * @returns {0|1|'tie'}
 */
export function winner(state) {
  throw new Error('Phase 2: not implemented');
}
