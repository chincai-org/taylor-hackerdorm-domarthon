/**
 * Generate the complete static gallery and detail pages as flat sibling files.
 * Build-time layout keeps every record and CSS-only interaction usable with
 * JavaScript disabled. Run with: node build.mjs.
 */
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TREES, loadTree } from "./data.mjs";
import { renderSite } from "./templates/pages.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const loaded = TREES.map((entry) => ({ entry, ...loadTree(entry) }));
const outputs = renderSite(loaded);

let pageBytes = 0;
let cssBytes = 0;
for (const { name, content } of outputs) {
  if (name.endsWith(".css")) {
    cssBytes += Buffer.byteLength(content, "utf8");
  } else if (name !== "index.html") {
    pageBytes += Buffer.byteLength(content, "utf8");
  }
  await writeFile(join(HERE, name), content, "utf8");
}

const kb = (bytes) => Math.round(bytes / 1024);
console.log(
  `Wrote index.html, ${loaded.length} tree pages (${kb(pageBytes)}KB) ` +
    `and ${loaded.length} tree stylesheets (${kb(cssBytes)}KB).`,
);
