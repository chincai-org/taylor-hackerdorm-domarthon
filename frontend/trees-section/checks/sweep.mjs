// Both enhancement modes, every page, both views, and key information-panel breakpoints.
import { assert, open, PAGES, withBrowser } from "./browser.mjs";
const WIDTHS = [360, 390, 700, 760, 1019, 1020, 1240, 1440, 1920];

const probe = () => {
  const viewport = document.documentElement;
  const scrollers = [
    ...document.querySelectorAll(
      ".tree-plate, .chart-plate, .legend-overlay, .how table, pre.digest, .diff pre",
    ),
  ];
  const inScroller = (element) =>
    scrollers.some((scroller) => scroller !== element && scroller.contains(element));
  const over = [];
  for (const element of document.querySelectorAll("body *")) {
    const rect = element.getBoundingClientRect();
    if (!rect.width || !rect.height) continue;
    if ((rect.right > viewport.clientWidth + 1 || rect.left < -1) && !inScroller(element)) {
      over.push(`${element.tagName}.${element.className?.toString().split(" ")[0]}`);
    }
  }
  const rectOf = (selector) => {
    const element = [...document.querySelectorAll(selector)].find((element) => {
      const rect = element.getBoundingClientRect();
      return rect.width && rect.height;
    });
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
  };
  return {
    over: [...new Set(over)],
    pageOverflow: viewport.scrollWidth > viewport.clientWidth + 1,
    info: rectOf(".record-info"),
    panel: rectOf(".node-panel"),
    stats: rectOf(".stats"),
  };
};

for (const javaScriptEnabled of [true, false]) {
  await withBrowser(
    async (page) => {
      const failures = [];
      let combinations = 0;
      const check = async (label, view) => {
        combinations++;
        const result = await page.evaluate(probe);
        const flags = [];
        if (result.pageOverflow) flags.push("page overflow");
        if (result.over.length) flags.push(`escaped elements: ${result.over.join(", ")}`);
        if (view === "tree") {
          assert.ok(result.panel && result.info, `Visible record and info measured: ${label}`);
          const { info, panel } = result;
          if (
            info.left < panel.right - 1 &&
            info.right > panel.left + 1 &&
            info.top < panel.bottom - 1 &&
            info.bottom > panel.top + 1
          ) {
            flags.push("info overlaps record");
          }
        }
        if (view === "stats") assert.ok(result.stats, `Visible stats measured: ${label}`);
        if (flags.length) failures.push(`${label}: ${flags.join("; ")}`);
      };
      for (const name of PAGES) {
        for (const width of WIDTHS) {
          await page.setViewportSize({ width, height: 900 });
          await open(page, name);
          // Firefox/Chromium may restore native radio state on same-URL reloads.
          if (name !== "index") await page.locator('label[for="view-tree"]').click();
          await check(`${name} @${width} Tree`, name === "index" ? "gallery" : "tree");
          if (name === "index") continue;
          if ([390, 1020].includes(width)) {
            for (const panel of ["goal", "rules", "how", "limits"]) {
              await page.locator(`label[for="chip-${panel}"]`).click();
              await check(`${name} @${width} ${panel}`, "tree");
            }
          }
          await page.locator('label[for="view-stats"]').click();
          await check(`${name} @${width} Stats`, "stats");
          await page.locator("details.table-view summary").click();
          await check(`${name} @${width} Stats table`, "stats");
        }
      }
      console.log(
        `${javaScriptEnabled ? "JS-on" : "JS-off"}: ${failures.length} failing combinations out of ${combinations}`,
      );
      assert.deepEqual(failures, [], "Responsive Tree/Stats/panel sweep");
    },
    { javaScriptEnabled },
  );
}
