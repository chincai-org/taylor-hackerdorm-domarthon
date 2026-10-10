// Does the clipboard actually receive the command, and does the icon swap?
// Run over file:// deliberately: that is a non-secure context, so
// `navigator.clipboard` is unavailable and only the fallback can work.
import { createRequire } from "node:module";
const require = createRequire("C:/Users/liewjayyong/.workbuddy-ai/binaries/node/workspace/");
const { chromium } = require("playwright-core");

const BASE = "file:///C:/Users/liewjayyong/WorkBuddy%20AI/2026-10-10-12-59-12/trees-section";
const TREE = "research--hermes-agent--claude-sonnet-5.html";

const b = await chromium.launch({ channel: "msedge" });
// Clipboard read needs permission; write is granted to the page by this context.
const ctx = await b.newContext({
  viewport: { width: 1440, height: 900 },
  colorScheme: "dark",
  permissions: ["clipboard-read", "clipboard-write"],
});
const p = await ctx.newPage();
await p.goto(`${BASE}/${TREE}`, { waitUntil: "load" });
await p.waitForTimeout(1000);

console.log("secure context:", await p.evaluate(() => window.isSecureContext));
console.log("navigator.clipboard present:", await p.evaluate(() => !!navigator.clipboard?.writeText));

// --- the fork command button (data-copy-out), which follows the picker ---
await p.evaluate(() => document.getElementById("record")?.scrollIntoView());
await p.waitForTimeout(300);

const forkBtn = p.locator('button.copy[data-copy-out="he-08"]').first();
console.log("\n--- fork command ---");
console.log("label before:", await forkBtn.getAttribute("aria-label"));
console.log("tick visible before:", await p.evaluate(() =>
  document.querySelector('button.copy[data-copy-out="he-08"] .icon-copied')?.getBoundingClientRect().height > 0));

await forkBtn.click();
await p.waitForTimeout(250);

const forkClip = await p.evaluate(() => navigator.clipboard.readText());
console.log("clipboard:", JSON.stringify(forkClip.slice(0, 60) + "…"));
console.log("tick visible after:", await p.evaluate(() =>
  document.querySelector('button.copy[data-copy-out="he-08"] .icon-copied')?.getBoundingClientRect().height > 0));
console.log("clipboard icon hidden after:", await p.evaluate(() =>
  document.querySelector('button.copy[data-copy-out="he-08"] .icon-copy')?.getBoundingClientRect().height === 0));
console.log("label after:", await forkBtn.getAttribute("aria-label"));
console.log("announced:", await p.evaluate(() =>
  document.querySelector('button.copy[data-copy-out="he-08"]')?.nextElementSibling?.textContent));

// It must revert, or the button is stuck claiming success.
await p.waitForTimeout(1700);
console.log("label reverted:", await forkBtn.getAttribute("aria-label"));
console.log("tick reverted:", await p.evaluate(() =>
  document.querySelector('button.copy[data-copy-out="he-08"] .icon-copied')?.getBoundingClientRect().height === 0));

// --- a literal command button (data-copy) ---
// These live in the *record* panel, and only the selected version's record is
// displayed, so scope the lookup to the record that is currently on show.
console.log("\n--- check-it command ---");
const visibleRecord = () =>
  p.evaluate(() => [...document.querySelectorAll(".rec")].find((el) => el.getBoundingClientRect().height > 0)?.dataset.for);
console.log("record on show:", await visibleRecord());
const litBtn = p.locator('.rec[data-for="he-08"] button.copy[data-copy="pnpm petri digest"]').first();
await litBtn.scrollIntoViewIfNeeded();
await litBtn.click();
await p.waitForTimeout(250);
const litClip = await p.evaluate(() => navigator.clipboard.readText());
console.log("clipboard:", JSON.stringify(litClip));
console.log("matches data-copy:", litClip === "pnpm petri digest");
console.log("announced:", await p.evaluate(() =>
  document.querySelector('.rec[data-for="he-08"] button.copy[data-copy="pnpm petri digest"]')?.nextElementSibling?.textContent));

// --- the picker must change what gets copied ---
console.log("\n--- after changing the direction picker ---");
await p.selectOption('select[data-fork="he-08"]', { label: "token savings" });
await p.waitForTimeout(200);
await forkBtn.click();
await p.waitForTimeout(250);
const after = await p.evaluate(() => navigator.clipboard.readText());
const shown = (await p.evaluate(() => document.querySelector('.rec[data-for="he-08"] [data-fork-out="he-08"]')?.textContent)).trim();
// Chromium normalises newlines to CRLF on the clipboard, so compare line by line
// rather than byte for byte — the content is what matters, not the line ending.
const sameLines = after.replace(/\r\n/g, "\n").trim() === shown;
console.log("clipboard matches the visible pre block:", sameLines);
console.log("mentions the new motif:", after.includes("--motif token-savings"));

// --- with scripting off there must be no dead copy control on screen ---
console.log("\n--- no-script ---");
const noJs = await b.newContext({ javaScriptEnabled: false, colorScheme: "dark" });
const q = await noJs.newPage();
await q.setViewportSize({ width: 1440, height: 900 });
await q.goto(`${BASE}/${TREE}`, { waitUntil: "domcontentloaded", timeout: 15000 });
await q.waitForTimeout(500);
console.log("copy buttons rendered with no script:", await q.evaluate(() => {
  const shown = [...document.querySelectorAll("button.copy")].filter((el) => el.getBoundingClientRect().height > 0);
  return shown.length;
}), "(want 0 — a button that cannot copy is worse than no button)");
console.log("the commands themselves are still readable:", await q.evaluate(() => {
  // Scope to the record that is actually on show: the default version is he-08,
  // so the *first* [data-fork-out] in the document (he-00) is legitimately hidden.
  const shown = [...document.querySelectorAll(".rec")].find((el) => el.getBoundingClientRect().height > 0);
  const pre = shown?.querySelector("[data-fork-out]");
  return !!pre && pre.getBoundingClientRect().height > 0;
}));

await b.close();
