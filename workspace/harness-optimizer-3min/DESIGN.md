# Design system — Sharpmon 3-minute pitch

## Canvas and master
- Canvas: 1280 × 720, 16:9.
- Safe padding: 72px left/right, 24px top/bottom.
- Zone A title block: y=24–120px.
- Zone B content: y=120–660px.
- Zone C footer: y=660–696px.
- Footer: project name left, page number right, 14px muted text.
- Content must stay within the safe area; no fixed child heights may exceed the 720px canvas.

## Color pool
- Background / ink: #0F172A
- Primary blue: #3B82F6
- Secondary cyan: #06B6D4
- Text / neutral: #F7F4EC
- Use opacity variations of these colors for muted text, borders, and soft fills. No additional hex colors.
- Supporting pages: primary ≤60%, secondary ≤20%, emphasis ≤5%, remaining neutral/opacity.
- Hero pages: emphasis can reach 15–20% through cyan/blue glow and large anchor shapes.
- Gradient: linear-gradient(135deg, #3B82F6 0%, #06B6D4 100%) only on the hero accent bar and selected node markers.
- Transparency: use rgba versions of the four colors for background glow and cards; keep text fully opaque.

## Typography
- Primary family: Aptos / Arial fallback.
- Technical labels: Consolas / Courier New fallback.
- Cover title: 64px, bold, line-height 1.05.
- Page title: 36px, bold, line-height 1.2.
- Section title: 26px, bold.
- Body: 22px, regular, line-height 1.45.
- Labels: 15px, bold, uppercase, letter-spacing 1.2px.
- Footer: 14px, regular.

## Visual language
- Dark canvas, quiet grid lines, bright connected nodes, rounded rectangles, sharp hierarchy.
- Prefer inline SVG diagrams for the tree and loop; no photos or generated illustrations are necessary.
- One dominant visual anchor per page: title on page 1, harness stack on page 2, loop on page 3, giant evidence/tree motif on page 4.
- Keep the deck demo-ready: legibility over decoration.

## Page mapping
| #   | File     | Type    | Role       | Layout                             | Visual             |  Density | Whitespace | Key constraint                          |
| --- | -------- | ------- | ---------- | ---------------------------------- | ------------------ | -------: | ---------: | --------------------------------------- |
| 01  | 01.slide | cover   | hero       | full-width dark field + title      | L1 inline tree SVG | 35 words |        35% | title left; tree motif fills right half |
| 02  | 02.slide | content | supporting | left rail + right stacked layers   | Diagram / evidence | 80 words |        25% | show 4 harness layers and consequence   |
| 03  | 03.slide | content | hero       | asymmetric loop                    | L1 inline loop SVG | 95 words |        20% | judge step is the visual focus          |
| 04  | 04.slide | ending  | hero       | giant score anchor + evidence tree | L1 inline tree SVG | 55 words |        40% | close on the action: Improve this node  |
