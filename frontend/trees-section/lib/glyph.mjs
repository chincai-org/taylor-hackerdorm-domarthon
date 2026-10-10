/**
 * Status glyphs — a port of the reference `components/Glyph.tsx`.
 *
 * Shape carries the meaning first and colour second, so the tree still reads
 * with colour removed:
 *   accepted   a filled circle
 *   rejected   a ring with a cross
 *   contested  a triangle
 *   anything else (pending, withdrawn, superseded) a ring with a dot
 *
 * Every caller draws at a different radius — 5 in the card, 5.5 in the list,
 * 8 in the big tree — so the geometry is derived from `r` rather than fixed.
 */

/** Rounds to one decimal so emitted path data stays short and stable. */
const r1 = (v) => Math.round(v * 10) / 10;

export function glyph(status, x, y, r) {
  const cx = r1(x);
  const cy = r1(y);
  const arm = r1(r * 0.53);

  switch (status) {
    case "accepted":
      return `<circle class="g-pass" cx="${cx}" cy="${cy}" r="${r}"/>`;

    case "rejected":
      return (
        `<g><circle class="g-hollow g-fail" cx="${cx}" cy="${cy}" r="${r}"/>` +
        `<path class="g-x" d="M${r1(x - arm)} ${r1(y - arm)}L${r1(x + arm)} ${r1(y + arm)}` +
        `M${r1(x + arm)} ${r1(y - arm)}L${r1(x - arm)} ${r1(y + arm)}"/></g>`
      );

    case "contested":
      return `<path class="g-hollow g-wait" d="M${cx} ${r1(y - r)}L${r1(x + r)} ${r1(y + r * 0.8)}L${r1(x - r)} ${r1(y + r * 0.8)}Z"/>`;

    default:
      return (
        `<g><circle class="g-hollow g-wait" cx="${cx}" cy="${cy}" r="${r}"/>` +
        `<circle class="g-dot" cx="${cx}" cy="${cy}" r="${r1(r * 0.28)}"/></g>`
      );
  }
}
