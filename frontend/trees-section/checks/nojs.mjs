// The headline constraint: everything must work with JavaScript disabled.
// Anchors must still swap the strip and the record panel; the Tree|Stats switch
// and the info chips must still work, because they are radio groups in CSS.
import { createRequire } from "node:module";
const require = createRequire("C:/Users/liewjayyong/.workbuddy-ai/binaries/node/workspace/");
const { chromium } = require("playwright-core");
const BASE = "file:///C:/Users/liewjayyong/WorkBuddy%20AI/2026-10-10-12-59-12/trees-section";

const b = await chromium.launch({ channel: "msedge" });
const ctx = await b.newContext({ javaScriptEnabled: false, colorScheme: "dark" });
const p = await ctx.newPage();
await p.setViewportSize({ width: 1440, height: 900 });

const read = () => p.evaluate(() => {
  const shown = (s) => [...document.querySelectorAll(s)].filter((e) => e.getBoundingClientRect().height > 0);
  return {
    strips: shown(".selected-strip").length,
    panels: shown(".node-panel").length,
    strip: shown(".selected-strip")[0]?.dataset.for ?? null,
    panel: shown(".node-panel")[0]?.querySelector(".np-hyp")?.textContent?.trim() ?? null,
    tree: !!document.querySelector(".view-tree")?.getBoundingClientRect().height,
    stats: !!document.querySelector(".view-stats")?.getBoundingClientRect().height,
  };
});

// `load` never settles on a file:// URL with scripting off, and we do not need
// it to: waiting for the DOM is enough to measure CSS-only behaviour.
const OPEN = { waitUntil: "domcontentloaded", timeout: 15000 };

await p.goto(`${BASE}/research--hermes-agent--claude-sonnet-5.html`, OPEN);
await p.waitForTimeout(500);
console.log("no-JS initial: ", JSON.stringify(await read()));

// The headline interaction: an anchor inside the SVG must swap the strip AND the
// record panel, with no script at all. This is the whole point of the design.
await p.click('.h-node[href="#s-he-07"]');
await p.waitForTimeout(300);
console.log("no-JS click he-07:", JSON.stringify(await read()));

// The list view is the narrow-screen tree; its rows must work the same way.
// It is `display: none` above 700px, so the viewport has to come down first.
await p.setViewportSize({ width: 390, height: 844 });
await p.goto(`${BASE}/research--hermes-agent--claude-sonnet-5.html`, OPEN);
await p.waitForTimeout(400);
await p.click('.t-row[href="#s-he-02"]');
await p.waitForTimeout(300);
console.log("no-JS narrow click he-02:", JSON.stringify(await read()));
await p.setViewportSize({ width: 1440, height: 900 });

// "Full record" points at the version's own record id, so following it must keep
// the same version on show while scrolling to it. This is the case that used to
// silently reset the page to its default.
await p.click('.selected-strip[data-for="he-02"] a[href="#s-he-02"]');
await p.waitForTimeout(300);
console.log("no-JS after Full record:", JSON.stringify(await read()));

// "Show as a table" is a <details>, so it needs no script either.
await p.goto(`${BASE}/index.html`, OPEN);
await p.waitForTimeout(400);
const cards = await p.evaluate(() => [...document.querySelectorAll("a.card")].map((a) => a.getAttribute("href")));
console.log("no-JS gallery links:", cards.length, cards.slice(0, 3).join(" "));

await b.close();
