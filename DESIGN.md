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

> Rewritten for the Blue Bottle-style redesign. Tokens in the frontmatter above predate it; the stylesheet `src/css/main.css` `:root` is the source of truth until the next documenter pass.

## Overview

**Creative North Star: "A quiet room for good coffee"**

Calm, premium specialty-café presentation: a warm paper ground, large photography, one bilingual type family, thin rules and generous space. Colour is used sparingly and in whole fields: espresso for the announcement bar, menu call-to-action and footer; olive for the flavours band; cream for buttons on dark. The logo is the word كُوب set in IBM Plex Sans Arabic 600.

## Colors
- **Paper** `#F6F1E7`: page ground. **Paper deep** `#EFE8DA`: tiles. **Rule** `#DDD2BF`: hairlines.
- **Espresso** `#3A2A1F`: text, primary buttons, dark bands. **Text soft** `#5E4D40`.
- **Cream** `#E6DCC3`: buttons and text on dark. **Olive** `#4B5130`: flavours band and button hover. **Oak** `#A9773F`: reserved.

## Typography
IBM Plex Sans Arabic 400/600 + IBM Plex Sans 400/500. Hero `clamp(2.6rem…5rem)`, section h2 `clamp(1.75rem…2.75rem)`, lead statement `clamp(1.45rem…2.3rem)`, body `clamp(1.0625rem…1.15rem)`.

## Layout
Content width `min(100% − 2.5rem, 78rem)`; section rhythm `clamp(4rem…8rem)`. Header: nav, centred logo, language (≥ 64rem); on phones logo + language, then the nav row. Home: hero → statement → 4 drink tiles → two alternating photo features → flavours band → visit → photo strip → footer. Menu: title, sticky jump bar (single scrolling row), sections with a sticky photo beside the list.

## Components
- **Buttons:** espresso (on paper) or cream (on dark), 2px radius. Everything else is an underlined text link with an arrow that nudges on hover.
- **Drink tile:** 4:5 photo, name, other-language name, one-line description, price.
- **Status line:** dot + bold lead + spoken time, computed in Asia/Damascus.

## Do's and Don'ts
- **Do** keep one solid action per area and lots of space.
- **Do** write alt text by hand for every photo.
- **Don't** copy another brand's logo, colours or wording.
- **Don't** add pills, gradients (except the hero legibility scrim), glass or decorative icons.
