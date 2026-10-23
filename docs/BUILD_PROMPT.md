# Build prompt — Kub Coffee website

Paste everything inside the code block into Claude Code, run from the repo root on branch `claude/serene-lamport-vynz0h`.

```text
ROLE
You are a senior front-end engineer and product designer shipping a production café website.
Read CLAUDE.md first; it is the source of truth for brand, RTL, accessibility and performance rules.
Use the project skills: `impeccable` for design direction and the final audit/polish,
`webapp-testing` for browser QA. Do not use any other design skill.

GOAL
A fast, accessible, bilingual one-page site for "كُوب – Kub Coffee", Daraa, Syria, that makes a
visitor on a phone know within 5 seconds: what Kub is, whether it is open now, where it is, and
what it serves. Arabic first (RTL) at /, English at /en/.

──────────────────────────────────────────────────────────────────────
1. STACK & STRUCTURE
──────────────────────────────────────────────────────────────────────
- Static HTML5 + one CSS file + vanilla JS (< 10 KB min+gzip, ES modules, no frameworks, no jQuery).
- Node is allowed ONLY as a build tool (devDependencies): sharp, html-validate, @axe-core/playwright,
  @playwright/test, @lhci/cli. Nothing from npm ships to the browser.
- Layout:
  src/
    templates/        page.html (single template rendered twice: ar + en)
    i18n/ar.json en.json   all UI strings; no hard-coded copy in templates
    css/main.css
    js/main.js        tabs, open-now, language switch
    assets/img/       generated, not hand-edited
    assets/fonts/
  site.config.json    every business fact (see §3)
  scripts/build.mjs   renders ar/en, fills config, inlines critical CSS, hashes asset filenames
  scripts/images.mjs  PDF → AVIF/WebP pipeline (see §5)
  scripts/check.mjs   release guard (see §8)
  scripts/deploy.mjs  pushes dist/ to a deploy branch (see §9)
  dist/               build output (gitignored on the work branch)
- npm scripts: build, images, test, lhci, check, deploy:staging, deploy:production.

──────────────────────────────────────────────────────────────────────
2. DESIGN DIRECTION
──────────────────────────────────────────────────────────────────────
- Run `impeccable shape` first and write the result to DESIGN.md (tokens, type scale, spacing,
  components, motion). Use docs/reference/starbucks-DESIGN.md only as a model for the document's
  structure — never copy its colours, fonts, logo or wording.
- Mood: warm, natural, cosy — espresso-brown joinery, olive upholstery, cream walls, oak, hanging
  plants, black line-art baristas. Premium but neighbourly, not luxury-cold.
- Tokens (CLAUDE.md): --espresso #3A2A1F text · --cream #E6DCC3 background · --olive #4B5130 CTA
  (cream text) · --oak #A9773F decorative only · --ink #111 line art. No teal. Components use
  var(--token) only.
- Type: IBM Plex Sans Arabic (400/600/700) + Inter (400/600), self-hosted woff2, subset to Arabic +
  Latin ranges, font-display: swap, preload only the hero weight. Fluid scale with clamp().
  Arabic line-height ≥ 1.6. Never letter-spacing on Arabic.
- Signature element: recreate the café's black line-art barista mural as a light inline SVG
  divider/illustration (original drawing, aria-hidden, never mirrored in RTL).
- Motion: subtle only, 150–250 ms, transform/opacity only, fully disabled under
  prefers-reduced-motion.
- Mobile-first; content max-width ~72rem; generous whitespace; no carousels, no autoplay,
  no parallax, no cookie banner (no tracking is used).

──────────────────────────────────────────────────────────────────────
3. DATA — site.config.json (single source of truth)
──────────────────────────────────────────────────────────────────────
Every business fact lives here; templates, JSON-LD and the menu read from it.
Values marked "demo": true are SAMPLE data for customer review on staging only.

{
  "env": "staging",
  "siteUrl": "https://azure-duck-212941.hostingersite.com",
  "name": { "ar": "كُوب", "en": "Kub Coffee", "full": "كُوب – Kub Coffee" },
  "tagline": {
    "ar": "قهوة مختصة في قلب درعا — طبيعية ودافئة",
    "en": "Specialty coffee in the heart of Daraa — natural and cosy"
  },
  "address": {
    "mapsUrl": "https://maps.app.goo.gl/WNXz17zu2BQNytkv7?g_st=aw",
    "streetAddress": "{{RESOLVE_FROM_MAPS}}",
    "addressLocality": "Daraa",
    "addressCountry": "SY",
    "geo": { "lat": "{{RESOLVE_FROM_MAPS}}", "lng": "{{RESOLVE_FROM_MAPS}}" }
  },
  "timezone": "Asia/Damascus",
  "hours": {
    "demo": true,
    "sat": ["08:00", "23:00"], "sun": ["08:00", "23:00"], "mon": ["08:00", "23:00"],
    "tue": ["08:00", "23:00"], "wed": ["08:00", "23:00"], "thu": ["08:00", "23:59"],
    "fri": ["14:00", "23:59"]
  },
  "contact": {
    "demo": true,
    "phone": "+963 999 000 000",
    "whatsapp": "+963999000000"
  },
  "social": {
    "demo": true,
    "instagram": "#demo-instagram",
    "facebook": "#demo-facebook"
  },
  "currency": { "code": "SYP", "label": { "ar": "ل.س", "en": "SYP" } },
  "menu": {
    "demo": true,
    "sections": [
      { "id": "hot", "ar": "مشروبات ساخنة", "en": "Hot Drinks", "items": [
        { "en": "Espresso", "ar": "إسبريسو", "price": 150 },
        { "en": "Doppio", "ar": "دوبيو", "price": 200 },
        { "en": "Macchiato", "ar": "ماكياتو", "price": 180 },
        { "en": "Americano", "ar": "أمريكانو", "price": 180 },
        { "en": "Cappuccino", "ar": "كابتشينو", "price": 250 },
        { "en": "Latte", "ar": "لاتيه", "price": 260 },
        { "en": "Mocha", "ar": "موكا", "price": 280 },
        { "en": "Hot Chocolate", "ar": "شوكولا ساخنة", "price": 250 },
        { "en": "White Hot Chocolate", "ar": "شوكولا بيضاء ساخنة", "price": 270 }
      ]},
      { "id": "iced", "ar": "مشروبات باردة", "en": "Iced Drinks", "items": [
        { "en": "Iced Espresso", "ar": "إسبريسو مثلج", "price": 170 },
        { "en": "Iced Doppio", "ar": "دوبيو مثلج", "price": 220 },
        { "en": "Iced Macchiato", "ar": "ماكياتو مثلج", "price": 230 },
        { "en": "Iced Americano", "ar": "أمريكانو مثلج", "price": 200 },
        { "en": "Iced Cappuccino", "ar": "كابتشينو مثلج", "price": 270 },
        { "en": "Iced Latte", "ar": "لاتيه مثلج", "price": 280 },
        { "en": "Iced Mocha", "ar": "موكا مثلجة", "price": 300 },
        { "en": "Iced White Mocha", "ar": "موكا بيضاء مثلجة", "price": 310 }
      ]},
      { "id": "nuts", "ar": "نكهات المكسرات", "en": "Nut Flavours",
        "note": { "ar": "أضف نكهة لأي مشروب", "en": "Add to any drink" }, "items": [
        { "en": "Pecan", "ar": "بيكان", "price": 50 },
        { "en": "Pistachio", "ar": "فستق حلبي", "price": 60 },
        { "en": "Peanut", "ar": "فول سوداني", "price": 40 },
        { "en": "Almond", "ar": "لوز", "price": 50 },
        { "en": "Hazelnut", "ar": "بندق", "price": 50 },
        { "en": "Walnut", "ar": "جوز", "price": 50 }
      ]}
    ]
  }
}

Address rule: open the mapsUrl short link (follow redirects) and read the place name, street address
and the coordinates from the final URL (the "@lat,lng" or "!3d…!4d…" part). Write them into the config.
If the link cannot be resolved, keep the {{RESOLVE_FROM_MAPS}} placeholders, still link the
"Get directions" button to mapsUrl, and tell me at the end. Never guess an address or coordinates.

Do not add menu items, claims ("best in Daraa", awards, ratings, reviews) or facts not in this file.

──────────────────────────────────────────────────────────────────────
4. PAGE CONTENT (same structure in ar and en)
──────────────────────────────────────────────────────────────────────
<header> logo wordmark (text, not an image) · nav: Menu / Gallery / Visit · language switch
         (links to the equivalent page, lang + hreflang attributes, labelled "English" / "العربية").
<main>
1. Hero — <h1> = name.full; tagline; live "Open now · until 23:00" / "Closed · opens 08:00"
   badge computed client-side in Asia/Damascus (no-JS fallback: the full week in a <details>,
   because a build-time "today" would be wrong); address line;
   primary CTA "View menu" (#menu), secondary CTA "Get directions" (mapsUrl, rel="noopener").
   Hero image = entrance render (PDF page 2).
2. Menu — <h2>; WAI-ARIA tabs (role tablist/tab/tabpanel, roving tabindex, Arrow keys mapped to
   visual direction so RTL Left = next, Home/End). Without JS all three sections render stacked.
   Each item: name (other-language name in smaller text, wrapped in <bdi>) and price
   formatted with Intl.NumberFormat for the page locale + currency label. Render as <dl> or a
   table, not divs.
3. Values strip — "طبيعي · NATURAL" and "دافئ · COSY" from the café's wall plaques, with the
   line-art SVG.
4. Gallery — <h2>; 6 renders in a responsive grid, each <figure> with <figcaption> naming the zone
   (Entrance, Bar, Seating, Service counter, Mural wall, Window bench) and a visible "Concept /
   تصور" tag. No lightbox library; optional native <dialog> enlarge.
5. Visit — <h2>; address + "Get directions"; full hours table (<table> with <caption>, today's row
   highlighted); "Call" (tel:, dir="ltr") and "WhatsApp" (https://wa.me/<number>) buttons; no
   embedded Google Maps iframe (performance + privacy) — use a static link card instead.
</main>
<footer> name.full · address · hours summary · social links · © year (build-time).
Also: 404.html (bilingual, links home), favicon.svg + apple-touch-icon.png + manifest.webmanifest.

Staging only: a slim, dismissible banner "نسخة تجريبية — الأسعار والمعلومات للعرض فقط /
Demo version — prices and contact details are samples" whenever any config value has "demo": true.

──────────────────────────────────────────────────────────────────────
5. IMAGES
──────────────────────────────────────────────────────────────────────
- scripts/images.mjs: extract the embedded renders from "COFFE CUP.pdf" (pages 2–8) with
  `pdfimages -j` (poppler), skip the decorative/stock images (cover building, slide decorations,
  thank-you slide), then with sharp produce AVIF (q≈50) + WebP (q≈72) at 480/960/1600w.
  Never upscale beyond the source width. Strip metadata.
- <picture> with AVIF → WebP → JPEG fallback, srcset + sizes, explicit width/height, decoding="async".
- Hero: ≤ 120 KB at the mobile size, <link rel="preload" as="image" imagesrcset imagesizes>,
  fetchpriority="high", never lazy. Everything below the fold: loading="lazy".
- Alt text written by hand, specific to the scene and locale, e.g.
  ar: "واجهة كُوب الزجاجية مع لافتة الشعار المضيئة والجلسات الخشبية"
  en: "Kub's glass entrance with the illuminated logo sign and wooden seating".
  Decorative SVG/illustrations: alt="" / aria-hidden="true". Never auto-generated alt text.

──────────────────────────────────────────────────────────────────────
6. RTL / I18N (from CLAUDE.md — non-negotiable)
──────────────────────────────────────────────────────────────────────
- / → <html lang="ar" dir="rtl">, /en/ → <html lang="en" dir="ltr">.
- CSS logical properties only; zero physical left/right/margin-left/padding-right in layout CSS
  (add an html-validate/grep check that fails the build if found).
- Mirror only directional icons via [dir="rtl"] .icon-directional { transform: scaleX(-1); }.
- <bdi> around mixed-direction runs (English names in Arabic, prices, phone numbers).
- Western digits in tel:, wa.me, datetime and JSON-LD. Display digits: one system per locale,
  consistent across the page.

──────────────────────────────────────────────────────────────────────
7. SEO, SCHEMA & HOSTING
──────────────────────────────────────────────────────────────────────
- Per page: unique <title> ("كُوب – Kub Coffee | قهوة مختصة في درعا"), meta description
  (≤ 155 chars), canonical, hreflang ar / en / x-default → /, Open Graph + Twitter card
  (1200×630 image generated from the hero), theme-color = --espresso.
- JSON-LD @type CafeOrCoffeeShop: name, url, image, address (PostalAddress), geo, telephone,
  openingHoursSpecification, servesCuisine "Coffee", priceRange, currenciesAccepted "SYP",
  hasMenu (Menu → MenuSection → MenuItem with Offer price + priceCurrency), sameAs.
  Built from site.config.json only. Omit sameAs/telephone while they are demo values.
  Validate with schema.org rules (no errors, no warnings for required fields).
- env=staging: <meta name="robots" content="noindex, nofollow">, robots.txt "Disallow: /",
  no sitemap. env=production: indexable, robots.txt with Sitemap line, sitemap.xml with both
  locales and xhtml:link alternates.
- .htaccess (Hostinger LiteSpeed): force HTTPS + strip www; LiteSpeed cache on for HTML (short TTL);
  Brotli/gzip; `Cache-Control: public, max-age=31536000, immutable` for hashed /assets/;
  security headers: Content-Security-Policy (default-src 'self'; script-src 'self'; no inline
  event handlers; JSON-LD in <script type="application/ld+json"> is data and is not blocked),
  Strict-Transport-Security, X-Content-Type-Options, Referrer-Policy strict-origin-when-cross-origin,
  Permissions-Policy (camera/mic/geolocation off); ErrorDocument 404 /404.html; correct MIME for
  .avif .webp .woff2 .webmanifest.

──────────────────────────────────────────────────────────────────────
8. QUALITY GATES (all must pass before you say "done")
──────────────────────────────────────────────────────────────────────
- html-validate: zero errors. One <h1> per page, no skipped heading levels.
- Playwright (webapp-testing skill), both locales at 320, 375, 768, 1280 px:
  · no horizontal overflow (document.scrollingElement.scrollWidth ≤ innerWidth)
  · every interactive element ≥ 44×44 px with ≥ 8 px gap
  · zero console errors / failed requests
  · tabs fully keyboard-operable in RTL and LTR; visible focus everywhere
  · no-JS run: all content readable, menu stacked
  · screenshots saved to screenshots/ for review
- axe-core: zero serious/critical violations; all text pairs ≥ 4.5:1 (≥ 3:1 large text).
- Lighthouse CI (mobile, env=production build, 3 runs median): Performance, Accessibility,
  Best Practices, SEO all ≥ 95; LCP < 2.5 s, CLS < 0.1, TBT < 150 ms. Fix and re-run until green.
- Budget: total transfer of first view ≤ 350 KB, JS ≤ 10 KB, CSS ≤ 30 KB, fonts ≤ 120 KB.
- Finish with `impeccable audit` then `impeccable polish` and apply what they find.
- scripts/check.mjs (runs before every deploy):
  · staging: warns listing every demo value and unresolved {{…}} placeholder
  · production: FAILS if any "demo": true remains, any {{…}} remains, or siteUrl contains
    "hostingersite.com".

──────────────────────────────────────────────────────────────────────
9. DEPLOYMENT (Hostinger auto-deploys from GitHub)
──────────────────────────────────────────────────────────────────────
- Work branch: claude/serene-lamport-vynz0h (source only; dist/ gitignored).
- `npm run deploy:staging`: build with env=staging → check → commit the CONTENTS of dist/ to the
  root of branch deploy-staging (use a git worktree; that branch contains only built files) → push.
  Hostinger deploys it to azure-duck-212941.hostingersite.com within ~1 minute.
- `npm run deploy:production`: same with env=production to branch deploy-production
  (only after I approve; check.mjs must pass).
- Never put COFFE CUP.pdf, CLAUDE.md, .claude/, docs/, node_modules or source maps on a deploy branch.

──────────────────────────────────────────────────────────────────────
10. WORKING RULES
──────────────────────────────────────────────────────────────────────
- Plan first: list files, then build in small commits with clear messages.
- Ask me before adding any dependency not listed in §1 or any third-party request at runtime.
- Do not invent facts beyond §3. Demo values stay marked demo.
- When done, report: Lighthouse scores, bundle sizes, screenshots path, the staging URL, and a
  table of every remaining demo/placeholder value I must replace before production.
```
