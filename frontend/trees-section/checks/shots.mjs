// Screenshots of every page, for eyeballing the theme. Writes to ../shots/.
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
const require = createRequire("C:/Users/liewjayyong/.workbuddy-ai/binaries/node/workspace/");
const { chromium } = require("playwright-core");

const BASE = "file:///C:/Users/liewjayyong/WorkBuddy%20AI/2026-10-10-12-59-12/trees-section";
const OUT = "C:/Users/liewjayyong/WorkBuddy AI/2026-10-10-12-59-12/shots";
mkdirSync(OUT, { recursive: true });

// Playwright defaults to light mode; every page here is dark-only.
const b = await chromium.launch({ channel: "msedge" });
const p = await b.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
const open = async (name) => {
  await p.goto(`${BASE}/${name}`, { waitUntil: "load" });
  await p.waitForTimeout(1400);
};

const TREE = "research--hermes-agent--claude-sonnet-5.html";

await open("index.html");
await p.screenshot({ path: `${OUT}/1-gallery.png` });

await open(TREE);
await p.screenshot({ path: `${OUT}/2-tree.png` });

await p.evaluate(() => document.getElementById("record")?.scrollIntoView());
await p.waitForTimeout(400);
await p.screenshot({ path: `${OUT}/3-record.png` });

await p.click('label[for="view-stats"]');
await p.waitForTimeout(400);
await p.screenshot({ path: `${OUT}/4-stats.png` });

await p.setViewportSize({ width: 390, height: 844 });
await open(TREE);
await p.screenshot({ path: `${OUT}/5-mobile.png` });

// Close-ups of the two command blocks, to check the copy control reads as part
// of the box rather than as something floating under it.
await p.setViewportSize({ width: 1440, height: 900 });
await open(TREE);

const fork = p.locator('.rec[data-for="he-08"] .np-block.fork');
await fork.scrollIntoViewIfNeeded();
await p.waitForTimeout(300);
await fork.screenshot({ path: `${OUT}/9-fork-box.png` });

await p.locator('.rec[data-for="he-08"] .fork .cmd button.copy').click();
await p.waitForTimeout(250);
await fork.screenshot({ path: `${OUT}/10-fork-copied.png` });

const checkit = p.locator('.rec[data-for="he-08"] .np-block.checkit');
await checkit.scrollIntoViewIfNeeded();
await p.waitForTimeout(300);
await checkit.screenshot({ path: `${OUT}/11-checkit-box.png` });

console.log("shots done ->", OUT);
await b.close();
