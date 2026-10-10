import { tasksOf } from "../lib/format.mjs";
import { glyph } from "../lib/glyph.mjs";
import { buildForest, tidySlots } from "../lib/layout.mjs";
import { esc, r1 } from "./shared.mjs";

/** Mini-tree geometry, in SVG user units. The SVG is scaled to fit its card. */
const MINI = { COL: 70, ROW: 24, PAD: 16, R: 5 };

/** Decorative SVG: the card text carries the meaning. */
function miniTree(nodes) {
	const { COL, ROW, PAD, R } = MINI;
	const forest = buildForest(nodes);
	const status = new Map(nodes.map((n) => [n.id, n.status]));
	const { slots, rows, maxDepth } = tidySlots(forest, (id) => status.get(id));

	// A minimum canvas keeps a one-version tree as a small centred dot.
	const cols = Math.max(maxDepth, 3);
	const spanRows = Math.max(rows - 1, 3);
	const dx = ((cols - maxDepth) * COL) / 2;
	const dy = ((spanRows - (rows - 1)) * ROW) / 2;
	const at = (id) => {
		const slot = slots.get(id);
		return { x: PAD + dx + slot.depth * COL, y: PAD + dy + slot.row * ROW };
	};

	const edges = nodes
		.filter((n) => slots.has(n.parent) && slots.has(n.id))
		.map((n) => {
			const a = at(n.parent);
			const b = at(n.id);
			const mx = r1((a.x + b.x) / 2);
			const cls = n.status === "rejected" ? "h-edge dead" : "h-edge";
			return `<path class="${cls}" d="M${r1(a.x)} ${r1(a.y)}C${mx} ${r1(a.y)} ${mx} ${r1(b.y)} ${r1(b.x)} ${r1(b.y)}"/>`;
		})
		.join("");
	const glyphs = nodes
		.filter((n) => slots.has(n.id))
		.map((n) => {
			const { x, y } = at(n.id);
			return glyph(n.status, x, y, R);
		})
		.join("");

	const width = PAD * 2 + cols * COL;
	const height = PAD * 2 + spanRows * ROW;
	return `<svg class="mini" viewBox="0 0 ${width} ${height}" aria-hidden="true">${edges}${glyphs}</svg>`;
}

/** Without an accepted head, the gallery must not claim a pending version is best. */
function cardStats(tree) {
	const { bench, stats } = tree;
	const head = tree.nodes.find((node) => node.id === stats.head);
	return {
		total: stats.total,
		accepted: stats.accepted,
		rejected: stats.rejected,
		best: head
			? `${tasksOf(head.detail.claimedMedianBp, bench.total)} of ${bench.total}`
			: "\u2014",
	};
}

export function galleryCard(entry, tree) {
	const stats = cardStats(tree);
	return `
        <li>
          <a class="card" href="${esc(entry.slug)}.html">
            <div class="card-top">
              <div>
                <p class="card-title">${esc(entry.harness)}</p>
                <p class="card-sub">on ${esc(entry.model)}</p>
              </div>
              <span class="tag">${esc(entry.domain)}</span>
            </div>
            <div class="card-mini">${miniTree(tree.nodes)}</div>
            <p class="card-goal">${esc(entry.goal)}</p>
            <dl class="card-stats">
              <div><dt>Versions</dt><dd>${esc(stats.total)}</dd></div>
              <div><dt>Accepted</dt><dd>${esc(stats.accepted)}</dd></div>
              <div><dt>Kept failures</dt><dd>${esc(stats.rejected)}</dd></div>
              <div><dt>Best</dt><dd>${esc(stats.best)}</dd></div>
            </dl>
          </a>
        </li>`;
}
