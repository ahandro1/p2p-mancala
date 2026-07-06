# Default Skin — Art Style Reference ("Arcade" theme)

The default board/stone theme must recreate the **late-2000s Flash game aesthetic** (Club Penguin Mancala reference screenshot, provided by user 2026-07-06). Layout/placement of our board is NOT taken from the reference — only the art style. All art must be original CSS/SVG recreations of the *style*, never copied assets.

## Overall look
- Glossy, cartoonish, bold, high-saturation "arcade" style.
- Thick rounded corners everywhere; every major shape has a dark outline plus an inner highlight, giving a plasticky sticker look.
- Depth via simple radial/linear gradients (gloss), not realism.

## Palette
| Role | Color guidance |
|---|---|
| App/panel background | Bright azure→cyan vertical gradient top (`#29b8f2` → `#0f9ee8` zone), switching to deeper royal blue (`#0b6bc4`-ish) on the lower section |
| Panel frame | Rounded-rect panel with thick pale-cyan/white border (~4-6px) and darker navy outer edge |
| Board | Glossy golden yellow (`#f2c400` core), darker amber/orange shading (`#c98a00`) around edges and pit rims; subtle top-edge highlight |
| Pits | Oval depressions: radial gradient — darker amber shadow at top rim, lighter yellow toward bottom (inset look). Stores are tall rounded slots, same treatment |
| Stones | Candy-colored glossy discs: red `#e02a2a`, green `#22b53a`, blue `#2a6de0`, cyan `#28c7e8`, magenta/purple `#d02ad0` — each with a slightly darker outline (~2px) and a small white-ish specular highlight; stones overlap in loose clusters inside pits |
| Accent/buttons | Glossy circular blue buttons (like the reference close button): radial sky-blue gradient, white ring border, dark navy outline, bold white glyph |

## Typography
- Player names / headings: bold ITALIC comic-style display font, white (or pale blue for player 2) with dark navy outline and slight drop shadow. Free Google Fonts candidates in order of fit: **"Lilita One"**, "Luckiest Guy", "Bangers" (italic/skew via CSS transform since these lack true italics).
- Scores/counters/body: clean heavy sans (system stack or "Nunito" bold), dark navy or black.

## Implementation notes (Phase 4)
- Achievable with pure CSS gradients + `box-shadow` (inset for pits, outer for panel depth) + `border`; stones as inline SVG or CSS-gradient circles.
- Expose everything through the `themes.css` custom-property contract so other skins swap cleanly; this "arcade" theme is `:root` default.
- Live count badges should match the style: small glossy navy-outlined white pills.
- Google Fonts loaded via `<link>` is acceptable ($0, no build step); include system-font fallback.
