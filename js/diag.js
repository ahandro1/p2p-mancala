/**
 * diag.js — live diagnostics checklist rendered into #diag-panel.
 *
 * This proves out the whole pipeline end to end: GH Pages serving ES
 * modules -> Trystero CDN import -> Nostr relay connect -> peer discovery
 * -> WebRTC data-channel exchange. It is a permanent debug tool (not just a
 * Phase 1 throwaway) — later phases gate it behind `?debug=1` (see main.js).
 */

import { CONFIG } from './config.js';
import { connectLobby, getSelfId } from './net.js';

const CHECK_DEFS = [
  { id: 'modules', label: 'App modules loaded' },
  { id: 'trystero', label: 'Trystero library' },
  { id: 'relay', label: 'Relay connection' },
  { id: 'peers', label: 'Peer discovery' },
  { id: 'echo', label: 'Data channel echo' },
  { id: 'env', label: 'Environment' },
];

const ICON = { pending: '⏳', ok: '✅', fail: '❌', info: 'ℹ️' };

/** @type {Map<string, {status: string, detail: string}>} */
const state = new Map(CHECK_DEFS.map((c) => [c.id, { status: 'pending', detail: '' }]));

let panelEl = null;
let logEl = null;
let peers = [];
let selfShort = '??????';
let lobbyHandle = null;
let pingInFlight = false;

/**
 * Entry point — call once to build the panel and kick off all checks.
 * @returns {Promise<void>}
 */
export async function initDiag() {
  panelEl = document.getElementById('diag-panel');
  if (!panelEl) {
    console.error('diag.js: #diag-panel not found in DOM');
    return;
  }

  render();

  // Check 1: trivially true — if this code is running, ES modules loaded.
  setStatus('modules', 'ok', 'index.html -> main.js -> diag.js chain executed');

  await runTrysteroCheck();
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

async function runTrysteroCheck() {
  const t0 = performance.now();
  try {
    const netModule = await import('./net.js');
    const selfId = await getSelfId();
    selfShort = shortId(selfId);
    const trystero = await netModule.loadTrystero();
    const versionHint = trystero.version || trystero.VERSION || 'unknown version';
    setStatus('trystero', 'ok', `imported ok (${versionHint}), self=${selfShort}`);
    await runRelayAndPeerChecks(netModule, t0);
  } catch (err) {
    setStatus('trystero', 'fail', errText(err));
    // Downstream checks can't run without the library, but mark them
    // clearly instead of leaving them stuck on the spinner forever.
    setStatus('relay', 'fail', 'skipped: trystero failed to load');
    setStatus('peers', 'fail', 'skipped: trystero failed to load');
    setStatus('echo', 'fail', 'skipped: trystero failed to load');
  }
  // Environment check has no dependency on the network at all — always run it.
  runEnvCheck();
}

/** Relay-status re-check cadence/duration (ms) — see pollRelayStatus() below. */
const RELAY_POLL_INTERVAL_MS = 2000;
const RELAY_POLL_DURATION_MS = 20000;

async function runRelayAndPeerChecks(netModule, t0) {
  try {
    lobbyHandle = await connectLobby();
    const elapsed = Math.round(performance.now() - t0);

    setStatus('relay', 'ok', `room join resolved in ${elapsed}ms, checking relay sockets…`);
    pollRelayStatus(lobbyHandle, elapsed);

    setupPeerDiscovery(lobbyHandle);
    setupEcho(lobbyHandle);
  } catch (err) {
    setStatus('relay', 'fail', errText(err));
    setStatus('peers', 'fail', 'skipped: room join failed');
    setStatus('echo', 'fail', 'skipped: room join failed');
  }
}

/**
 * getRelaySockets() reflects each relay's WebSocket at the instant it's
 * called — right after connectLobby() resolves, the sockets are typically
 * still in CONNECTING state (readyState 0), so a single read shows "0/N
 * open" and, since nothing re-renders the row afterward, that stale count
 * would otherwise persist forever even once relays finish connecting.
 * Poll every RELAY_POLL_INTERVAL_MS for RELAY_POLL_DURATION_MS so the row
 * converges to the true open count, then stop (sockets that are still
 * closed after 20s are treated as settled/failed, not perpetually pending).
 * @param {import('./net.js').RoomHandle} lobby
 * @param {number} elapsed - ms from check start to room join, for the label
 */
function pollRelayStatus(lobby, elapsed) {
  const start = performance.now();

  const check = () => {
    let relayDetail = `room join resolved in ${elapsed}ms`;
    try {
      const sockets = lobby.trystero.getRelaySockets?.();
      if (sockets && typeof sockets === 'object') {
        const urls = Object.keys(sockets);
        const openCount = urls.filter(
          (u) => sockets[u] && sockets[u].readyState === 1
        ).length;
        relayDetail = `${openCount}/${urls.length} relay socket(s) open, joined in ${elapsed}ms`;
      }
    } catch {
      // getRelaySockets not available in this build — fall back silently.
    }
    setStatus('relay', 'ok', relayDetail);

    if (performance.now() - start < RELAY_POLL_DURATION_MS) {
      setTimeout(check, RELAY_POLL_INTERVAL_MS);
    }
  };

  check();
}

function setupPeerDiscovery(lobby) {
  const refreshPeers = () => {
    peers = lobby.getPeers();
    const list = peers.map(shortId).join(', ') || '(none yet)';
    setStatus(
      'peers',
      'ok',
      `you=${selfShort} · ${peers.length} peer(s): ${list}`
    );
  };

  lobby.onPeerJoin(() => refreshPeers());
  lobby.onPeerLeave(() => refreshPeers());
  refreshPeers();
}

function setupEcho(lobby) {
  setStatus('echo', 'pending', 'waiting for a message from another peer…');

  lobby.on('diagChat', (data, meta) => {
    if (data && data.kind === 'chat') {
      appendChatLine(shortId(meta.peerId), data.text, false);
      setStatus('echo', 'ok', 'received from remote peer');
    }
  });

  render(); // now that #diag-chat-log etc. exist, wire up controls
  wireEchoControls(lobby);
}

function runEnvCheck() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const touch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  const inIframe = window.self !== window.top;
  const ua = shortUserAgent(navigator.userAgent);
  const protocol = location.protocol;
  const protoOk = protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1';

  setStatus(
    'env',
    protoOk ? 'info' : 'fail',
    `${w}x${h} · touch=${touch} · iframe=${inIframe} · ${protocol} · ${ua}`
  );
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function setStatus(id, status, detail) {
  state.set(id, { status, detail });

  // Prefer patching the existing row in place over a full render(). render()
  // rebuilds the whole panel's innerHTML — including the chat log, input,
  // form, and ping button — which would wipe chat history and orphan the
  // listeners wireEchoControls() attached to those elements. That's fine
  // for the very first render (nothing to preserve yet) but must be avoided
  // for repeat status updates that happen after setupEcho() has already
  // wired the controls, e.g. the relay-status poll's periodic re-checks.
  const rowEl = panelEl?.querySelector(`.diag-row[data-check="${id}"]`);
  if (rowEl) {
    const icon = ICON[status] || ICON.pending;
    rowEl.dataset.status = status;
    const iconEl = rowEl.querySelector('.diag-icon');
    const detailEl = rowEl.querySelector('.diag-detail');
    if (iconEl) iconEl.textContent = icon;
    if (detailEl) detailEl.textContent = detail;
    return;
  }

  render();
}

function render() {
  if (!panelEl) return;

  const rows = CHECK_DEFS.map(({ id, label }) => {
    const { status, detail } = state.get(id);
    const icon = ICON[status] || ICON.pending;
    return `
      <li class="diag-row" data-check="${id}" data-status="${status}">
        <span class="diag-icon" aria-hidden="true">${icon}</span>
        <span class="diag-label">${escapeHtml(label)}</span>
        <span class="diag-detail">${escapeHtml(detail)}</span>
      </li>`;
  }).join('');

  panelEl.innerHTML = `
    <div class="diag-card">
      <h1 class="diag-title">Mancala P2P — Diagnostics</h1>
      <ul class="diag-list">${rows}</ul>

      <div class="diag-chat" id="diag-chat">
        <h2 class="diag-subtitle">Data channel test</h2>
        <div class="diag-chat-log" id="diag-chat-log" role="log" aria-live="polite"></div>
        <form id="diag-chat-form" class="diag-chat-form" autocomplete="off">
          <label class="sr-only" for="diag-chat-input">Message</label>
          <input
            id="diag-chat-input"
            class="diag-chat-input"
            type="text"
            maxlength="${CONFIG.chatMaxLen}"
            placeholder="Type a test message…"
          />
          <button type="submit" class="diag-btn" id="diag-chat-send">Send</button>
        </form>
        <button type="button" class="diag-btn diag-btn-secondary" id="diag-ping-btn">
          Ping peers
        </button>
        <div class="diag-ping-result" id="diag-ping-result"></div>
      </div>

      <footer class="diag-footer">
        v${escapeHtml(CONFIG.version)} · ${escapeHtml(CONFIG.appId)}
      </footer>
    </div>`;

  logEl = document.getElementById('diag-chat-log');
}

function wireEchoControls(lobby) {
  const form = document.getElementById('diag-chat-form');
  const input = document.getElementById('diag-chat-input');
  const pingBtn = document.getElementById('diag-ping-btn');
  const pingResult = document.getElementById('diag-ping-result');

  if (form) {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      appendChatLine(selfShort, text, true);
      lobby.send('diagChat', { kind: 'chat', text }).catch((err) => {
        appendChatLine('system', `send failed: ${errText(err)}`, false);
      });
      input.value = '';
    });
  }

  if (pingBtn) {
    pingBtn.addEventListener('click', async () => {
      if (pingInFlight) return;
      pingInFlight = true;
      const currentPeers = lobby.getPeers();
      if (currentPeers.length === 0) {
        pingResult.textContent = 'No peers connected yet — open this page in another tab/device.';
        pingInFlight = false;
        return;
      }
      pingResult.textContent = 'Pinging…';
      try {
        const results = await Promise.all(
          currentPeers.map(async (peerId) => {
            const ms = await lobby.ping(peerId);
            return `${shortId(peerId)}: ${Math.round(ms)}ms`;
          })
        );
        pingResult.textContent = results.join(' · ');
      } catch (err) {
        pingResult.textContent = `ping failed: ${errText(err)}`;
      }
      pingInFlight = false;
    });
  }
}

function appendChatLine(who, text, isSelf) {
  if (!logEl) return;
  const line = document.createElement('div');
  line.className = 'diag-chat-line' + (isSelf ? ' diag-chat-line--self' : '');
  line.innerHTML = `<span class="diag-chat-who">${escapeHtml(who)}:</span> ${escapeHtml(text)}`;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function shortId(id) {
  return typeof id === 'string' ? id.slice(0, 6) : '??????';
}

function shortUserAgent(ua) {
  const m = /(Chrome|Firefox|Safari|Edg|OPR)\/[\d.]+/.exec(ua || '');
  return m ? m[0] : (ua || 'unknown').slice(0, 40);
}

function errText(err) {
  return err && err.message ? err.message : String(err);
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}
