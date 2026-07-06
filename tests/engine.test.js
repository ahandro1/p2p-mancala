import test from 'node:test';
import assert from 'node:assert/strict';
import {
  newGame,
  legalMoves,
  applyMove,
  isGameOver,
  winner,
} from '../play/js/engine.js';

const P1_STORE = 6;
const P2_STORE = 13;
const TOTAL_STONES = 48;

/** Sum of every pit/store in a state (should always be 48 — conservation of stones). */
function totalStones(pits) {
  return pits.reduce((a, b) => a + b, 0);
}

/** Deep-clone a state so we can mutate freely without touching the original. */
function cloneState(state) {
  return { pits: state.pits.slice(), currentPlayer: state.currentPlayer };
}

/** Build a custom state from a 14-length pits array + currentPlayer, for precise setups. */
function makeState(pits, currentPlayer = 0) {
  return { pits: pits.slice(), currentPlayer };
}

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

test('newGame: initial state has 4 stones per pit, 0 in stores, player 0 to move', () => {
  const state = newGame();
  assert.equal(state.currentPlayer, 0);
  assert.equal(state.pits.length, 14);
  for (let i = 0; i < 14; i++) {
    if (i === P1_STORE || i === P2_STORE) {
      assert.equal(state.pits[i], 0, `store ${i} should start at 0`);
    } else {
      assert.equal(state.pits[i], 4, `pit ${i} should start at 4`);
    }
  }
  assert.equal(totalStones(state.pits), TOTAL_STONES);
});

// ---------------------------------------------------------------------------
// Simple sow
// ---------------------------------------------------------------------------

test('applyMove: simple sow distributes one stone per pit forward, no capture/extra-turn', () => {
  const state = newGame();
  const { state: next, events } = applyMove(state, 0);
  // Pit 0 (4 stones) -> pits 1,2,3,4
  assert.equal(next.pits[0], 0);
  assert.equal(next.pits[1], 5);
  assert.equal(next.pits[2], 5);
  assert.equal(next.pits[3], 5);
  assert.equal(next.pits[4], 5);
  assert.equal(next.pits[5], 4); // untouched
  // Last stone lands in pit 4, which had 4 stones (now 5) -> no capture, not empty-landing
  assert.equal(next.currentPlayer, 1); // turn passes, no extra turn
  assert.equal(events[0].type, 'pickup');
  assert.equal(events[0].pit, 0);
  assert.equal(events[0].count, 4);
  const sowEvents = events.filter((e) => e.type === 'sow');
  assert.deepEqual(sowEvents.map((e) => e.pit), [1, 2, 3, 4]);
  assert.ok(!events.some((e) => e.type === 'capture'));
  assert.ok(!events.some((e) => e.type === 'extraTurn'));
});

// ---------------------------------------------------------------------------
// Sow wrapping past opponent's store, and revisiting the origin pit
// ---------------------------------------------------------------------------

test('applyMove: sowing with 13+ stones skips opponent store and wraps back past origin', () => {
  // Player 0 sows from pit 0 with 14 stones. A full skip-aware lap is 13
  // pits (14 board slots minus the skipped opponent store), so this sows
  // once around every pit (1-12, wrapping to 0), then one more into pit 1 —
  // proving both the opponent-store skip and the wrap-around revisit of the
  // origin pit.
  const pits = new Array(14).fill(0);
  pits[0] = 14;
  const state = makeState(pits, 0);
  const { state: next, events } = applyMove(state, 0);

  assert.equal(next.pits[P2_STORE], 0, 'opponent store must be skipped entirely, receives nothing');
  assert.equal(next.pits[0], 1, 'origin pit revisited once on wrap-around');
  assert.equal(next.pits[1], 2, 'pit 1 receives a stone on the first pass and again on the second');
  for (const i of [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) {
    assert.equal(next.pits[i], 1, `pit ${i} should have received exactly one stone`);
  }

  const sowEvents = events.filter((e) => e.type === 'sow');
  assert.equal(sowEvents.length, 14);
  assert.ok(!sowEvents.some((e) => e.pit === P2_STORE), 'no sow event targets opponent store');
  assert.deepEqual(
    sowEvents.map((e) => e.pit),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 0, 1],
    'sowing order skips index 13 (opponent store) and wraps through origin'
  );
  assert.ok(!events.some((e) => e.type === 'capture'), 'landing pit 1 has 2 stones, not an empty-pit capture');

  assert.equal(totalStones(next.pits), 14, 'all 14 sown stones remain on the board (none started elsewhere)');
});

// ---------------------------------------------------------------------------
// Extra turn on exact store landing
// ---------------------------------------------------------------------------

test('applyMove: last stone landing exactly in own store grants an extra turn', () => {
  const pits = new Array(14).fill(0);
  pits[5] = 1; // one stone, one pit away from P1 store (index 6)
  const state = makeState(pits, 0);
  const { state: next, events } = applyMove(state, 5);

  assert.equal(next.pits[P1_STORE], 1);
  assert.equal(next.currentPlayer, 0, 'current player unchanged on extra turn');
  assert.ok(events.some((e) => e.type === 'extraTurn' && e.player === 0));
  assert.ok(!events.some((e) => e.type === 'capture'), 'landing in own store must not capture');
});

// ---------------------------------------------------------------------------
// Capture rules
// ---------------------------------------------------------------------------

test('applyMove: capture when last stone lands in own empty pit with non-empty opposite', () => {
  // Sow from pit 4 with 2 stones: lands in pit 5, then pit 6 (store) — not
  // what we want. Instead set up: pit 3 has 3 stones -> lands in pit 4, 5, 6.
  // We need last landing pit to be an OWN empty pit (not the store).
  // Use pit 1 with 1 stone -> lands in pit 2 (must be empty and pit 10 (12-2)
  // must be non-empty).
  const pits = new Array(14).fill(0);
  pits[1] = 1; // sows 1 stone into pit 2
  pits[2] = 0; // pit 2 starts empty so after sow it becomes exactly 1
  pits[10] = 5; // opposite of pit 2 is 12-2=10, non-empty
  const state = makeState(pits, 0);
  const { state: next, events } = applyMove(state, 1);

  assert.equal(next.pits[2], 0, 'landing pit emptied by capture');
  assert.equal(next.pits[10], 0, 'opposite pit emptied by capture');
  assert.equal(next.pits[P1_STORE], 6, '1 (landed stone) + 5 (opposite) = 6 captured to store');
  const captureEvents = events.filter((e) => e.type === 'capture');
  assert.equal(captureEvents.length, 1);
  assert.deepEqual(captureEvents[0], {
    type: 'capture',
    pit: 2,
    oppositePit: 10,
    store: P1_STORE,
    count: 6,
  });
  assert.equal(totalStones(next.pits), totalStones(pits));
});

test('applyMove: no capture when last stone lands in own empty pit but opposite is also empty', () => {
  const pits = new Array(14).fill(0);
  pits[1] = 1; // sows into pit 2
  pits[2] = 0;
  pits[10] = 0; // opposite also empty
  pits[11] = 5; // keep player 1's row non-empty so the game doesn't end this move
  const state = makeState(pits, 0);
  const { state: next, events } = applyMove(state, 1);

  assert.equal(next.pits[2], 1, 'stone stays in landing pit, no capture');
  assert.equal(next.pits[10], 0);
  assert.equal(next.pits[P1_STORE], 0, 'nothing captured to store');
  assert.ok(!events.some((e) => e.type === 'capture'));
});

test('applyMove: no capture when last stone lands in opponent\'s empty pit', () => {
  // Player 0 sows from pit 5 with 3 stones: pit 6 (store), pit 7, pit 8.
  // Last lands in pit 8 which belongs to player 1 (opponent) and is empty.
  const pits = new Array(14).fill(0);
  pits[0] = 2; // keep player 0's row non-empty so the game doesn't end this move
  pits[5] = 3;
  pits[7] = 0;
  pits[8] = 0; // opponent's empty pit, landing spot
  pits[4] = 0; // opposite of pit 8 is 12-8=4, irrelevant since not own pit
  const state = makeState(pits, 0);
  const { state: next, events } = applyMove(state, 5);

  assert.equal(next.pits[8], 1, 'stone simply stays in opponent pit');
  assert.equal(next.pits[P1_STORE], 1, 'store only got the stone passing through, not a capture');
  assert.ok(!events.some((e) => e.type === 'capture'), 'no capture across the board into opponent territory');
});

// ---------------------------------------------------------------------------
// Illegal moves
// ---------------------------------------------------------------------------

test('applyMove: throws on empty pit', () => {
  const state = newGame();
  const zeroed = { pits: state.pits.slice(), currentPlayer: 0 };
  zeroed.pits[0] = 0;
  assert.throws(() => applyMove(zeroed, 0), Error);
});

test('applyMove: throws when selecting opponent\'s pit', () => {
  const state = newGame(); // currentPlayer 0
  assert.throws(() => applyMove(state, 7), Error); // pit 7 belongs to player 1
});

test('applyMove: throws on out-of-range pit index', () => {
  const state = newGame();
  assert.throws(() => applyMove(state, -1), Error);
  assert.throws(() => applyMove(state, 14), Error);
  assert.throws(() => applyMove(state, 6), Error); // store index, not a sowing pit
  assert.throws(() => applyMove(state, 1.5), Error); // non-integer
});

// ---------------------------------------------------------------------------
// End-game sweep and winner
// ---------------------------------------------------------------------------

test('applyMove: end-game sweep collects remaining stones into the other side\'s store, sets winner', () => {
  // Player 0's row is all empty except pit 5 which has exactly 1 stone,
  // enough to empty it with this move and end the game (row all-empty).
  // Player 1's row has stones that must be swept into P2 store.
  const pits = new Array(14).fill(0);
  pits[5] = 1;
  pits[P1_STORE] = 10;
  pits[7] = 3;
  pits[9] = 2;
  pits[P2_STORE] = 5;
  const state = makeState(pits, 0);

  assert.equal(isGameOver(state), false, 'not over before the move (pit 5 still has a stone)');

  const { state: next, events } = applyMove(state, 5);

  // Pit 5's stone moves to P1 store (index 6): last stone lands in own store
  // -> extra turn, and also triggers row-empty check afterward.
  assert.equal(next.pits[5], 0);
  assert.equal(next.pits[P1_STORE], 11);

  assert.ok(isGameOver(next));
  const sweepEvents = events.filter((e) => e.type === 'sweep');
  assert.equal(sweepEvents.length, 1, 'only player 1 has remaining stones to sweep');
  assert.deepEqual(sweepEvents[0], {
    type: 'sweep',
    player: 1,
    pits: [7, 9],
    store: P2_STORE,
    count: 5,
  });
  assert.equal(next.pits[7], 0);
  assert.equal(next.pits[9], 0);
  assert.equal(next.pits[P2_STORE], 10); // 5 (prior) + 5 (swept) = 10

  const gameOverEvents = events.filter((e) => e.type === 'gameOver');
  assert.equal(gameOverEvents.length, 1);
  assert.equal(events[events.length - 1].type, 'gameOver', 'gameOver must always be last');
  assert.deepEqual(gameOverEvents[0], {
    type: 'gameOver',
    winner: 0,
    score: [11, 10],
  });

  assert.equal(winner(next), 0);
  assert.equal(totalStones(next.pits), totalStones(pits), 'stone count conserved (21 stones in this scenario)');
});

test('winner: tie game resolves to null', () => {
  // Player 0's only remaining stone (pit 5) lands exactly in their own store
  // (extra turn), emptying their row and ending the game. Player 1's
  // remaining 4 stones (pit 7) get swept into their store, tying 24-24.
  const pits = new Array(14).fill(0);
  pits[5] = 1;
  pits[P1_STORE] = 23;
  pits[7] = 4;
  pits[P2_STORE] = 20;
  const state = makeState(pits, 0);

  const { state: next, events } = applyMove(state, 5);

  assert.ok(isGameOver(next));
  assert.equal(next.pits[P1_STORE], 24);
  assert.equal(next.pits[P2_STORE], 24);
  assert.equal(winner(next), null);
  const gameOverEvent = events[events.length - 1];
  assert.equal(gameOverEvent.type, 'gameOver');
  assert.equal(gameOverEvent.winner, null);
  assert.deepEqual(gameOverEvent.score, [24, 24]);
});

// ---------------------------------------------------------------------------
// legalMoves correctness
// ---------------------------------------------------------------------------

test('legalMoves: returns only current player\'s non-empty pits', () => {
  const pits = new Array(14).fill(0);
  pits[0] = 4;
  pits[1] = 0;
  pits[2] = 1;
  pits[7] = 2;
  pits[8] = 0;

  const p0state = makeState(pits, 0);
  assert.deepEqual(legalMoves(p0state), [0, 2]);

  const p1state = makeState(pits, 1);
  assert.deepEqual(legalMoves(p1state), [7]);
});

test('legalMoves: fresh game gives all six pits for player 0', () => {
  const state = newGame();
  assert.deepEqual(legalMoves(state), [0, 1, 2, 3, 4, 5]);
});

// ---------------------------------------------------------------------------
// Determinism / purity
// ---------------------------------------------------------------------------

test('applyMove: does not mutate the input state, and is deterministic', () => {
  const state = newGame();
  const before = cloneState(state);

  const result1 = applyMove(state, 2);
  // Original state must be untouched
  assert.deepEqual(state.pits, before.pits);
  assert.equal(state.currentPlayer, before.currentPlayer);

  const result2 = applyMove(state, 2);
  assert.deepEqual(result1.state, result2.state);
  assert.deepEqual(result1.events, result2.events);

  // Ensure the returned state is a distinct object/array, not an alias of input
  assert.notEqual(result1.state.pits, state.pits);
});

// ---------------------------------------------------------------------------
// Event-script integrity: stone conservation at every step
// ---------------------------------------------------------------------------

test('event script conserves total stone count (48) throughout a played-out game', () => {
  let state = newGame();
  assert.equal(totalStones(state.pits), TOTAL_STONES);

  let guard = 0;
  while (!isGameOver(state) && guard < 500) {
    guard += 1;
    const moves = legalMoves(state);
    assert.ok(moves.length > 0, 'current player must have a legal move while game is not over');
    const pit = moves[0];
    const { state: next, events } = applyMove(state, pit);

    assert.equal(totalStones(next.pits), TOTAL_STONES);

    for (const event of events) {
      assert.ok(
        ['pickup', 'sow', 'capture', 'extraTurn', 'sweep', 'gameOver'].includes(event.type),
        `unexpected event type: ${event.type}`
      );
    }

    state = next;
  }

  assert.ok(guard < 500, 'game should terminate well within 500 plies');
  assert.ok(isGameOver(state));
  assert.equal(totalStones(state.pits), TOTAL_STONES);
  assert.ok([0, 1, null].includes(winner(state)));
});

test('isGameOver / winner: undefined winner while game is still in progress', () => {
  const state = newGame();
  assert.equal(isGameOver(state), false);
  assert.equal(winner(state), undefined);
});
