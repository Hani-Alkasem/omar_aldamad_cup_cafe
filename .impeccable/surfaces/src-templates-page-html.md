---
version: 1
slug: "src-templates-page-html"
primary_target: "src/templates/page.html"
related_targets: []
---

# Surface: Kub Coffee one-page site (ar `/`, en `/en/`)

Mode: Persuade. Audience: Daraa locals on phones (primary), students/remote workers, visitors/expats, the owner. Job: in 5 seconds know what Kub is, whether it is open now, where it is, what it serves; act = view menu / get directions / call. Proof: the interior renders (labelled Concept), the real menu from the in-store boards. Demo data (prices, hours, phone, social) is flagged and bannered. Build path: code-led (no image generation in this environment).

## Direction contract

THESIS: The page is Kub's own wall. Refuses the category default of a full-bleed photo hero with centred headline over three icon cards; instead the café's line-art barista mural and its black menu boards ARE the layout.

OWN-WORLD: Cream plaster wall ground (--cream) with a full-width olive (--olive) bench band anchoring sections; espresso (--espresso) joinery panels; black (--ink) hand-drawn line-art baristas (stroke-only inline SVG, ~2px, round caps) standing on a thin shelf rule; menu as black chalkboard panels (--ink ground, cream text) hung under black dome pendant lamps; oak only as shelf rules and frame edges. IBM Plex Sans Arabic / Inter, large and quiet. No gradients, no glass, no cards with shadows.

STORY: Visitor sees the wall and the open-now sticker, understands "cosy café in Daraa, open, here", taps View menu, reads boards, taps Get directions or Call.

FIRST VIEWPORT: Mobile: wordmark + language switch top; h1 كُوب – Kub Coffee very large on the cream wall; tagline; open-now pill; two CTAs (olive primary "View menu", outlined "Get directions") in thumb reach; line-art barista row standing on a shelf rule at the bottom edge with the olive bench band beneath. Desktop: same wall, entrance render framed like a window on the inline-end side, mural shelf spanning full width under both.

FORM: Mural wall (my rank 1 of 7; the user chose it over the assigned rank-6 cup-packaging direction). seed:777fa5d7a593fa66

SIGNATURE INTERACTION: Menu boards: three black chalkboards as WAI-ARIA tabs; switching swaps the board with a 200ms fade and the pendant lamp above the active board glows (opacity), RTL-aware arrow keys. Motion grammar: opacity/transform only, 150–250ms, none under reduced motion.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
