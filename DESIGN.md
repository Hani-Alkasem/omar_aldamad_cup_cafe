---
name: كُوب – Kub Coffee
description: The café's own wall: cream plaster, its hand-drawn barista mural, the olive bench, espresso joinery and black menu boards.
colors:
  espresso: "#3A2A1F"
  cream: "#E6DCC3"
  olive: "#4B5130"
  oak: "#A9773F"
  ink: "#111111"
  wall-shade: "#CEC3AC"
  text-soft: "#564639"
  on-dark-soft: "#CAC0A9"
  oak-chalk: "#C4A47A"
  board-frame: "#281F19"
typography:
  display:
    fontFamily: "IBM Plex Sans Arabic, Inter, Tajawal, system-ui, sans-serif"
    fontSize: "clamp(4.5rem, 2.8rem + 8.5vw, 6rem)"
    fontWeight: 700
    lineHeight: 1.1
    letterSpacing: "normal"
  heading:
    fontFamily: "IBM Plex Sans Arabic, Inter, system-ui, sans-serif"
    fontSize: "clamp(2rem, 1.5rem + 2.4vw, 3.25rem)"
    fontWeight: 700
    lineHeight: 1.15
    letterSpacing: "normal"
  subheading:
    fontFamily: "IBM Plex Sans Arabic, Inter, system-ui, sans-serif"
    fontSize: "clamp(1.25rem, 1.15rem + 0.5vw, 1.5rem)"
    fontWeight: 700
    lineHeight: 1.15
    letterSpacing: "normal"
  body:
    fontFamily: "IBM Plex Sans Arabic, Inter, Tajawal, system-ui, sans-serif"
    fontSize: "clamp(1.0625rem, 1.02rem + 0.2vw, 1.15rem)"
    fontWeight: 400
    lineHeight: 1.7
    letterSpacing: "normal"
  body-latin:
    fontFamily: "Inter, IBM Plex Sans Arabic, system-ui, sans-serif"
    fontSize: "clamp(1.0625rem, 1.02rem + 0.2vw, 1.15rem)"
    fontWeight: 400
    lineHeight: 1.6
    letterSpacing: "normal"
  hand:
    fontFamily: "Aref Ruqaa, IBM Plex Sans Arabic, serif"
    fontSize: "clamp(1.25rem, 1.15rem + 0.5vw, 1.5rem)"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
  hand-large:
    fontFamily: "Aref Ruqaa, IBM Plex Sans Arabic, serif"
    fontSize: "clamp(1.6rem, 1.25rem + 1.4vw, 2.2rem)"
    fontWeight: 400
    lineHeight: 1.35
    letterSpacing: "normal"
  small:
    fontFamily: "IBM Plex Sans Arabic, Inter, system-ui, sans-serif"
    fontSize: "clamp(0.875rem, 0.84rem + 0.15vw, 0.95rem)"
    fontWeight: 400
    lineHeight: 1.6
    letterSpacing: "normal"
rounded:
  hairline: "2px"
  focus: "0.2rem"
  md: "0.3rem"
spacing:
  xs: "0.5rem"
  sm: "0.75rem"
  md: "1rem"
  lg: "1.5rem"
  xl: "2.25rem"
  section: "clamp(3rem, 2rem + 4vw, 5.5rem)"
components:
  button-primary:
    backgroundColor: "{colors.olive}"
    textColor: "{colors.cream}"
    rounded: "{rounded.md}"
    padding: "0.55rem 1.4rem"
    height: "3rem"
  button-light:
    backgroundColor: "{colors.cream}"
    textColor: "{colors.espresso}"
    rounded: "{rounded.md}"
    padding: "0.55rem 1.4rem"
    height: "3rem"
  text-link:
    textColor: "{colors.espresso}"
    height: "2.75rem"
  menu-board:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.cream}"
    rounded: "{rounded.hairline}"
    padding: "1.5rem 2.25rem 2.25rem"
---

# Design System: كُوب – Kub Coffee

## Overview

**Creative North Star: "The café's own wall"**

The page is built from the room and from things people in the room made, not from a template. Cream plaster is the ground. The first screen is the café's real hand-drawn mural: the shelf of coffee tools, the NATURAL and COSY plaques and five baristas, cut out of the design renders as ink. It stands on a full-width olive bench band. Short hand-lettered Ruqaa notes, the script of Syrian shop signs and handwritten menus, sit beside the set type the way a note sits beside a printed menu. The menu hangs as black boards under dome pendant lamps on an espresso-brown wall.

Arabic comes first and is never a translation layer, and the copy talks the way people in Daraa talk ("مفتوحين هلّق، لـ ١١ بالليل"). Every layout rule is written in logical properties. Nothing on the page claims more than the café has confirmed.

**Key Characteristics:**
- The café's own mural, never a redrawn or generated imitation, carries the first viewport.
- Committed colour fields per section: cream wall → olive bench → espresso wall → cream → olive → espresso.
- Set type (IBM Plex Sans Arabic / Inter) for facts; hand-lettered Ruqaa for short asides only.
- Spoken times and colloquial copy; no em dashes, no grey ledes under headings.
- Real renders in an uneven editorial spread, each captioned "· تصوّر / · concept".

## Colors

### Primary
- **Olive** `#4B5130`: the primary button (cream text, 6.11:1), the bench band, the Visit field and hand-lettered notes on cream. Hover and bench lip shade: `color-mix(olive 78%, ink)`.

### Secondary
- **Espresso** `#3A2A1F`: all set text on cream (10.05:1), the menu wall and the footer.

### Tertiary
- **Oak** `#A9773F`: wood and light only. Used for the board title rule, the active tab underline, the today underline, link hover underlines and the lamp glow. It is never used for text on cream (2.85:1).
- **Oak chalk** `#C4A47A` (oak 55% + cream): hand-lettered notes on the espresso wall.

### Neutral
- **Cream** `#E6DCC3`: the wall. Page background and text on every dark field.
- **Ink** `#111111`: the mural, menu boards and the skip link.
- **Wall shade** `#CEC3AC`: the staging demo notice.
- **Text soft** `#564639` / **On-dark soft** `#CAC0A9`: secondary text on cream and on dark fields.
- **Board frame** `#281F19`: the board edge.

### Named Rules
**The Whole-Field Rule.** A section owns one ground colour from end to end. Accents never float on a neutral template.
**The Oak-Is-Wood Rule.** Oak marks wood and light (rules, underlines, glow). It is never text on cream.

## Typography

**Set:** IBM Plex Sans Arabic 400/700 on `/`; Inter 400/600 on `/en/` and for Latin runs.
**Hand:** Aref Ruqaa 400 for short notes only, subset at build time to exactly the characters the notes use.

### Hierarchy
- **Display** (700, `clamp(4.75rem, 3rem + 8vw, 6rem)`, 1.05): the h1 Arabic name only.
- **Heading** (700, `clamp(2.1rem … 3.4rem)`): section h2s.
- **Subheading** (700, `clamp(1.25rem … 1.5rem)`): board titles, h3s, the status line.
- **Hand / Hand-large** (Ruqaa 400): the tagline under the name, the section asides and the footer sign-off. Rotated −1.5° to −2°.
- **Body** (400, `clamp(1.0625rem … 1.15rem)`, 1.7 Arabic / 1.6 Latin).
- **Small** (400, about 0.9rem): secondary names, currency and captions.

### Named Rules
**The Note-Not-Copy Rule.** Ruqaa is for one-line asides a person would scribble: never headings, menu items, prices, hours or buttons.
**The No-Tracking-On-Arabic Rule.** Never set `letter-spacing` on Arabic text.
**The Weight-Budget Rule.** On `/`, Latin runs stay at 400; on `/en/`, Arabic runs stay at 700. Fonts are about 139 KB on `/` and about 97 KB on `/en/`.

## Layout

- Content width `min(100% − 2rem, 72rem)`. Section rhythm `clamp(3.25rem, 2rem + 4.5vw, 6rem)`.
- **Masthead:** the name and note at start, the status line, address and actions at end, aligned to the bottom (≥ 64rem). Below that, they stack.
- **Mural:** a full-bleed crop on phones (3:2, bottom-anchored, middle figures). On wider screens it sits at its natural ratio, up to `min(64rem, 46vh × 2.36)`, so the bench stays in the first viewport.
- **Gallery spread:** 12 columns × 12rem rows (≥ 64rem): entrance 7×3, seating 5×2, olive wall 5×1, mural 5×2, bar 4×2, counter 3×3, prep corner 9×1. On phones, entrance, mural and prep corner run full width, with the others in pairs.
- Logical properties only. The build fails on physical `left`/`right`.

## Elevation & Depth

The room is flat. Menu boards hang with one soft drop, `0 1.25rem 2.5rem -1rem rgb(0 0 0 / .55)`, and the active pendant lamp casts an oak glow (`blur(18px)`, opacity .6). Nothing else has a shadow.

## Shapes

Radius `0.3rem` on buttons, `2px` on boards and photos, `0.2rem` on focus rings. There are no pills anywhere.

## Components

### Buttons and links
There is one solid action per area: **Primary** (olive with cream text) on cream and **Light** (cream with espresso text) on olive. Everything else is a **text link**: bold, 2px underline at a 0.35em offset, oak underline on hover, at least 44px tall. Directional arrows mirror in RTL.

### Status line
A plain sentence, not a badge. The bold lead ("مفتوحين هلّق" in olive when open) is followed by the spoken time, and it is computed in Asia/Damascus. Without JS, the full week shows in a `<details>`.

### Navigation
Plain text links in the header; the language switch is an underlined link set in the other language's script.

### Wall mural (signature)
`wall-mural-*.avif|webp|png`, the café's mural cut out of render 007-010. Dark, low-chroma pixels are kept, plant colours are dropped, specks under 40px are removed, and the result is upscaled 2× with a steepened alpha ramp. It carries descriptive alt text and is never mirrored.

### Menu boards (signature)
Three black boards on the espresso wall, each a WAI-ARIA tab under a dome pendant lamp. The selected lamp lights and glows. Panels fade in over 220ms. Rows run name, other-language name (`<bdi>`), then tabular price and currency. Without JS, all boards stack.

## Do's and Don'ts

### Do:
- **Do** use the café's own artwork and photos before drawing anything new.
- **Do** write the way people in Daraa speak: short, warm, colloquial.
- **Do** say times as spoken ("٨ الصبح", "نص الليل", "8am", "midnight").
- **Do** label every render as a concept until real photos replace it.
- **Do** keep all business facts in `site.config.json`, and flag samples `"demo": true`.

### Don't:
- **Don't** use the deck's teal (`#3AEFCC`).
- **Don't** redraw the mural as vector clip-art or generate stand-in illustrations.
- **Don't** use pills, badges or chips for status, tags or links.
- **Don't** put a grey lede paragraph under every heading, or use em dashes in copy.
- **Don't** add kickers or eyebrows, glyph or emoji icons, gradient text, or glass.
- **Don't** invent claims such as awards, ratings, reviews or "best in Daraa".
