import { glyph } from "../lib/glyph.mjs";
import { galleryCard } from "./gallery.mjs";
import { heroTree, selectedStrip, treeList } from "./lineage.mjs";
import { infoPanels } from "./panels.mjs";
import { nodePanel } from "./record.mjs";
import { selectionCss } from "./selection.mjs";
import { esc, headOf } from "./shared.mjs";
import { statsView } from "./stats.mjs";

/** A tree additionally links its generated stylesheet; the gallery does not. */
const HEAD = (title, description, pageCss = null) => `<meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${esc(title)}</title>
    <meta name="description" content="${esc(description)}">
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;700&family=Roboto+Mono:wght@400;500&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="theme.css">${
			pageCss === null
				? ""
				: `
    <!-- This tree's own selection rules. Only the page knows its node ids, so
         build.mjs generates them; nothing here is hand-written. -->
    <link rel="stylesheet" href="${esc(pageCss)}">`
		}
    <!-- Deferred so it never blocks the first paint. Every page is complete
         without it; the script only adds polish. Copied from ../../static/
         by build.mjs so dist/ stays self-contained. -->
    <script src="showcase-enhance.js" defer></script>`;
const TOPBAR = `<header class="topbar">
      <div class="topbar-in">
        <a class="brand" href="index.html"><span class="brand-mark" aria-hidden="true"></span>Petri</a>
        <nav class="topnav" aria-label="Main">
          <a href="index.html">Trees</a>
          <a href="https://github.com/Avoisavo/ethonline2026">GitHub</a>
        </nav>
      </div>
    </header>`;

/** All pages and assets are siblings, including when opened from file://. */
const shell = (
	title,
	description,
	body,
	wide = false,
	pageCss = null,
) => `<!DOCTYPE html>
<html lang="en">
  <head>
${HEAD(title, description, pageCss)}
  </head>
  <body>
    ${TOPBAR}
    <main class="container${wide ? " container-wide" : ""}">
${body}
    </main>
  </body>
</html>
`;

/** Consume the same loaded registry entries used to build detail pages. */
export function galleryPage(loaded) {
	const cards = loaded
		.map(({ entry, tree }) => galleryCard(entry, tree))
		.join("");
	const domains = new Set(loaded.map(({ entry }) => entry.domain)).size;
	const body = `      <section class="section" aria-labelledby="trees-heading">
        <div class="section-head">
          <h1 id="trees-heading">Trees</h1>
          <p class="muted">${esc(loaded.length)} trees across ${esc(domains)} domains</p>
        </div>
        <ul class="cards">${cards}
        </ul>
      </section>`;
	return shell(
		"Trees \u00b7 Petri",
		"A gallery of agent-harness trees. Every version is re-checked, and failures are kept.",
		body,
	);
}

export function treePage(entry, tree, digest) {
	const topic = tree.hedera ?? null;
	const head = headOf(tree);
	const isHead = (n) => (n.id === head.id ? " data-default" : "");
	// Match the figure's 10px gap and the separate record section's 24px gap.
	const strips = tree.nodes
		.map((n) => selectedStrip(n, tree, head))
		.join("\n          ");
	// A single record fragment both chooses a version and scrolls to its full record.
	const records = tree.nodes
		.map(
			(n) =>
				`<article class="rec" id="s-${esc(n.short)}" data-for="${esc(n.short)}"${isHead(n)}>${nodePanel(n, tree, topic)}</article>`,
		)
		.join("\n          ");
	const body = `      <nav class="crumbs" aria-label="Breadcrumb">
        <a href="index.html">Trees</a><span aria-hidden="true">/</span><span>${esc(entry.domain)}</span><span aria-hidden="true">/</span><span>${esc(entry.harness)} \u00d7 ${esc(entry.model)}</span>
      </nav>

      <div class="page-head">
        <div>
          <h1>${esc(entry.harness)} <span class="h1-sub">\u00d7 ${esc(entry.model)} (${esc(entry.domain)})</span></h1>
        </div>
      </div>

      <div class="view-bar">
        <div class="seg" role="group" aria-label="View">
          <input type="radio" name="view" id="view-tree" class="seg-input" checked>
          <label for="view-tree">Tree</label>
          <input type="radio" name="view" id="view-stats" class="seg-input">
          <label for="view-stats">Stats</label>
        </div>
      </div>

      <div class="view view-tree">
        <figure class="stage">
          <section class="plate tree-plate" tabindex="0" aria-label="Lineage figure of ${esc(tree.nodes.length)} versions. Scroll sideways to see the whole tree.">
            <div class="legend legend-overlay" role="group" aria-label="Legend">
              <span><svg width="14" height="14" aria-hidden="true">${glyph("accepted", 7, 7, 5)}</svg>Accepted \u2014 two other keys re-ran it and agreed</span>
              <span><svg width="14" height="14" aria-hidden="true">${glyph("rejected", 7, 7, 5)}</svg>Rejected \u2014 kept, with the reason</span>
              <span><svg width="14" height="14" aria-hidden="true">${glyph("pending", 7, 7, 5)}</svg>Pending \u2014 waiting for keys</span>
              <span><svg width="22" height="14" aria-hidden="true"><line class="h-edge restore" x1="1" x2="21" y1="7" y2="7"/></svg>Runs the same harness as that version again</span>
            </div>
            ${heroTree(tree, tree.bench)}
            ${treeList(tree, tree.bench)}
          </section>
          ${strips}
        </figure>

        <section class="record" id="record">
          ${records}

          <div class="record-info">${infoPanels(tree, digest)}</div>
        </section>
      </div>

      <div class="view view-stats">
        ${statsView(tree)}
      </div>`;
	const html = shell(
		`${entry.harness} \u00d7 ${entry.model} \u00b7 Petri`,
		`${entry.goal}. Every version is re-checked by other keys, and failures are kept.`,
		body,
		true,
		`${entry.slug}.css`,
	);
	return { html, css: selectionCss(tree.nodes, head) };
}

/** Render every output before the first filesystem write. */
export function renderSite(loaded) {
	const outputs = [{ name: "index.html", content: galleryPage(loaded) }];
	for (const { entry, tree, digest } of loaded) {
		const { html, css } = treePage(entry, tree, digest);
		outputs.push(
			{ name: `${entry.slug}.html`, content: html },
			{ name: `${entry.slug}.css`, content: css },
		);
	}
	return outputs;
}
