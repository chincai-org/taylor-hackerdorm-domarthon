import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { TREES, loadTree } from "../data.mjs";
import { isBlocked } from "../lib/format.mjs";
import { galleryCard } from "../templates/gallery.mjs";
import { nodePanel } from "../templates/record.mjs";
import { galleryPage, renderSite, treePage } from "../templates/pages.mjs";
import { selectionCss } from "../templates/selection.mjs";
import { esc, hashscanRecord, hashscanTopic, headOf } from "../templates/shared.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const loaded = TREES.map((entry) => ({ entry, ...loadTree(entry) }));
const count = (text, pattern) => [...text.matchAll(pattern)].length;

// Values are mutated after data validation only to probe the final markup boundary.
test("text and double-quoted attribute escaping is context-correct", () => {
  const unsafe = '<img src=x onerror="bad"> & "quoted"';
  const { entry, tree } = loaded[0];
  const node = structuredClone(tree.nodes[0]);
  node.hypothesis = unsafe;
  node.diff = unsafe;
  const panel = nodePanel(node, { ...tree, nodes: [node] }, null);
  const card = galleryCard({ ...entry, harness: unsafe, goal: unsafe }, tree);
  const page = treePage({ ...entry, goal: unsafe }, tree, null).html;
  assert.equal(esc(unsafe), "&lt;img src=x onerror=&quot;bad&quot;&gt; &amp; &quot;quoted&quot;");
  for (const markup of [panel, card, page]) {
    assert.ok(markup.includes(esc(unsafe)));
    assert.ok(!markup.includes(unsafe));
  }
});

test("HashScan URL components and visible sequence values cannot inject markup", () => {
  const topic = { network: 'testnet/"?&', topicId: '0.0.123/"?&' };
  const reference = { timestamp: '123.456/"?&', seq: '<bad seq="x">' };
  assert.equal(
    hashscanTopic(topic),
    "https://hashscan.io/testnet%2F%22%3F%26/topic/0.0.123%2F%22%3F%26",
  );
  assert.equal(
    hashscanRecord(topic, reference),
    "https://hashscan.io/testnet%2F%22%3F%26/transaction/123.456%2F%22%3F%26",
  );
  const { tree } = loaded.find(({ entry }) => entry.source === "real");
  const node = structuredClone(tree.nodes.find((item) => item.verifications.length > 0));
  node.hedera = reference;
  node.verifications[0].hedera = reference;
  const markup = nodePanel(node, tree, topic);
  assert.ok(markup.includes(`href="${esc(hashscanRecord(topic, reference))}"`));
  assert.equal(count(markup, /Hedera #&lt;bad seq=&quot;x&quot;&gt;/g), 2);
  assert.ok(!markup.includes(reference.seq));
});

test("gallery consumes the loaded registry and links all six flat pages", () => {
  const markup = galleryPage(loaded);
  assert.equal(count(markup, /class="card"/g), 6);
  assert.equal(count(markup, /<h1\b/g), 1);
  assert.ok(!markup.includes("tree/"));
  for (const { entry } of loaded) {
    assert.ok(markup.includes(`href="${entry.slug}.html"`));
  }
});

test("gallery best stays absent when no accepted head exists", () => {
  const { entry, tree } = loaded[0];
  const pendingTree = {
    ...tree,
    nodes: tree.nodes.map((node) => ({ ...node, status: "pending" })),
    stats: { ...tree.stats, accepted: 0, head: null },
  };
  const markup = galleryCard(entry, pendingTree);
  assert.ok(markup.includes("<dt>Best</dt><dd>\u2014</dd>"));
});

for (const { entry, tree, digest } of loaded) {
  test(`${entry.slug}: complete static detail and selection contracts`, () => {
    const { html, css } = treePage(entry, tree, digest);
    const head = headOf(tree);
    assert.ok(html.startsWith('<!DOCTYPE html>\n<html lang="en">'));
    assert.ok(html.includes('<script src="main.js" defer></script>'));
    assert.ok(html.includes('<link rel="stylesheet" href="styles.css">'));
    assert.ok(html.includes(`<link rel="stylesheet" href="${entry.slug}.css">`));
    assert.equal(count(html, /<h1\b/g), 1);
    assert.ok(!/<(?:meta|link|input)\b[^>]*\/>/.test(html));
    assert.ok(html.includes('<section class="plate tree-plate" tabindex="0" aria-label='));
    assert.ok(
      html.includes('<div class="legend legend-overlay" role="group" aria-label="Legend">'),
    );
    assert.equal(count(html, /<aside\b/g), 0);
    assert.equal(count(html, /<div class="node-panel"/g), tree.nodes.length);
    assert.ok(
      html.includes('<div class="chart-figure">\n            <figure class="chart-content">'),
    );
    assert.match(
      html,
      /<figcaption id="chart-cap">[\s\S]*?<\/figcaption>\s*<\/figure>\s*<details class="table-view">/,
    );
    assert.equal(count(html, /class="rec"/g), tree.nodes.length);
    assert.equal(count(html, /class="selected-strip /g), tree.nodes.length);
    assert.equal(count(html, / data-default/g), 2);
    assert.ok(html.includes(`data-for="${head.short}" data-default`));
    assert.ok(html.includes('id="view-tree" class="seg-input" checked'));
    assert.ok(html.includes('id="view-stats" class="seg-input"'));
    for (const node of tree.nodes) {
      assert.ok(html.includes(`id="s-${node.short}" data-for="${node.short}"`));
      assert.ok(html.includes(`class="t-row" href="#s-${node.short}"`));
      assert.ok(html.includes(`href="#s-${node.short}">Full record`));
      assert.ok(html.includes(`<pre data-fork-out="${node.short}">`));
      assert.ok(html.includes(`data-copy-out="${node.short}"`));
      assert.ok(css.includes(`:has(#s-${node.short}:target)`));
      assert.ok(css.includes(`.selected-strip[data-for="${node.short}"].is-open`));
      assert.ok(css.includes(`.rec[data-for="${node.short}"]`));
    }
    const identifiers = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
    assert.equal(new Set(identifiers).size, identifiers.length, "unique document IDs");
    for (const [, target] of html.matchAll(/\bhref="#([^"]+)"/g)) {
      assert.ok(identifiers.includes(target), `fragment ${target} resolves`);
    }
    for (const [, id] of html.matchAll(/<label\b[^>]*\sfor="([^"]+)"/g)) {
      assert.ok(identifiers.includes(id), `label ${id} resolves`);
    }
    assert.ok(css.includes("body:not(:has(.rec:target)):not(:has(.selected-strip.is-open))"));
    assert.ok(!css.includes("&quot;"));
    assert.ok(
      html.includes(
        entry.source === "showcase" ? "hand-authored showcase tree" : "real exported tree",
      ),
    );
  });
}

test("a resolved fallback head marks the strip, record, and selector consistently", () => {
  const { entry, tree, digest } = loaded[0];
  const missingHeadTree = { ...tree, stats: { ...tree.stats, head: "missing" } };
  const first = tree.nodes[0];
  const { html, css } = treePage(entry, missingHeadTree, digest);
  assert.equal(count(html, new RegExp(`data-for="${first.short}" data-default`, "g")), 2);
  assert.ok(css.includes(`.h-node[href="#s-${first.short}"]`));
});

test("selector generation retains both state paths for safe non-hex identifiers", () => {
  const nodes = [{ short: "node_1" }, { short: "node-2" }];
  const css = selectionCss(nodes, nodes[1]);
  for (const { short } of nodes) {
    assert.ok(css.includes(`#s-${short}:target`));
    assert.ok(css.includes(`.h-node[href="#s-${short}"]`));
    assert.ok(css.includes(`.t-row[href="#s-${short}"]`));
  }
});

test("blocked commands disclose their live API-key requirement", () => {
  const { tree } = loaded.find(({ entry }) => entry.source === "real");
  const blocked = tree.nodes.find(isBlocked);
  const scored = tree.nodes.find((node) => !isBlocked(node));
  assert.ok(blocked, "fixture contains an unscored version");
  const blockedMarkup = nodePanel(blocked, tree, tree.hedera ?? null);
  assert.ok(blockedMarkup.includes("scoring this version live needs ANTHROPIC_API_KEY"));
  assert.ok(blockedMarkup.includes("ANTHROPIC_API_KEY=... pnpm petri run"));
  assert.ok(!blockedMarkup.includes("Nothing here needs an API key."));
  assert.ok(nodePanel(scored, tree, null).includes("Nothing here needs an API key."));
});

test("rendering is deterministic and build output matches UTF-8 byte reporting", async (t) => {
  const outputs = renderSite(loaded);
  assert.equal(outputs.length, 13);
  assert.deepEqual(renderSite(loaded), outputs);
  assert.equal(new Set(outputs.map(({ name }) => name)).size, 13);
  const reports = [];
  t.mock.method(console, "log", (report) => reports.push(report));
  await import(new URL("../build.mjs?render-check=1", import.meta.url));
  const first = outputs.map(({ name }) => readFileSync(join(ROOT, name)));
  await import(new URL("../build.mjs?render-check=2", import.meta.url));
  assert.equal(reports.length, 2);
  assert.equal(reports[1], reports[0]);
  for (const [index, { name, content }] of outputs.entries()) {
    assert.deepEqual(readFileSync(join(ROOT, name)), first[index], name);
    assert.equal(first[index].toString("utf8"), content, name);
  }
  const byteCount = (extension) =>
    outputs
      .filter(({ name }) => name.endsWith(extension) && name !== "index.html")
      .reduce((sum, { content }) => sum + Buffer.byteLength(content, "utf8"), 0);
  assert.equal(
    reports[0],
    `Wrote index.html, 6 tree pages (${Math.round(byteCount(".html") / 1024)}KB) ` +
      `and 6 tree stylesheets (${Math.round(byteCount(".css") / 1024)}KB).`,
  );
});
