import { assert, checkNativeInteractions, open, PETRI, TREE, withBrowser } from "./browser.mjs";

const AUDIT = () => {
  const parse = (c) => {
    const m = c.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/);
    return m ? { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] } : null;
  };
  const lum = ({ r, g, b }) => {
    const f = (v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const bgOf = (el) => {
    for (let n = el; n; n = n.parentElement) {
      const c = parse(getComputedStyle(n).backgroundColor);
      if (c && c.a > 0.5) return c;
    }
    return { r: 28, g: 27, b: 31 };
  };
  const ratio = (f, b) => {
    const [x, y] = [lum(f), lum(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  };
  const contrast = [],
    small = [],
    tap = [];
  for (const el of document.querySelectorAll(
    "p,span,dt,dd,h1,h2,h3,a,button,label,td,th,code,figcaption,li",
  )) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    const cs = getComputedStyle(el),
      fg = parse(cs.color);
    if (!fg) continue;
    const size = parseFloat(cs.fontSize),
      c = ratio(fg, bgOf(el));
    const large = size >= 24 || (size >= 18.66 && +cs.fontWeight >= 700);
    const label = `${el.tagName}.${(el.className || "").toString().split(" ")[0]}`;
    if (c < (large ? 3 : 4.5)) contrast.push({ el: label, size, ratio: +c.toFixed(2) });
    if (size < 12) small.push({ el: label, size });
  }
  for (const el of document.querySelectorAll("a,button,label[for]")) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    if (r.height < 24 || r.width < 24)
      tap.push({
        el: `${el.tagName}.${(el.className || "").toString().split(" ")[0]}`,
        w: Math.round(r.width),
        h: Math.round(r.height),
      });
  }
  return {
    contrast: [...new Map(contrast.map((c) => [c.el + c.size, c])).values()],
    small: [...new Map(small.map((s) => [s.el + s.size, s])).values()],
    tap: [...new Map(tap.map((t) => [t.el + t.w + t.h, t])).values()],
  };
};

await withBrowser(async (page) => {
  const failures = [];
  for (const [label, name] of [
    ["gallery", "index"],
    ["tree", TREE],
    ["petri", PETRI],
  ]) {
    await open(page, name);
    const audit = await page.evaluate(AUDIT);
    console.log(
      `${label}: contrast ${audit.contrast.length} | <12px ${audit.small.length} | tap<24 ${audit.tap.length}`,
    );
    for (const [category, values] of Object.entries(audit)) {
      if (values.length) failures.push({ page: label, category, values });
    }
  }
  assert.deepEqual(failures, [], "Readability and tap-target audit");
  await checkNativeInteractions(page, true);
});
