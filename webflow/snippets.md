# Embedding Mancala in Webflow

This game is a static site hosted on GitHub Pages, embedded into your Webflow
page via an `<iframe>`. Webflow never sees the game code directly — it just
points an iframe at the deployed URL.

## 1. Add the Custom Element in Webflow

1. In the Webflow Designer, open the **Add panel** (the `+` icon).
2. Go to the **Advanced** section and drag a **Custom Element** (this is the
   same thing Webflow sometimes labels **DOM Element**) onto your page.
3. In the Custom Element's settings, set:
   - **Tag**: `iframe`
4. Add these **attributes** on the element:

   | Attribute | Value |
   |---|---|
   | `src` | `https://ahandro1.github.io/p2p-mancala/play/` |
   | `allow` | `fullscreen` |
   | `loading` | `lazy` |
   | `title` | `Mancala` |

   Do not forget the trailing slash on `src` — this site lives at a GitHub
   Pages *subpath* (`/REPO-NAME/`), and all the game's internal links/assets
   are relative, so the trailing slash matters for them to resolve correctly.

## 2. Sizing

1. Select the Custom Element and give it a new Webflow **class** (e.g.
   `mancala-embed`).
2. Set on that class:
   - **Width**: `100%`
   - **Height**: `85vh`
   - **Border**: `none`
3. Tune the height to taste once you see the real board layout — 85vh is a
   reasonable starting point that leaves room for your page's header/nav
   above the fold on most devices. If the game feels cramped on mobile,
   try a fixed min-height (e.g. `min-height: 600px`) alongside the `vh`
   value.

## 3. Fallback plan (if Webflow strips the iframe on publish)

Webflow's publish pipeline occasionally sanitizes raw HTML embeds depending
on plan/settings. If the iframe doesn't survive publishing:

1. Add a normal Webflow **Button** or **Link Block** with text like
   **"Play Mancala"**.
2. Set its link to the same deployed URL
   (`https://ahandro1.github.io/p2p-mancala/play/`).
3. Set the link's **Open in new tab** option to **on**.
4. Style it like any other Webflow button — this becomes the safety net so
   players can always reach the game even if the embed doesn't render
   in-page.

## 4. How to test (matches the diagnostics panel)

Open the deployed URL (or the Webflow page with the embed) and confirm each
row on the diagnostics screen goes green:

- [ ] **App modules loaded** — turns green immediately. If this fails, the
      page 404'd on a JS file; check that `src`/paths are relative and the
      GitHub Pages deploy includes every file under `js/` and `css/`.
- [ ] **Trystero library** — confirms the CDN import worked. A failure here
      usually means no internet access to esm.run/jsDelivr, or a browser
      blocking third-party scripts.
- [ ] **Relay connection** — confirms we reached a Nostr relay. Can be slow
      (a few seconds) on first load; if it never resolves, check for a
      network/firewall blocking WebSocket connections.
- [ ] **Peer discovery** — open the same URL in a second tab, device, or
      browser. You should see the peer count increase and a short peer ID
      appear on both sides within a few seconds.
- [ ] **Data channel echo** — with two tabs/devices open, type a message on
      one and confirm it appears on the other (and vice versa). This
      confirms a real WebRTC data channel formed peer-to-peer. Use the
      **Ping peers** button to see round-trip latency between the two.
- [ ] **Environment** — sanity-check the reported viewport size, touch
      support, and that `iframe=true` shows when tested inside the actual
      Webflow embed (vs. `iframe=false` when opened directly on GitHub
      Pages).

If every row is green (or informational, for Environment) in at least two
simultaneous sessions, the full pipeline — GitHub Pages, ES modules, Trystero,
Nostr signaling, and WebRTC data channels — is confirmed working end to end.

**Troubleshooting browsers cache:** After a new deploy, browsers may serve cached game code for up to 10 minutes (GitHub Pages sets `max-age=600`). To bypass the cache during testing, use a private/incognito window.

## 5. HTMLtoFlow wrapper test

`webflow/htmltoflow-wrapper.html` is a self-contained HTML+CSS package — the
decorative "arcade" panel shell that will surround the game iframe once it's
live on the Webflow page. It's built to paste cleanly into the **HTMLtoFlow**
Webflow Designer app (which converts vanilla HTML+CSS into native Webflow
elements/classes on a free plan): one flat class per element, simple class
selectors only, literal colors, no scripts/iframes/links of its own.

### What to paste where

- If HTMLtoFlow takes one combined paste, paste the entire file as-is.
- If it has separate CSS and HTML boxes, split the file at the
  `<!-- ===== SPLIT HERE ===== -->` comment: everything above goes in the
  CSS box, everything from `<section class="mancala-shell">` down goes in
  the HTML box.

### What a successful conversion should look like

HTMLtoFlow should produce one Webflow element per tag below, each carrying
exactly the one class listed (Webflow combo classes only keep the *first*
class in a multi-class attribute, so this file was written with a single
class per element to avoid losing any):

| Element | Expected Webflow class |
|---|---|
| `<section>` (outer wrapper) | `mancala-shell` |
| `<h1>` "MANCALA" | `mancala-title` |
| `<p>` subtitle | `mancala-subtitle` |
| `<div>` empty embed placeholder | `mancala-embed-slot` |
| `<a>` "Play Mancala" button | `mancala-play-btn` |
| `<p>` footer line | `mancala-footnote` |

If HTMLtoFlow renames classes or merges elements, rename/re-split them back
to this table before moving on — later steps assume these exact class names.

### What to check after publish

- [ ] **Panel background** — vertical azure-to-royal-blue gradient on
      `mancala-shell`, with a thick pale border and a dark drop-shadow
      "sticker" edge underneath.
- [ ] **Rounded corners** — the outer shell, the embed slot, and the play
      button all show visibly rounded/pill corners (Webflow sometimes drops
      `border-radius` on conversion — re-add it manually on the class if so).
- [ ] **Title styling** — "MANCALA" renders bold, italic, white, with a
      visible offset shadow; not plain unstyled text.
- [ ] **Embed slot visible** — `mancala-embed-slot` shows as a tall
      (~85vh), dashed-border box so it's easy to find in the Designer's
      layers panel. The HTML comment inside it may be stripped by
      HTMLtoFlow — that's expected and fine, the div itself is the marker.
- [ ] **Button hover** — hovering `mancala-play-btn` in the Designer's
      preview (or published site) brightens the gold gradient and the
      button appears to "press" slightly (shadow shrinks). If the hover
      state didn't survive conversion, re-create it manually as an
      Interaction/state on the class.
- [ ] **Button links out correctly** — it points at
      `https://ahandro1.github.io/p2p-mancala/play/`, same as the iframe `src` in section 1.
- [ ] **No stray elements** — HTMLtoFlow shouldn't have invented extra
      wrapper divs beyond normal Webflow structure; if it did, that's
      usually harmless but worth a glance.

### Reminder: the iframe is added by hand, not by HTMLtoFlow

This wrapper's `mancala-embed-slot` div is deliberately left **empty** —
HTMLtoFlow never sees or generates an iframe, because raw `<iframe>` tags
are outside what this package includes (and Webflow strips scripts/iframes
from arbitrary pasted HTML on free plans anyway). After the conversion test
looks right:

1. Select the converted `mancala-embed-slot` div in the Designer.
2. Follow **section 1 and 2 above** to add the iframe **Custom Element**
   *inside* that div (same `src` placeholder, `allow`/`loading`/`title`
   attributes, and `mancala-embed` sizing class already documented there).
3. Delete the leftover HTML comment/placeholder content inside the div, if
   any survived conversion.
4. Keep the `mancala-play-btn` fallback link live until the iframe is
   confirmed working end-to-end (see section 4's diagnostics checklist),
   then hide or remove it in Webflow if you no longer need the safety net.
