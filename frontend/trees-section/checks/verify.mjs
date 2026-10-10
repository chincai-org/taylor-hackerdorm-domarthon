import { createRequire } from "node:module";
const require = createRequire("C:/Users/liewjayyong/.workbuddy-ai/binaries/node/workspace/");
const { chromium } = require("playwright-core");
const BASE = "file:///C:/Users/liewjayyong/WorkBuddy%20AI/2026-10-10-12-59-12/trees-section";

const AUDIT = () => {
  const parse = (c) => { const m = c.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/); return m ? { r:+m[1], g:+m[2], b:+m[3], a: m[4]===undefined?1:+m[4] } : null; };
  const lum = ({r,g,b}) => { const f=(v)=>{const s=v/255; return s<=0.03928?s/12.92:((s+0.055)/1.055)**2.4;}; return 0.2126*f(r)+0.7152*f(g)+0.0722*f(b); };
  const bgOf = (el) => { for (let n=el;n;n=n.parentElement){const c=parse(getComputedStyle(n).backgroundColor); if(c&&c.a>0.5) return c;} return {r:28,g:27,b:31}; };
  const ratio = (f,b) => { const [x,y]=[lum(f),lum(b)].sort((p,q)=>q-p); return (x+0.05)/(y+0.05); };
  const contrast=[], small=[], tap=[];
  for (const el of document.querySelectorAll("p,span,dt,dd,h1,h2,h3,a,button,label,td,th,code,figcaption,li")) {
    const r=el.getBoundingClientRect(); if(!r.width||!r.height) continue;
    const cs=getComputedStyle(el), fg=parse(cs.color); if(!fg) continue;
    const size=parseFloat(cs.fontSize), c=ratio(fg,bgOf(el));
    const large = size>=24 || (size>=18.66 && +cs.fontWeight>=700);
    const label=`${el.tagName}.${(el.className||"").toString().split(" ")[0]}`;
    if (c < (large?3:4.5)) contrast.push({el:label,size,ratio:+c.toFixed(2)});
    if (size<12) small.push({el:label,size});
  }
  for (const el of document.querySelectorAll("a,button,label[for]")) {
    const r=el.getBoundingClientRect(); if(!r.width||!r.height) continue;
    if (r.height<24||r.width<24) tap.push({el:`${el.tagName}.${(el.className||"").toString().split(" ")[0]}`,w:Math.round(r.width),h:Math.round(r.height)});
  }
  return { contrast:[...new Map(contrast.map(c=>[c.el+c.size,c])).values()], small:[...new Map(small.map(s=>[s.el+s.size,s])).values()], tap:[...new Map(tap.map(t=>[t.el+t.w+t.h,t])).values()] };
};

const b = await chromium.launch({ channel: "msedge" });
const p = await b.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
for (const [name,url] of [["gallery",`${BASE}/index.html`],["tree",`${BASE}/research--hermes-agent--claude-sonnet-5.html`],["petri",`${BASE}/coding--petri-harness-v1--claude-sonnet-5.html`]]) {
  await p.goto(url,{waitUntil:"load"}); await p.waitForTimeout(1400);
  const a = await p.evaluate(AUDIT);
  console.log(`${name}: contrast ${a.contrast.length} ${JSON.stringify(a.contrast)} | <12px ${a.small.length} | tap<24 ${a.tap.length} ${JSON.stringify(a.tap)}`);
}

// Interaction still intact?
await p.goto(`${BASE}/research--hermes-agent--claude-sonnet-5.html`,{waitUntil:"load"}); await p.waitForTimeout(1200);
const read = () => p.evaluate(() => {
  const shown=(s)=>[...document.querySelectorAll(s)].filter(e=>e.getBoundingClientRect().height>0);
  return { strips: shown(".selected-strip").length, panels: shown(".node-panel").length,
    strip: shown(".selected-strip")[0]?.dataset.for, panel: shown(".node-panel")[0]?.querySelector(".np-hyp")?.textContent?.trim(),
    hash: location.hash,
    chips: [...document.querySelectorAll(".chip-input")].map(c=>c.checked).join(","),
    views: { tree: !!document.querySelector(".view-tree")?.getBoundingClientRect().height, stats: !!document.querySelector(".view-stats")?.getBoundingClientRect().height } };
});
console.log("initial:", JSON.stringify(await read()));
await p.click('.h-node[aria-label*="he-07"]'); await p.waitForTimeout(400);
console.log("click he-07:", JSON.stringify(await read()));
// "Full record" with a script: must scroll without dropping the selection.
await p.click('.selected-strip[data-for="he-07"] a[href="#s-he-07"]'); await p.waitForTimeout(400);
console.log("full record:", JSON.stringify(await read()));
await p.click('label[for="chip-limits"]'); await p.waitForTimeout(300);
const open = await p.evaluate(() => [...document.querySelectorAll(".panel")].find(x=>x.getBoundingClientRect().height>0)?.dataset.panel);
console.log("chip -> panel:", open);
await p.click('label[for="view-stats"]'); await p.waitForTimeout(300);
console.log("view:", JSON.stringify((await read()).views));
await b.close();
