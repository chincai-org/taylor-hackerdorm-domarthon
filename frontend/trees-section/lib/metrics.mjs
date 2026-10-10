/**
 * Metric helpers — a direct port of the reference `lib/metrics.ts`.
 *
 * A change aims at a direction ("accuracy", "speed", "token savings"), and each
 * direction is judged on a different quantity. Score going up is a gain; tokens
 * or wall time going DOWN is a gain. These functions normalise that so the tree
 * can print one percentage next to every edge.
 */

import { isBlocked, isRoot, objectiveOf, scoreBpOf } from "./format.mjs";

/** The quantity a direction is judged on. */
export function metricOf(objective) {
  if (objective === "token savings") return "tokens";
  if (objective === "speed") return "time";
  return "score";
}

/** Scores may be author claims; zero costs mean the benchmark never ran. */
export function valueOf(n, metric, nodes, ids) {
  if (metric === "score") return scoreBpOf(n, nodes, ids);
  if (isBlocked(n)) return null;
  const cost = metric === "tokens" ? n.costs.tokensPerTask : n.costs.medianWallMs;
  return Number.isFinite(cost) && cost > 0 ? cost : null;
}

/** The gain from one value to another, positive when it got better. */
export function gain(from, to, metric) {
  if (!Number.isFinite(from) || !Number.isFinite(to) || from === 0) return null;
  const change = ((to - from) / from) * 100;
  return metric === "score" ? change : -change;
}

export function fmtPct(p) {
  if (p === null || p === undefined) return "\u2014";
  const r = Math.round(p);
  return r === 0 ? "0%" : `${r > 0 ? "+" : "\u2212"}${Math.abs(r)}%`;
}

/** Gain on this version's own direction, against its parent. */
export function changesOf(n, nodes) {
  const byId = new Map(nodes.map((x) => [x.id, x]));
  const ids = new Set(byId.keys());
  const metric = metricOf(objectiveOf(n));
  const parent = byId.get(n.parent);

  let root = n;
  const seen = new Set();
  while (!isRoot(root, ids)) {
    if (seen.has(root.id))
      throw new Error(`Cannot calculate changes: parent cycle involving node ${root.id}`);
    seen.add(root.id);
    root = byId.get(root.parent);
  }

  const value = (x, m) => valueOf(x, m, nodes, ids);
  return {
    local: parent ? gain(value(parent, metric), value(n, metric), metric) : null,
    accuracy: gain(value(root, "score"), value(n, "score"), "score"),
    tokenSavings: gain(value(root, "tokens"), value(n, "tokens"), "tokens"),
    isStart: root.id === n.id,
  };
}
