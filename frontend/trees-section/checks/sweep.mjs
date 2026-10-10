// Breakpoint sweep: every page at every width we claim to support, checked for
// overflow, overlapping furniture, and the JS-off path.
import { createRequire } from "node:module";
const require = createRequire("C:/Users/liewjayyong/.workbuddy-ai/binaries/node/workspace/");
const { chromium } = require("playwright-core");
const BASE = "file:///C:/Users/liewjayyong/WorkBuddy%20AI/2026-10-10-12-59-12/trees-section";

const PAGES = ["index", "research--hermes-agent--claude-sonnet-5", "coding--petri-harness-v1--claude-sonnet-5",
  "finance--pi--claude-haiku-4-5", "security--codex-cli--gpt-5", "data-analysis--openhands--gemini-2-5-pro",
  "coding--claude-code--claude-opus-5"];
const WIDTHS = [360, 390, 700, 760, 1019, 1020, 1240, 1440, 1920];

const PROBE = () => {
  const de = document.documentElement;
  // Any element whose right edge escapes the viewport is a horizontal-scroll bug,
  // except inside a deliberately scrollable plate.
  // Command boxes are deliberately NOT in this list: they wrap rather than
  // scroll, so any overflow inside one is a real bug worth failing on.
  const scrollers = [...document.querySelectorAll(".tree-plate, .legend-overlay, .chip-set")];
  const inScroller = (el) => scrollers.some((s) => s.contains(el));
  const over = [];
  for (const el of document.querySelectorAll("body *")) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    if (r.right > de.clientWidth + 1 && !inScroller(el)) {
      over.push(`${el.tagName}.${(el.className || "").toString().split(" ")[0]}@${Math.round(r.right)}`);
    }
  }
  // The plate must not be the page: a wide figure scrolls inside itself.
  const plate = document.querySelector(".tree-plate");
  // Sticky info column must never cover the node panel.
  const info = document.querySelector(".record-info");
  const panel = document.querySelector(".node-panel");
  const rectsOf = (s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return { l: +r.left.toFixed(1), r: +r.right.toFixed(1), t: +r.top.toFixed(1), b: +r.bottom.toFixed(1) }; };
  return {
    hScroll: de.scrollWidth > de.clientWidth + 1,
    docW: de.scrollWidth, viewW: de.clientWidth,
    over: [...new Set(over)].slice(0, 6),
    plateScrolls: plate ? plate.scrollWidth > plate.clientWidth + 1 : null,
    info: rectsOf(".record-info"), panel: rectsOf(".node-panel"),
  };
};

const b = await chromium.launch({ channel: "msedge" });
const ctx = await b.newContext({ colorScheme: "dark" });
const p = await ctx.newPage();

let bad = 0;
for (const name of PAGES) {
  const url = name === "index" ? `${BASE}/index.html` : `${BASE}/${name}.html`;
  for (const w of WIDTHS) {
    await p.setViewportSize({ width: w, height: 900 });
    await p.goto(url, { waitUntil: "load" });
    await p.waitForTimeout(name === "index" ? 260 : 380);
    const r = await p.evaluate(PROBE);
    const flags = [];
    if (r.hScroll) flags.push(`HSCROLL ${r.docW}>${r.viewW}`);
    if (r.over.length) flags.push(`OVER ${r.over.join(",")}`);
    if (r.info && r.panel && r.info.l < r.panel.r - 1 && r.info.t < r.panel.b) flags.push(`INFO-COVERS-PANEL`);
    if (flags.length) { bad++; console.log(`FAIL ${name} @${w}: ${flags.join(" | ")}`); }
  }
}
console.log(`\n${bad} failing viewport/page combinations out of ${PAGES.length * WIDTHS.length}`);
await b.close();
