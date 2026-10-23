# Kub Coffee (كُوب) — website

Marketing site for **كُوب – Kub Coffee**, a café in Daraa, Syria. The brand source is the interior design deck `COFFE CUP.pdf` (3D MAX / AutoCAD renders by Omar Al Masalmeh). Target host: Hostinger (LiteSpeed).

## Brand

- **Canonical name:** `كُوب – Kub Coffee`. Use it verbatim in `<title>`, the header, footer, JSON-LD `name` and the Google Business Profile. Never "Coffe Cup".
- **Personality:** warm, natural, cosy. Taken from the interior's "NATURAL / COSY" plaques: espresso-brown joinery, olive upholstery, cream walls, oak tables, hanging plants, black line-art barista murals.
- **Do not use the deck's teal (`#3AEFCC`).** It belongs to the PowerPoint template, not the café.

### Colour tokens

Starting values sampled from the renders. Calibrate them against the physical paint/upholstery swatches before treating them as final.

```css
:root {
  --espresso: #3A2A1F; /* body text, headings, dark surfaces */
  --cream:    #E6DCC3; /* page background */
  --olive:    #4B5130; /* primary CTA background (cream text), accents */
  --oak:      #A9773F; /* decorative only: borders, dividers, illustration fills */
  --ink:      #111111; /* line-art illustrations */
}
```

| Pair | Contrast | Allowed use |
|---|---|---|
| espresso on cream | 10.05:1 | all text |
| olive on cream / cream on olive | 6.11:1 | all text, buttons |
| oak on cream | 2.85:1 | **never text**; decoration only |
| white on oak | 3.89:1 | large text ≥ 24px (or 18.66px bold) only |

Reference components to `var(--token)`, never raw hex. A dark theme, if added, must re-verify every pair at ≥ 4.5:1.

### Typography

- Arabic: **IBM Plex Sans Arabic** (fallback: Tajawal). Latin: **Inter**.
- Self-host `woff2` subsets, `font-display: swap`, preload only the weights the hero uses.
- Body ≥ 16px, line-height ≥ 1.6 for Arabic (taller ascenders and descenders than Latin).
- Never set `letter-spacing` on Arabic text. It breaks the joins between letters.

## RTL and bilingual rules

- Arabic is the default: `<html lang="ar" dir="rtl">` at `/`; English at `/en/` with `<html lang="en" dir="ltr">`.
- `hreflang` on every page: `ar`, `en` and `x-default` → `/`.
- Use **CSS logical properties only**: `margin-inline-start`, `padding-inline-end`, `inset-inline-start`, `border-inline-start`, `text-align: start`. No `left`/`right` in layout CSS.
- Flexbox/grid already follow `dir`. Do not reverse with `flex-direction: row-reverse` to "fake" RTL.
- Mirror directional icons (arrows, chevrons, "back") with `[dir="rtl"] .icon-directional { transform: scaleX(-1); }`. Never mirror logos, the coffee-cup line art or media play icons.
- Wrap embedded opposite-direction text (prices, phone numbers, English drink names inside Arabic copy) in `<bdi>` or `dir="ltr"` spans.
- Phone numbers: `<a href="tel:+963…" dir="ltr">`.
- Numerals: pick one system per locale and keep it consistent. Use Western digits in `tel:`, `datetime` and JSON-LD.
- Forms: `dir="auto"` on free-text inputs, labels always visible (no placeholder-only labels).
- Test every page in both directions at 320, 768 and 1280px.

## Menu (from the in-store boards)

- **Hot Drinks:** Espresso, Latte, Mocha, Cappuccino, Americano, Hot Chocolate, Doppio, White Hot Chocolate, Macchiato.
- **Iced Drinks:** Iced Espresso, Iced Latte, Iced Mocha, Iced Cappuccino, Iced Americano, Iced Doppio, Iced White Mocha, Iced Macchiato.
- **Nut Flavours:** Pecan, Pistachio, Peanut, Almond, Hazelnut, Walnut.

Prices, hours, address, phone and geo coordinates are **not known yet**. Ask; never invent them.

## Build requirements

- Semantic HTML5, one stylesheet, vanilla JS < 10 KB, no framework unless asked.
- Hero above the fold: name, one-line value proposition, today's hours, address + "Get directions", "View menu" CTA.
- One `<h1>` per page; headings never skip levels.
- Touch targets ≥ 44×44px with ≥ 8px spacing; no horizontal scroll at 320px; never disable zoom.
- Images: AVIF/WebP with `srcset` (480/960/1600w), explicit `width`/`height`, `loading="lazy"` below the fold; hero ≤ 120 KB, preloaded, `fetchpriority="high"`.
- Alt text describes the scene ("Kub bar counter with three-group espresso machine and hanging plants"); decorative images use `alt=""`. Never reuse auto-generated alt text.
- The renders are CGI: label gallery images "Concept" until real photos replace them.
- JSON-LD `CafeOrCoffeeShop` with `name`, `address`, `geo`, `telephone`, `openingHoursSpecification`, `hasMenu`, `servesCuisine`, `sameAs`, kept identical to the Google Business Profile.
- `sitemap.xml`, `robots.txt`, `.htaccess` with LiteSpeed cache, Brotli/gzip, HTTPS redirect and long-cache headers for `/assets/`.
- Targets: Lighthouse mobile ≥ 95 in all four categories; LCP < 2.5s, CLS < 0.1, INP < 200ms.

## Project skills

Vendored and pinned; do not auto-update. Re-review the diff before bumping a pin.

| Skill | Path | Source @ commit | Use for |
|---|---|---|---|
| Impeccable (v4.7.0, engine 0.1.16) | `.claude/skills/impeccable/` | `pbakaus/impeccable` @ `5cb95ee` (Apache-2.0) | Primary design skill: `shape`, `audit`, `critique`, `harden` (includes Arabic-script rules), `polish`. Record decisions in `DESIGN.md`. |
| webapp-testing | `.claude/skills/webapp-testing/` | `anthropics/skills` @ `dbd4588` | Playwright QA: screenshots at 320/768/1280 in both `dir`s, tap-target sizes, overflow, console errors. Chromium is at `/opt/pw-browsers`. |
| Starbucks DESIGN.md (reference) | `docs/reference/starbucks-DESIGN.md` | `VoltAgent/awesome-design-md` @ `3b60532` (MIT) | Structural model for writing Kub's own `DESIGN.md`. **Do not copy Starbucks' colours, typography, logo or naming.** |

- Use Impeccable as the only design-direction skill. Do not layer other opinionated design skills (taste-skill, ui-ux-pro-max) on top; their rules conflict.
- Impeccable's launcher (`scripts/impeccable`) downloads a platform binary from the `pbakaus/impeccable` GitHub releases into `~/.impeccable/` on first run and verifies it against its `.sha256` sidecar. To avoid the download, set `IMPECCABLE_BIN` to a reviewed binary.
