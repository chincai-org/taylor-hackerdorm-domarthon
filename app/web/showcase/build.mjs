/**
 * Generate the complete static gallery and detail pages into dist/.
 * Build-time layout keeps every record and CSS-only interaction usable with
 * JavaScript disabled. Run from this directory with: node build.mjs.
 *
 * The shared theme and enhancement script live in ../../static/ (they are
 * also served to the live viewer at /trees/). They are copied into dist/ so
 * the showcase stays self-contained: it opens from file:// and is served at
 * /showcase/ with no other dependency. Never hand-edit dist/ output.
 */
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TREES, loadTree } from "./registry.mjs";
import { renderSite } from "./templates/pages.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, "dist");
const STATIC = join(HERE, "..", "static");
await mkdir(DIST, { recursive: true });
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
	await writeFile(join(DIST, name), content, "utf8");
}
// Keep dist/ self-contained for file:// and /showcase/ (see header).
for (const asset of ["theme.css", "showcase-enhance.js"]) {
	await copyFile(join(STATIC, asset), join(DIST, asset));
}

const kb = (bytes) => Math.round(bytes / 1024);
console.log(
	`Wrote dist/index.html, ${loaded.length} tree pages (${kb(pageBytes)}KB) ` +
		`and ${loaded.length} tree stylesheets (${kb(cssBytes)}KB).`,
);
