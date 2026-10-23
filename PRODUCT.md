# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Static HTML5 + one CSS file + vanilla JS (< 10 KB), Node used only as a build tool (sharp, html-validate, Playwright, axe, Lighthouse CI). Hosted on Hostinger (LiteSpeed), auto-deployed from GitHub branches `deploy-staging` (temporary domain `azure-duck-212941.hostingersite.com`) and later `deploy-production`. Specified by the user in docs/BUILD_PROMPT.md.

## Users

- **Locals on phones (primary):** Daraa residents checking the menu, whether Kub is open, and how to get there before walking in. Arabic readers, mostly on mid-range Android phones and mobile data.
- **Students and remote workers:** looking for a cosy place to sit, study or work for hours.
- **Visitors and expats:** new to Daraa, often reading the English version.
- **The client/owner:** reviews the staging site and uses it as the café's showcase.

## Product Purpose

The website for كُوب – Kub Coffee, a café in Daraa, Syria. Within seconds on a phone a visitor should know what Kub is, whether it is open now, where it is, and what it serves. Success: visitors find the menu, hours and directions without friction and choose to come in.

## Positioning

Kub is the cosy, natural space in Daraa: plants, warm wood, olive upholstery, cream walls and black line-art barista murals. A place to stay, not just a counter. The interior is the differentiator; the website should feel like walking into it.

## Operating Context

- Visitors arrive from Google Maps, Instagram/WhatsApp shares and word of mouth, usually on a phone.
- Primary actions: view menu, check open-now/hours, get directions, call or WhatsApp.
- No ordering, booking or payments online.

## Capabilities and Constraints

- Bilingual: Arabic default (RTL) at `/`, English at `/en/`.
- Menu (from the in-store boards): Hot Drinks, Iced Drinks, Nut Flavours. See CLAUDE.md for the item list.
- **Demo data:** prices, opening hours, phone/WhatsApp and social links are placeholders for staging review, flagged `"demo": true` in `site.config.json`. They must be replaced before production.
- **Unresolved:** street address and coordinates must come from the Google Maps link (https://maps.app.goo.gl/WNXz17zu2BQNytkv7). They are not yet confirmed in text.
- Imagery is CGI interior renders from `COFFE CUP.pdf`, labelled "Concept" until real photos exist.

## Brand Commitments

- Name: `كُوب – Kub Coffee`. Never "Coffe Cup".
- Colours from the interior (CLAUDE.md): espresso, cream, olive, oak (decorative), ink. No teal (it belongs to the presentation template, not the café).
- Fonts: IBM Plex Sans Arabic + Inter.
- Wall plaques "NATURAL" and "COSY" are the café's own words.
- Voice: warm and neighbourly. Short, friendly, local Arabic, like a barista talking to a regular. No hype, no superlatives.

## Evidence on Hand

- `COFFE CUP.pdf`: 9-slide interior design deck (renders of entrance, bar, seating, service counter, mural wall, bench).
- No real photos, reviews, ratings, awards, press or testimonials exist. Do not fabricate any.

## Product Principles

1. Answer "open? where? what?" before anything else.
2. The space is the story: let the interior lead, words support it.
3. Arabic is first-class, not a translation of English.
4. Fast on a weak connection beats rich on fibre.
5. Never state a fact the café hasn't confirmed.

## Accessibility & Inclusion

WCAG 2.1 AA. Tap targets ≥ 44×44 px, full keyboard support including RTL arrow mapping, reduced-motion respected, works without JavaScript.
