// Two things the clipboard test cannot cover:
//  1. the fallback path (no `navigator.clipboard`) — forced by deleting the API,
//     because Edge reports even file:// as a secure context;
//  2. that the icon actually draws, and at the intended size.
import { createRequire } from "node:module";
const require = createRequire("C:/Users/liewjayyong/.workbuddy-ai/binaries/node/workspace/");
const { chromium } = require("playwright-core");

const BASE = "file:///C:/Users/liewjayyong/WorkBuddy%20AI/2026-10-10-12-59-12/trees-section";
const TREE = "research--hermes-agent--claude-sonnet-5.html";

const b = await chromium.launch({ channel: "msedge" });
const ctx = await b.newContext({
  viewport: { width: 1440, height: 900 },
  colorScheme: "dark",
  permissions: ["clipboard-read", "clipboard-write"],
});
const p = await ctx.newPage();

// --- icons ---
await p.goto(`${BASE}/${TREE}`, { waitUntil: "load" });
await p.waitForTimeout(900);
await p.evaluate(() => document.getElementById("record")?.scrollIntoView());
await p.waitForTimeout(300);

const btn = p.locator('.rec[data-for="he-08"] button.copy[data-copy="pnpm petri digest"]').first();
const box = await btn.boundingBox();
console.log("\n--- icon button ---");
console.log("button box:", JSON.stringify(box), "(32x32, so it clears the 24px tap minimum)");
console.log("clipboard glyph drawn:", await p.evaluate(() => {
  const svg = document.querySelector('.rec[data-for="he-08"] button.copy[data-copy="pnpm petri digest"] .icon-copy');
  const r = svg.getBoundingClientRect();
  return { w: Math.round(r.width), h: Math.round(r.height), paths: svg.querySelectorAll("path").length, stroke: getComputedStyle(svg).stroke };
}));
console.log("tick glyph hidden at rest:", await p.evaluate(() => {
  const svg = document.querySelector('.rec[data-for="he-08"] button.copy[data-copy="pnpm petri digest"] .icon-copied');
  return svg.getBoundingClientRect().height === 0;
}));

// Screenshot just the command row, so the icon can be eyeballed at true size.
await p.locator('.rec[data-for="he-08"] .checkit-cmd').first().screenshot({
  path: "C:/Users/liewjayyong/WorkBuddy AI/2026-10-10-12-59-12/shots/6-copy-icon.png",
});
await btn.hover();
await p.waitForTimeout(200);
await p.locator('.rec[data-for="he-08"] .checkit-cmd').first().screenshot({
  path: "C:/Users/liewjayyong/WorkBuddy AI/2026-10-10-12-59-12/shots/7-copy-icon-hover.png",
});

// --- the fallback ---
console.log("\n--- fallback with navigator.clipboard removed ---");
await p.evaluate(() => {
  // Simulate a genuinely insecure context, which Edge will not give us on file://.
  Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
});
console.log("navigator.clipboard now:", await p.evaluate(() => navigator.clipboard));
const before = await p.evaluate(() => document.execCommand.toString().includes("native"));
console.log("execCommand is native (so the fallback has something real to call):", before);

await btn.click();
await p.waitForTimeout(300);
console.log("tick shown via fallback:", await p.evaluate(() =>
  document.querySelector('.rec[data-for="he-08"] button.copy[data-copy="pnpm petri digest"] .icon-copied')
    .getBoundingClientRect().height > 0));
console.log("announcement:", await p.evaluate(() =>
  document.querySelector('.rec[data-for="he-08"] button.copy[data-copy="pnpm petri digest"]')?.nextElementSibling?.textContent));

// The same row after a successful copy: the tick, in place, inside the box.
await p.locator('.rec[data-for="he-08"] .checkit-cmd').first().screenshot({
  path: "C:/Users/liewjayyong/WorkBuddy AI/2026-10-10-12-59-12/shots/8-copy-done.png",
});

await b.close();
