/**
 * main.js — single entry point (loaded via <script type="module"> in index.html).
 * Boots the app, shows a brief boot screen, then routes to the correct screen.
 */

import { CONFIG } from './config.js';
import { initDiag } from './diag.js';

/**
 * Phase 1: the diagnostics panel IS the app — always show it so the deploy
 * pipeline (GH Pages -> iframe -> Trystero -> Nostr -> WebRTC) can be proven
 * out end to end before any real game code exists.
 *
 * TODO(Phase 2+): flip this to `false`. Once real screens exist, boot should
 * route to `#screen-menu` normally, and only force the diag panel when the
 * page is loaded with `?debug=1` in the query string (see `wantsDebug()`
 * below, already wired up and ready to use).
 */
const FORCE_DIAG = true;

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

/**
 * Hides every `.screen` element and shows only the one matching `id`.
 * Exported so later phases (menu/lobby/game flow) can reuse it directly.
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
 * Will become the real gate for the diag panel once FORCE_DIAG is retired.
 * @returns {boolean}
 */
function wantsDebug() {
  try {
    return new URLSearchParams(location.search).get('debug') === '1';
  } catch {
    return false;
  }
}

async function boot() {
  showScreen('screen-boot');

  // Phase 1: route to diag unconditionally. Later: route to menu, and only
  // show diag when wantsDebug() is true (FORCE_DIAG becomes `false`).
  if (FORCE_DIAG || wantsDebug()) {
    showScreen('diag-panel');
    await initDiag();
    return;
  }

  // TODO(Phase 3): showScreen('screen-menu') + menu init goes here.
  showScreen('screen-menu');
}

boot();
