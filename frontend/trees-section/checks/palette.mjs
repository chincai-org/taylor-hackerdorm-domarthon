import { assert, open, PETRI, withBrowser } from "./browser.mjs";

// Name the channel explicitly: Chromium's HTML `fill` is meaningless black.
const PROBES = [
  ["accepted node word", ".h-node.s-accepted .h-word", "fill"],
  ["rejected node word", ".h-node.s-rejected .h-word", "fill", true],
  ["accepted glyph", ".g-pass", "fill"],
  ["rejected glyph stroke", ".g-fail", "stroke", true],
  ["pending glyph stroke", ".g-wait", "stroke"],
  ["selected node hit", '.h-node[href="#s-he-08"] .hit', "fill"],
  ["selected node backdrop", '.h-node[href="#s-he-08"] .backdrop', "fill"],
  ["nav link", ".topnav a", "color"],
  ["breadcrumb link", ".crumbs a", "color"],
  ["record eyebrow", ".eyebrow", "color"],
  ["body text", ".np-hyp", "color"],
  ["chip checked bg", ".chip-input:checked + .chip", "backgroundColor"],
  ["seg checked bg", ".seg-input:checked + label", "backgroundColor"],
  ["verdict accepted bg", ".verdict.v-accepted", "backgroundColor"],
  ["verdict rejected bg", ".verdict.v-rejected", "backgroundColor", true],
  ["page surface", "body", "backgroundColor"],
  ["plate surface", ".tree-plate", "backgroundColor"],
];

function hsv(css) {
  const match = css.match(/([\d.]+)[, ]+([\d.]+)[, ]+([\d.]+)/);
  if (!match) return null;
  const [red, green, blue] = match.slice(1).map((value) => Number(value) / 255);
  const maximum = Math.max(red, green, blue);
  const delta = maximum - Math.min(red, green, blue);
  if (delta === 0 || maximum === 0) return { hue: null, saturation: 0 };
  let hue;
  if (maximum === red) hue = ((green - blue) / delta) % 6;
  else if (maximum === green) hue = (blue - red) / delta + 2;
  else hue = (red - green) / delta + 4;
  return {
    hue: Math.round((hue * 60 + 360) % 360),
    saturation: delta / maximum,
  };
}

await withBrowser(async (page) => {
  await open(page);
  const values = await page.evaluate(
    (probes) =>
      probes.map(([label, selector, channel, isFailure]) => {
        const element = document.querySelector(selector);
        return {
          label,
          isFailure,
          value: element ? getComputedStyle(element)[channel] : "MISSING",
        };
      }),
    PROBES,
  );
  const failures = [];
  for (const { label, value, isFailure } of values) {
    const color = hsv(value);
    let verdict = "unreadable";
    if (color) {
      if (isFailure) {
        verdict =
          color.saturation >= 0.12 && (color.hue <= 30 || color.hue >= 340)
            ? "failure red (expected)"
            : "NOT RED";
      } else if (color.saturation < 0.12) {
        verdict = "neutral";
      } else {
        verdict = color.hue >= 190 && color.hue <= 275 ? `blue (hue ${color.hue})` : "NOT BLUE";
      }
    }
    if (["unreadable", "NOT RED", "NOT BLUE"].includes(verdict))
      failures.push(`${label}: ${value}`);
    console.log(`${label.padEnd(24)} ${value.padEnd(24)} ${verdict}`);
  }

  // The real narrow tree contains accepted and pending descendants of rejected nodes.
  // SVG nodes are flat; test the nested HTML list where ancestor leakage occurred.
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, PETRI);
  const nested = await page.evaluate(() => {
    const styles = getComputedStyle(document.documentElement);
    return [...document.querySelectorAll(".t-node")].map((node) => {
      const word = node.querySelector(":scope > .t-row .t-word");
      const role = node.classList.contains("s-accepted")
        ? "primary"
        : node.classList.contains("s-rejected")
          ? "error"
          : "on-surface-dim";
      return {
        text: word.textContent,
        actual: getComputedStyle(word).color,
        expected: styles.getPropertyValue(`--md-sys-color-${role}`).trim(),
      };
    });
  });
  assert.ok(nested.length > 0, "Real nested list was measured");
  for (const node of nested) {
    const expected = await page.evaluate((color) => {
      const probe = document.createElement("span");
      probe.style.color = color;
      document.body.append(probe);
      const value = getComputedStyle(probe).color;
      probe.remove();
      return value;
    }, node.expected);
    assert.equal(node.actual, expected, `${node.text} uses its own status colour`);
  }
  assert.deepEqual(failures, [], "Palette hue checks");
  console.log("All non-failure chrome sits in the blue family; nested status colours match.");
});
