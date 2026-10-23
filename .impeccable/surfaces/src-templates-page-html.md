---
version: 1
slug: "src-templates-page-html"
primary_target: "src/templates/page.html"
related_targets: []
---

# Surface: Kub Coffee one-page site (ar `/`, en `/en/`)

Mode: Persuade. Audience: Daraa locals on phones (primary), students/remote workers, visitors/expats, the owner. Job: in 5 seconds know what Kub is, whether it is open now, where it is, what it serves; act = view menu / get directions / call. Proof: the café's own mural and interior renders (labelled concept), the real menu from the in-store boards. Demo data (prices, hours, phone, social) is flagged and bannered. Build path: code-led (no image generation in this environment).

Revision 2 (user feedback: "looks AI-built"): replaced the split hero, the vector stick-figure mural, pills, em-dash copy and the uniform card grid with the café's real mural cut-out, Ruqaa hand notes, colloquial copy, text links and an uneven editorial spread.

## Direction contract

THESIS: The page is Kub's own wall, made of things people in the room made: its hand-drawn barista mural, its plaques, its menu boards. Refuses the category default (split hero, photo beside headline, badge row, equal cards) and refuses imitation material (redrawn or generated illustrations).

OWN-WORLD: Cream plaster ground (--cream); the café's real ink mural (shelf, NATURAL/COSY plaques, five baristas) standing on a full-width olive bench band; espresso wall with black chalkboard panels hung under black dome pendant lamps; oak only as rules, underlines and lamp glow. IBM Plex Sans Arabic / Inter for facts, Aref Ruqaa for short scribbled asides, rotated slightly. No pills, no gradients, no glass, no card grids.

STORY: Visitor sees the name, a handwritten line, a spoken open-now sentence and the café's own mural; understands "small cosy café in Daraa, open, here"; taps See the menu, reads the boards, taps Show me the way or Call.

FIRST VIEWPORT: Mobile: wordmark + English link; nav row; h1 كُوب very large with Kub Coffee small; Ruqaa tagline; status sentence; address; olive "See the menu" button and underlined "Show me the way" link in thumb reach; the mural cropped 3:2 to the middle baristas, standing on the olive bench at the bottom edge. Desktop: name + note at start, status/address/actions bottom-aligned at end, the full mural centred below at natural ratio with the bench inside the viewport.

FORM: Mural wall (my rank 1 of 7; the user chose it over the assigned rank-6 cup-packaging direction). seed:777fa5d7a593fa66

SIGNATURE INTERACTION: Menu boards: three black chalkboards as WAI-ARIA tabs; switching swaps the board with a 220ms fade and the pendant lamp above the active board glows, RTL-aware arrow keys. Motion grammar: opacity/transform only, 150–250ms, none under reduced motion.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
