import { buildForest, tidySlots } from "../lib/layout.mjs";
import { glyph } from "../lib/glyph.mjs";
import { changesOf, fmtPct } from "../lib/metrics.mjs";
import { STATUS_WORD, clip, nodeNumbers, objectiveOf, wordOf } from "../lib/format.mjs";
import { DEAD, esc, r1 } from "./shared.mjs";

const HERO = { COL: 420, ROW: 74, PAD_X: 40, PAD_Y: 46, LABEL_W: 300, R: 8 };

/** Every figure node is a real link to its record, including with JavaScript off. */
export function heroTree(tree, bench) {
  const { COL, ROW, PAD_X, PAD_Y, LABEL_W, R } = HERO;
  const { nodes, policy } = tree;
  const forest = buildForest(nodes);
  const status = new Map(nodes.map((n) => [n.id, n.status]));
  const { slots, rows, maxDepth } = tidySlots(forest, (id) => status.get(id));
  const at = (id) => {
    const s = slots.get(id);
    return { x: PAD_X + s.depth * COL, y: PAD_Y + s.row * ROW };
  };
  const width = PAD_X * 2 + maxDepth * COL + LABEL_W;
  const height = PAD_Y * 2 + (rows - 1) * ROW;
  const byId = new Map(nodes.map((n) => [n.id, n]));

  // A child of a rejected version can restore an accepted ancestor's harness.
  const restoredAncestor = (n) => {
    const seen = new Set();
    let cur = byId.get(n.parent);
    while (cur !== undefined && !seen.has(cur.id)) {
      seen.add(cur.id);
      if (cur.status === "accepted" && cur.harness === n.harness) return cur.id;
      cur = byId.get(cur.parent);
    }
    return "";
  };
  const restores = nodes
    .filter((n) => DEAD.has(byId.get(n.parent)?.status ?? "") && n.harness !== undefined)
    .map((n) => ({ from: restoredAncestor(n), to: n.id }))
    .filter((e) => e.from !== "" && slots.has(e.from) && slots.has(e.to));
  const curved = (a, b) =>
    `M${a.x + R} ${a.y}C${r1((a.x + b.x) / 2)} ${a.y} ${r1((a.x + b.x) / 2)} ${b.y} ${b.x - R} ${b.y}`;
  const edges = nodes
    .filter((n) => slots.has(n.parent) && slots.has(n.id))
    .map(
      (n) =>
        `<path class="${DEAD.has(n.status) ? "h-edge dead" : "h-edge"}" d="${curved(at(n.parent), at(n.id))}"/>`,
    )
    .join("");
  const restoreEdges = restores
    .map(
      ({ from, to }) =>
        `<path class="h-edge restore" d="${curved(at(from), at(to))}"><title>runs the same harness as ${esc(from.slice(0, 8))}</title></path>`,
    )
    .join("");
  const objectives = nodes
    .filter((n) => slots.has(n.parent) && slots.has(n.id))
    .map((n) => {
      const b = at(n.id);
      const local = changesOf(n, nodes).local;
      const label = local === null ? objectiveOf(n) : `${objectiveOf(n)} ${fmtPct(local)}`;
      // Roboto Mono advances 0.6em: 5.8 user units leave slack around 9.5px glyphs.
      const w = r1(label.length * 5.8 + 14);
      return `<g class="objective"><rect x="${r1(b.x - R - 10 - w)}" y="${r1(b.y - 8)}" width="${w}" height="16" rx="8"/><text x="${r1(b.x - R - 10 - w / 2)}" y="${r1(b.y + 3.2)}" text-anchor="middle">${esc(label)}</text></g>`;
    })
    .join("");
  const groups = nodes
    .filter((n) => slots.has(n.id))
    .map((n) => {
      const { x, y } = at(n.id);
      const word = `${wordOf(n)} \u00b7 ${n.short}`;
      const hyp = clip(n.hypothesis, 32);
      const num = nodeNumbers(n, nodes, bench.total, policy.minVerifications);
      const labelW = Math.min(
        LABEL_W - 20,
        Math.max(word.length * 6.3, hyp.length * 6.9, num.length * 6.6) + 8,
      );
      // Two backdrops leave the edge visible in an open band at the dot height.
      return `<a class="h-node s-${esc(n.status)}" href="#s-${esc(n.short)}" aria-label="${esc(`${STATUS_WORD[n.status]} ${n.short}. ${n.hypothesis}`)}">
              <rect class="backdrop" x="${r1(x + 14)}" y="${r1(y - 27)}" width="${r1(labelW)}" height="26"/>
              <rect class="backdrop" x="${r1(x + 14)}" y="${r1(y + 7)}" width="${r1(labelW)}" height="14"/>
              <rect class="hit" x="${r1(x - 16)}" y="${r1(y - 31)}" width="${LABEL_W - 6}" height="56" rx="6"/>
              <circle class="ring" cx="${r1(x)}" cy="${r1(y)}" r="${R + 5}"/>
              ${glyph(n.status, x, y, R)}
              <text class="h-word" x="${r1(x + 18)}" y="${r1(y - 17)}">${esc(word)}</text>
              <text class="h-hyp" x="${r1(x + 18)}" y="${r1(y - 3)}">${esc(hyp)}</text>
              <text class="h-num" x="${r1(x + 18)}" y="${r1(y + 18)}">${esc(num)}</text>
            </a>`;
    })
    .join("");

  return `<div class="hero">
          <svg viewBox="0 0 ${width} ${height}" role="group" aria-label="Lineage of ${esc(nodes.length)} harness versions" style="max-inline-size:${width}px;min-inline-size:${Math.round(width * 0.78)}px">
            ${edges}${restoreEdges}${objectives}${groups}
          </svg>
        </div>`;
}

/** The same lineage as a vertical list, for narrow screens. */
export function treeList(tree, bench) {
  const { nodes, policy } = tree;
  const forest = buildForest(nodes);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const branch = (id) => {
    const n = byId.get(id);
    if (!n) return "";
    const kids = forest.children.get(id) ?? [];
    const num = nodeNumbers(n, nodes, bench.total, policy.minVerifications);
    return `<li class="t-node s-${esc(n.status)}${DEAD.has(n.status) ? " dead" : ""}">
            <a class="t-row" href="#s-${esc(n.short)}">
              <svg class="t-glyph" width="16" height="16" aria-hidden="true">${glyph(n.status, 8, 8, 5.5)}</svg>
              <span class="t-text">
                <span class="t-word">${esc(`${wordOf(n)} \u00b7 ${n.short}`)}</span>
                <span class="t-hyp">${esc(n.hypothesis)}</span>
                <span class="t-num">${esc(num)}</span>
              </span>
            </a>
            ${kids.length > 0 ? `<ul>${kids.map(branch).join("")}</ul>` : ""}
          </li>`;
  };
  return `<ul class="tree list-view" aria-label="Lineage of ${esc(nodes.length)} harness versions">
          ${forest.roots.map(branch).join("")}
        </ul>`;
}

/** The record owns s-<short>, so one fragment selects and scrolls to that version. */
export function selectedStrip(n, tree, head) {
  const { nodes, policy, bench } = tree;
  return `<div class="selected-strip s-${esc(n.status)}" data-for="${esc(n.short)}"${n.id === head.id ? " data-default" : ""}>
            <svg width="14" height="14" aria-hidden="true">${glyph(n.status, 7, 7, 5)}</svg>
            <span class="sel-word">${esc(`${wordOf(n)} \u00b7 ${n.short}`)}</span>
            <span class="sel-hyp">${esc(clip(n.hypothesis, 96))}</span>
            <span class="sel-num">${esc(nodeNumbers(n, nodes, bench.total, policy.minVerifications))}</span>
            <a href="#s-${esc(n.short)}">Full record \u2193</a>
          </div>`;
}
