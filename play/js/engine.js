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

const PITS_PER_SIDE = 6;
const P1_STORE = 6;
const P2_STORE = 13;
const TOTAL_PITS = 14;

/**
 * Own store index for a given player.
 * @param {0|1} player
 * @returns {number}
 */
function storeOf(player) {
  return player === 0 ? P1_STORE : P2_STORE;
}

/**
 * Opponent's store index for a given player (the pit sowing must skip).
 * @param {0|1} player
 * @returns {number}
 */
function opponentStoreOf(player) {
  return player === 0 ? P2_STORE : P1_STORE;
}

/**
 * The six own-pit indices for a given player, in board order.
 * @param {0|1} player
 * @returns {number[]}
 */
function ownPitsOf(player) {
  return player === 0
    ? [0, 1, 2, 3, 4, 5]
    : [7, 8, 9, 10, 11, 12];
}

/**
 * True if `pitIndex` is one of `player`'s own six sowing pits (not a store).
 * @param {0|1} player
 * @param {number} pitIndex
 * @returns {boolean}
 */
function isOwnPit(player, pitIndex) {
  return player === 0
    ? pitIndex >= 0 && pitIndex <= 5
    : pitIndex >= 7 && pitIndex <= 12;
}

/**
 * The pit directly across the board from `pitIndex` (0-5 <-> 12-7).
 * @param {number} pitIndex
 * @returns {number}
 */
function oppositePit(pitIndex) {
  return 12 - pitIndex;
}

/**
 * Creates a fresh game state: 4 stones in each of the 12 player pits, 0 in
 * both stores, Player 1 to move.
 * @returns {GameState}
 */
export function newGame() {
  const pits = new Array(TOTAL_PITS).fill(4);
  pits[P1_STORE] = 0;
  pits[P2_STORE] = 0;
  return { pits, currentPlayer: 0 };
}

/**
 * Returns the list of pit indices the current player may legally sow from
 * (i.e. their own non-empty pits).
 * @param {GameState} state
 * @returns {number[]}
 */
export function legalMoves(state) {
  return ownPitsOf(state.currentPlayer).filter((i) => state.pits[i] > 0);
}

/**
 * True if every pit in `player`'s row of six is empty.
 * @param {number[]} pits
 * @param {0|1} player
 * @returns {boolean}
 */
function rowIsEmpty(pits, player) {
  return ownPitsOf(player).every((i) => pits[i] === 0);
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
  const player = state.currentPlayer;

  if (!Number.isInteger(pit) || pit < 0 || pit >= TOTAL_PITS) {
    throw new Error(`Illegal move: pit ${pit} is out of range`);
  }
  if (!isOwnPit(player, pit)) {
    throw new Error(`Illegal move: pit ${pit} does not belong to player ${player}`);
  }
  if (state.pits[pit] === 0) {
    throw new Error(`Illegal move: pit ${pit} is empty`);
  }

  const pits = state.pits.slice();
  const events = [];
  const skipPit = opponentStoreOf(player);
  const myStore = storeOf(player);

  let stones = pits[pit];
  pits[pit] = 0;
  events.push({ type: 'pickup', pit, count: stones });

  let cursor = pit;
  let lastPit = pit;
  while (stones > 0) {
    cursor = (cursor + 1) % TOTAL_PITS;
    if (cursor === skipPit) continue;
    pits[cursor] += 1;
    events.push({ type: 'sow', pit: cursor });
    lastPit = cursor;
    stones -= 1;
  }

  let extraTurn = false;

  if (lastPit === myStore) {
    extraTurn = true;
  } else if (isOwnPit(player, lastPit) && pits[lastPit] === 1) {
    const opp = oppositePit(lastPit);
    if (pits[opp] > 0) {
      const captured = pits[opp] + pits[lastPit];
      pits[opp] = 0;
      pits[lastPit] = 0;
      pits[myStore] += captured;
      events.push({
        type: 'capture',
        pit: lastPit,
        oppositePit: opp,
        store: myStore,
        count: captured,
      });
    }
  }

  if (extraTurn) {
    events.push({ type: 'extraTurn', player });
  }

  const nextPlayer = extraTurn ? player : (player === 0 ? 1 : 0);
  let resultState = { pits, currentPlayer: nextPlayer };

  // End-of-game sweep: if either row is now all empty, the OTHER side's
  // remaining stones are swept into their own store.
  if (rowIsEmpty(pits, 0) || rowIsEmpty(pits, 1)) {
    for (const sweepingPlayer of [0, 1]) {
      const rowPits = ownPitsOf(sweepingPlayer);
      const remaining = rowPits.reduce((sum, i) => sum + pits[i], 0);
      if (remaining > 0) {
        const sweptPits = rowPits.filter((i) => pits[i] > 0);
        for (const i of rowPits) pits[i] = 0;
        const store = storeOf(sweepingPlayer);
        pits[store] += remaining;
        events.push({
          type: 'sweep',
          player: sweepingPlayer,
          pits: sweptPits,
          store,
          count: remaining,
        });
      }
    }
    resultState = { pits, currentPlayer: nextPlayer };
    const p1Store = pits[P1_STORE];
    const p2Store = pits[P2_STORE];
    let gameWinner;
    if (p1Store > p2Store) gameWinner = 0;
    else if (p2Store > p1Store) gameWinner = 1;
    else gameWinner = null;
    events.push({ type: 'gameOver', winner: gameWinner, score: [p1Store, p2Store] });
  }

  return { state: resultState, events };
}

/**
 * True if either player's row of 6 pits is all empty, ending the game.
 * @param {GameState} state
 * @returns {boolean}
 */
export function isGameOver(state) {
  return rowIsEmpty(state.pits, 0) || rowIsEmpty(state.pits, 1);
}

/**
 * Determines the winner of a finished game (remaining stones are swept into
 * the owning player's store before comparing store totals).
 * @param {GameState} state
 * @returns {0|1|null|undefined}
 */
export function winner(state) {
  if (!isGameOver(state)) return undefined;

  const p1Remaining = ownPitsOf(0).reduce((sum, i) => sum + state.pits[i], 0);
  const p2Remaining = ownPitsOf(1).reduce((sum, i) => sum + state.pits[i], 0);
  const p1Store = state.pits[P1_STORE] + p1Remaining;
  const p2Store = state.pits[P2_STORE] + p2Remaining;

  if (p1Store > p2Store) return 0;
  if (p2Store > p1Store) return 1;
  return null;
}
