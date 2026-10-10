/**
 * Tree layout — a direct port of the reference `lib/layout.ts`.
 *
 * Two steps: group the flat node list into a forest, then hand every node a
 * (depth, row) slot. The gallery card, the big lineage figure and the narrow
 * list view all lay out from these same two functions, so they always agree.
 */

import { MAX_DEPTH, MAX_NODES, validateTopology } from "./validation.mjs";

/** Reading order for siblings: the line of improvement runs down the left edge. */
const RANK = { accepted: 0, pending: 1, contested: 2, rejected: 3, withdrawn: 4, superseded: 5 };

/**
 * Parent to children, as node ids. A node with no parent — or one naming a node
 * that is not in the list — is treated as a root, so a partial export still
 * renders instead of throwing. This matches `isRoot` in format.mjs.
 */
export function buildForest(nodes) {
  validateTopology(nodes);
  const ids = new Set(nodes.map((n) => n.id));
  const children = new Map();
  const roots = [];

  for (const n of nodes) {
    if (n.parent === null || n.parent === "root" || !ids.has(n.parent)) {
      roots.push(n);
      continue;
    }
    const list = children.get(n.parent) ?? [];
    list.push(n);
    children.set(n.parent, list);
  }

  const byRank = (a, b) => RANK[a.status] - RANK[b.status] || a.seq - b.seq;
  return {
    roots: roots.sort((a, b) => a.seq - b.seq).map((n) => n.id),
    children: new Map([...children].map(([id, list]) => [id, list.sort(byRank).map((n) => n.id)])),
  };
}

/**
 * A tidy tree, like the one-pager's Figure 1. A leaf takes one row, a parent
 * sits centred on its children, and accepted children run through the middle so
 * the line of improvement stays level while failures branch above and below it.
 */
export function tidySlots(forest, statusOf) {
  const slots = new Map();
  const seen = new Set();
  let leaf = 0;
  let maxDepth = 0;

  // The recursion is bounded even when callers supply a forest directly.
  const visit = (id, depth) => {
    if (seen.has(id)) throw new Error(`Cannot lay out forest: repeated or cyclic node ${id}`);
    if (depth > MAX_DEPTH)
      throw new Error(`Cannot lay out forest: maximum depth ${MAX_DEPTH} exceeded`);
    if (seen.size >= MAX_NODES)
      throw new Error(`Cannot lay out forest: maximum node count ${MAX_NODES} exceeded`);
    seen.add(id);
    maxDepth = Math.max(maxDepth, depth);
    const kids = forest.children.get(id) ?? [];

    if (kids.length === 0) {
      slots.set(id, { depth, row: leaf++ });
      return;
    }

    const passed = kids.filter((k) => statusOf(k) === "accepted");
    const rest = kids.filter((k) => statusOf(k) !== "accepted");
    const half = Math.ceil(rest.length / 2);
    for (const k of [...rest.slice(0, half), ...passed, ...rest.slice(half)]) visit(k, depth + 1);

    const rows = kids.map((k) => slots.get(k).row);
    slots.set(id, { depth, row: (Math.min(...rows) + Math.max(...rows)) / 2 });
  };

  for (const root of forest.roots) visit(root, 0);
  return { slots, rows: Math.max(leaf, 1), maxDepth };
}
