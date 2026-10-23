---
name: كُوب – Kub Coffee
description: The café's own wall — cream plaster, olive bench, espresso joinery, black line-art baristas.
colors:
  espresso: "#3A2A1F"
  cream: "#E6DCC3"
  olive: "#4B5130"
  oak: "#A9773F"
  ink: "#111111"
  leaf: "#9DB86B"
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
  small:
    fontFamily: "IBM Plex Sans Arabic, Inter, system-ui, sans-serif"
    fontSize: "clamp(0.875rem, 0.84rem + 0.15vw, 0.95rem)"
    fontWeight: 400
    lineHeight: 1.6
    letterSpacing: "normal"
rounded:
  board: "0.35rem"
  md: "0.75rem"
  pill: "999px"
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
    padding: "0.55rem 1.35rem"
    height: "3rem"
  button-secondary:
    backgroundColor: "transparent"
    textColor: "{colors.espresso}"
    rounded: "{rounded.md}"
    padding: "0.55rem 1.35rem"
    height: "3rem"
  button-light:
    backgroundColor: "{colors.cream}"
    textColor: "{colors.espresso}"
    rounded: "{rounded.md}"
    padding: "0.55rem 1.35rem"
    height: "3rem"
  status-pill:
    backgroundColor: "{colors.espresso}"
    textColor: "{colors.cream}"
    rounded: "{rounded.pill}"
    padding: "0.35rem 0.95rem"
  concept-tag:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.cream}"
    rounded: "{rounded.pill}"
    padding: "0.1rem 0.6rem"
  menu-board:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.cream}"
    rounded: "{rounded.board}"
    padding: "1.5rem 2.25rem 2.25rem"
---

# Design System: كُوب – Kub Coffee

## Overview

**Creative North Star: "The café's own wall"**

The site is built from the room, not from a café template. Cream plaster is the ground. An oak shelf carries a row of black line-art baristas, and a full-width olive bench band sits under them, the way the mural and banquette sit in the renders. The menu hangs as black boards under dome pendant lamps on an espresso-brown wall. Colour arrives as whole fields: a cream wall, an espresso wall, an olive bench. It never appears as scattered accents.

Arabic comes first and is never a translation layer. Every layout rule is written in logical properties so the same wall reads correctly in both directions. The voice is warm and neighbourly. Nothing on the page claims more than the café has confirmed.

**Key Characteristics:**
- Committed colour fields per section: cream → olive bench → espresso → cream → olive → espresso.
- Stroke-only black line art (round caps, about 2px, non-scaling) for the mural and plaques.
- Large, quiet Arabic display type; Latin is the companion, not the lead.
- Real interior renders, always labelled "Concept / تصوّر".

## Colors

### Primary
- **Olive** `#4B5130`: primary CTA background (cream text, 6.11:1), the bench band and the Visit field. Hover and lip shade: `color-mix(olive 78%, ink)`.

### Secondary
- **Espresso** `#3A2A1F`: all body text on cream (10.05:1), the menu wall, the footer and the status pill.

### Tertiary
- **Oak** `#A9773F`: decorative only. Used for the shelf rule, the board title rule, the active tab underline, the hero frame inner edge and the lamp glow. It is never used for text on cream (2.85:1).

### Neutral
- **Cream** `#E6DCC3`: the wall. Page background and text on every dark field.
- **Ink** `#111111`: line art, menu boards, concept tags, picture frames and the demo banner.
- **Leaf** `#9DB86B`: the open-now dot only.

### Named Rules
**The Whole-Field Rule.** A section owns one ground colour from end to end. Accents never float on a neutral template.
**The Oak-Is-Wood Rule.** Oak marks wood and light (shelves, rules, glow). It is never text.

## Typography

**Display:** IBM Plex Sans Arabic 700, used for the name كُوب.
**Body:** IBM Plex Sans Arabic 400/700 on `/`; Inter 400/600 on `/en/` and for Latin runs.

### Hierarchy
- **Display** (700, `clamp(4.5rem, 2.8rem + 8.5vw, 6rem)`, 1.1): the h1 Arabic name only.
- **Heading** (700, `clamp(2rem … 3.25rem)`, 1.15): section h2s.
- **Subheading** (700, `clamp(1.25rem … 1.5rem)`): board titles, h3s, the tagline.
- **Body** (400, `clamp(1.0625rem … 1.15rem)`, 1.7 Arabic / 1.6 Latin): measure ≤ 60ch.
- **Small** (400, about 0.9rem): secondary names, currency and tags.

### Named Rules
**The No-Tracking-On-Arabic Rule.** Never set `letter-spacing` on Arabic text; it breaks the joins. Latin headings may take −0.015em.
**The Weight-Budget Rule.** On `/`, Latin runs stay at 400 so Inter 600 is never fetched. On `/en/`, Arabic runs stay at 700 so only one Arabic face loads. This keeps fonts ≤ 120 KB per page.

## Layout

- Content width `min(100% − 2rem, 72rem)`. Section rhythm `clamp(3rem, 2rem + 4vw, 5.5rem)` block padding.
- Breakpoints: 48rem (header goes to one row, hero window appears, Visit splits in two, gallery to auto-fill 17rem) and 64rem (hero goes to two columns).
- Mobile first viewport: name, tagline, status, address and both CTAs, then the mural and bench. The hero render moves into the gallery as a full-width lead frame.
- Logical properties only. The build fails on physical `left`/`right` in `main.css`.

## Elevation & Depth

The room is flat. Depth comes from frames (espresso frame with an oak inner edge, ink picture frames), not from layered cards. Menu boards hang with one soft drop: `0 1.25rem 2.5rem -1rem rgb(0 0 0 / .55)`. The active pendant lamp casts an oak glow (`filter: blur(18px)`, opacity .6).

## Shapes

Radius `0.75rem` for buttons and the hero frame, `0.35rem` for boards, pills for the status, concept tags and social links. Plaques and picture frames are square-cornered with 3px ink borders.

## Components

### Buttons
Primary is olive with cream text. Secondary is a 2px espresso outline that fills espresso on hover. On dark fields, Light is cream with espresso text and Outline-light has a cream border. All buttons are at least 48px tall, with an icon gap of 0.6em. Directional arrows mirror in RTL.

### Chips
The **Status pill** is espresso with cream text and a leaf dot when open. The **Concept tag** is an ink pill with small cream text.

### Navigation
Text links at least 44px tall. The language switch is a pill outline, set in the other language's script.

### Menu boards (signature)
Three black boards on the espresso wall, each a WAI-ARIA tab under a dome pendant lamp. The selected lamp's bulb lights and casts an oak glow. Panels fade in over 220ms. Item rows run name, other-language name (`<bdi>`), then tabular price and currency, separated by hairline rules at 22% cream. Arrow keys follow visual direction. Without JS, all boards render stacked.

### Mural (signature)
Line-art barista figures (pouring, holding a cup, carrying a tray), tools and plants, as `<symbol>`s on an oak shelf line, sliced to fill the width. The art is never mirrored.

## Do's and Don'ts

### Do:
- **Do** give each section one whole colour field from the palette.
- **Do** label every render "Concept / تصوّر" until real photos replace it.
- **Do** wrap mixed-direction runs (English names, prices, phone numbers) in `<bdi>` or `dir="ltr"`.
- **Do** keep all business facts in `site.config.json`, and flag sample data `"demo": true`.

### Don't:
- **Don't** use the presentation deck's teal (`#3AEFCC`); it belongs to the PowerPoint template, not the café.
- **Don't** put oak behind or as text.
- **Don't** add kickers or eyebrows above headings, glyph or emoji icons, gradient text, or glass.
- **Don't** mirror the line art, the logo or the coffee-cup favicon in RTL.
- **Don't** invent claims such as awards, ratings, reviews or "best in Daraa".
