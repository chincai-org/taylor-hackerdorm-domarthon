// Dumps the resolved colour of every semantic element, so the palette can be
// checked as values instead of by eye. Also flags any hue that is not in the
// blue family — accepted/selected chrome should be blue, only failure red.
//
// Each probe names the CSS channel to read. This matters: for an HTML element
// Chromium reports `fill` as a meaningless `rgb(0, 0, 0)`, not `none`, so a
// probe that "falls back to color when fill is none" silently reports black.
import { createRequire } from "node:module";
const require = createRequire("C:/Users/liewjayyong/.workbuddy-ai/binaries/node/workspace/");
const { chromium } = require("playwright-core");

const BASE = "file:///C:/Users/liewjayyong/WorkBuddy%20AI/2026-10-10-12-59-12/trees-section";
const TREE = "research--hermes-agent--claude-sonnet-5.html";

const PROBES = [
  ["accepted node word", ".s-accepted .h-word", "fill", false],
  ["rejected node word", ".s-rejected .h-word", "fill", true],
  ["accepted glyph", ".g-pass", "fill", false],
  ["rejected glyph stroke", ".g-fail", "stroke", true],
  ["pending glyph stroke", ".g-wait", "stroke", false],
  // The default-chosen node, not merely the first one: the hit fill comes from
  // the generated per-page rules, which only the chosen node matches.
  ["selected node hit", '.h-node[href="#s-he-08"] .hit', "fill", false],
  ["selected node backdrop", '.h-node[href="#s-he-08"] .backdrop', "fill", false],
  ["nav link", ".topnav a", "color", false],
  ["breadcrumb link", ".crumbs a", "color", false],
  ["record eyebrow", ".eyebrow", "color", false],
  ["body text", ".np-hyp", "color", false],
  ["chip checked bg", ".chip-input:checked + .chip", "backgroundColor", false],
  ["seg checked bg", ".seg-input:checked + label", "backgroundColor", false],
  ["verdict accepted bg", ".verdict.v-accepted", "backgroundColor", false],
  ["verdict rejected bg", ".verdict.v-rejected", "backgroundColor", true],
  ["page surface", "body", "backgroundColor", false],
  ["plate surface", ".tree-plate", "backgroundColor", false],
];

const b = await chromium.launch({ channel: "msedge" });
const p = await b.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
await p.goto(`${BASE}/${TREE}`, { waitUntil: "load" });
await p.waitForTimeout(1200);

const values = await p.evaluate((probes) => probes.map(([label, sel, channel, isFailure]) => {
  const el = document.querySelector(sel);
  return { label, isFailure, value: el ? getComputedStyle(el)[channel] : "MISSING" };
}), PROBES);

/** Hue in degrees, plus saturation, from an `rgb()` string. */
const hsv = (css) => {
  const m = css.match(/(\d+)[, ]+(\d+)[, ]+(\d+)/);
  if (!m) return null;
  const [r, g, bl] = [+m[1] / 255, +m[2] / 255, +m[3] / 255];
  const max = Math.max(r, g, bl), min = Math.min(r, g, bl), d = max - min;
  if (d === 0 || max === 0) return { hue: null, sat: 0 };
  let h;
  if (max === r) h = ((g - bl) / d) % 6;
  else if (max === g) h = (bl - r) / d + 2;
  else h = (r - g) / d + 4;
  return { hue: Math.round(((h * 60) + 360) % 360), sat: d / max };
};

console.log("\n=== resolved palette ===");
const flagged = [];
for (const { label, value, isFailure } of values) {
  const c = hsv(value);
  let verdict;
  if (c === null) {
    verdict = "unreadable";
    flagged.push(label);
  } else if (isFailure) {
    // Failure chrome is meant to be red; that is the one non-blue family.
    verdict = "failure red (expected)";
  } else if (c.sat < 0.12) {
    verdict = "neutral";
  } else if (c.hue >= 190 && c.hue <= 275) {
    verdict = `blue ✓ (hue ${c.hue})`;
  } else {
    verdict = `NOT BLUE (hue ${c.hue}) ✗`;
    flagged.push(label);
  }
  console.log(`${label.padEnd(24)} ${String(value).padEnd(24)} ${verdict}`);
}

console.log(
  flagged.length === 0
    ? "\nAll non-failure chrome sits in the blue family."
    : `\nFLAGGED: ${flagged.join(", ")}`,
);
await b.close();
