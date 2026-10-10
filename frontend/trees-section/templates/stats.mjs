import {
  STATUS_WORD,
  isBlocked,
  isRoot,
  scoreBpOf,
  signedBp,
  tasks,
  tasksOf,
} from "../lib/format.mjs";
import { esc, headOf, r1 } from "./shared.mjs";

const CHART = { W: 900, H: 340, L: 70, RIGHT: 860, T: 46, B: 280 };

export function statsView(tree) {
  const { W, H, L, RIGHT, T, B } = CHART;
  const { nodes, policy, stats, bench } = tree;
  const total = bench.total;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const ids = new Set(byId.keys());
  const depthOf = (n) => {
    let depth = 0;
    let cur = n;
    const seen = new Set();
    while (cur && !isRoot(cur, ids) && !seen.has(cur.id)) {
      seen.add(cur.id);
      cur = byId.get(cur.parent);
      depth++;
    }
    return depth;
  };
  const all = nodes.map((n) => ({ n, d: depthOf(n), t: tasksOf(scoreBpOf(n, nodes, ids), total) }));
  // Like an eval chart, plot only versions that were measured.
  const pts = all.filter((p) => !isBlocked(p.n));
  const plottedById = new Map(pts.map((point) => [point.n.id, point]));
  const unscored = all.length - pts.length;
  const spine = [];
  let cur = headOf(tree);
  const guard = new Set();
  while (cur && !guard.has(cur.id)) {
    guard.add(cur.id);
    const p = plottedById.get(cur.id);
    if (p) spine.unshift(p);
    cur = isRoot(cur, ids) ? undefined : byId.get(cur.parent);
  }
  const onSpine = new Set(spine.map((p) => p.n.id));
  const others = pts.filter((p) => !onSpine.has(p.n.id));
  const head = spine.at(-1) ?? null;
  const needBp = head ? head.n.detail.claimedMedianBp + policy.minDeltaBp : null;
  const beatable = needBp !== null && needBp <= 10000;
  const needTasks = needBp === null ? null : tasksOf(needBp, total);
  const goalTasks = needTasks === null ? null : beatable ? needTasks : total;

  // Stop at the deepest plotted version, without an empty round beyond the data.
  const rounds = Math.max(2, Math.max(0, ...pts.map((p) => p.d)));
  const x = (depth) => L + (depth / rounds) * (RIGHT - L);
  const y = (t) => B - (t / total) * (B - T);
  const ticks = [0, 1, 2, 3, 4].map((i) => Math.round((i * total) / 4));
  // Fan failed tries just right of each round so they cannot hide a spine marker.
  const shift = new Map();
  const perRound = new Map();
  for (const p of others) {
    const i = perRound.get(p.d) ?? 0;
    shift.set(p.n.id, 20 + i * 18);
    perRound.set(p.d, i + 1);
  }
  const gridLines = ticks
    .map(
      (
        t,
      ) => `<line class="${t === 0 ? "c-axis" : "c-grid"}" x1="${L}" x2="${RIGHT}" y1="${r1(y(t))}" y2="${r1(y(t))}"/>
            <text class="c-tick" x="${L - 12}" y="${r1(y(t) + 4)}" text-anchor="end">${esc(t)}/${esc(total)}</text>`,
    )
    .join("");
  const roundLabels = Array.from(
    { length: rounds + 1 },
    (_, r) =>
      `<text class="c-tick" x="${r1(x(r))}" y="${B + 24}" text-anchor="middle">${r === 0 ? "start" : `round ${r}`}</text>`,
  ).join("");
  const goalLine =
    head && goalTasks !== null
      ? `<line class="c-bar" x1="${L}" x2="${RIGHT}" y1="${r1(y(goalTasks))}" y2="${r1(y(goalTasks))}"/>
            <text class="c-note c-goal" x="${RIGHT}" y="${r1(y(goalTasks) - 9)}" text-anchor="end">goal \u00b7 ${esc(goalTasks)}/${esc(total)} tasks</text>`
      : "";
  const otherDots = others
    .map((p) => {
      const cls =
        p.n.status === "accepted"
          ? "c-pass c-offspine"
          : p.n.status === "rejected"
            ? "c-fail"
            : "c-wait";
      return `<circle class="${cls}" cx="${r1(x(p.d) + (shift.get(p.n.id) ?? 0))}" cy="${r1(y(p.t))}" r="6.5"><title>${esc(`${STATUS_WORD[p.n.status]} ${p.n.short}: ${p.t}/${total} tasks`)}</title></circle>`;
    })
    .join("");
  const climbs = pts
    .filter((p) => p.n.status === "accepted" && !onSpine.has(p.n.id))
    .map((p) => {
      const parent = plottedById.get(p.n.parent);
      if (!parent) return "";
      const px = x(parent.d) + (shift.get(parent.n.id) ?? 0);
      return `<line class="c-line c-climb" x1="${r1(px)}" y1="${r1(y(parent.t))}" x2="${r1(x(p.d) + (shift.get(p.n.id) ?? 0))}" y2="${r1(y(p.t))}"/>`;
    })
    .join("");
  const spineLine =
    spine.length > 1
      ? `<path class="c-line" d="${spine.map((p, i) => `${i === 0 ? "M" : "L"}${r1(x(p.d))} ${r1(y(p.t))}`).join(" ")}"/>`
      : "";
  const spineDots = spine
    .map(
      (p) =>
        `<circle class="c-pass" cx="${r1(x(p.d))}" cy="${r1(y(p.t))}" r="7"><title>${esc(`${STATUS_WORD[p.n.status]} ${p.n.short}: ${p.t}/${total} tasks`)}</title></circle>`,
    )
    .join("");
  const headLabel = head
    ? `<text class="c-val" x="${r1(x(head.d))}" y="${r1(y(head.t) - 15)}" text-anchor="middle">${esc(head.t)}/${esc(total)}</text>`
    : "";
  const pendingLegend = others.some((p) => p.n.status !== "accepted" && p.n.status !== "rejected")
    ? `<span><svg width="16" height="16" aria-hidden="true"><circle class="c-wait" cx="8" cy="8" r="5.5"/></svg>Pending</span>`
    : "";
  const tableRows = all
    .map(
      (p) =>
        `<tr><td><code>${esc(p.n.short)}</code></td><td>${p.d === 0 ? "start" : esc(p.d)}</td><td>${esc(STATUS_WORD[p.n.status])}</td><td>${isBlocked(p.n) ? "not scored" : esc(`${p.t}/${total} tasks`)}</td></tr>`,
    )
    .join("");
  const scoreSource = nodes.every((node) => node.showcase)
    ? "Scores illustrate median results re-run by other keys, from a hand-authored showcase tree."
    : "Scores are medians re-run by other keys, from the real exported tree.";

  return `<section class="stats" aria-labelledby="stats-title">
          <div class="stats-head">
            <h2 id="stats-title">Stats</h2>
            <p class="muted">Most tries fail. The best score only moves up.</p>
          </div>

          <dl class="goalstrip">
            <div><dt>Best so far</dt><dd>${head ? esc(tasks(head.n.detail.claimedMedianBp, total)) : "none yet"}<small>${head ? esc(`${head.n.short} \u00b7 ${head.n.detail.claimedMedianBp}bp`) : "no accepted version"}</small></dd></div>
            <div>
              <dt>Goal</dt>
              <dd>${goalTasks === null ? "\u2014" : esc(tasks((goalTasks * 10000) / total, total))}</dd>
              <small class="dd-note">${
                beatable || needTasks === null
                  ? esc(
                      `${signedBp(policy.minDeltaBp)} over the best, checked by ${policy.minVerifications} other keys`,
                    )
                  : esc(
                      `the full benchmark \u00b7 a win over ${head.n.short} needs ${needTasks} of ${total}`,
                    )
              }</small>
            </div>
            <div><dt>Recorded</dt><dd>${esc(stats.total)} versions<small>${esc(stats.accepted)} accepted \u00b7 ${esc(stats.rejected)} rejected and kept \u00b7 ${esc(stats.pending)} pending</small></dd></div>
          </dl>

          <div class="chart-figure">
            <figure class="chart-content">
              <div class="plate chart-plate">
                <svg viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="chart-cap">
                  ${gridLines}${roundLabels}${goalLine}${otherDots}${climbs}${spineLine}${spineDots}${headLabel}
                </svg>
              </div>
              <div class="legend">
                <span><svg width="34" height="14" aria-hidden="true"><line class="c-line" x1="2" x2="32" y1="7" y2="7"/><circle class="c-pass" cx="17" cy="7" r="5"/></svg>Accepted, and became the new parent</span>
                <span><svg width="16" height="16" aria-hidden="true"><circle class="c-fail" cx="8" cy="8" r="5.5"/></svg>Rejected, and kept in the tree</span>
                ${pendingLegend}
              </div>
              <figcaption id="chart-cap">
                Each round is one generation deeper in the tree. ${scoreSource}
                A version passes only if it beats its parent by ${esc(signedBp(policy.minDeltaBp))}.
                ${unscored > 0 ? ` ${unscored} ${unscored === 1 ? "version was" : "versions were"} stopped before scoring and ${unscored === 1 ? "is" : "are"} not plotted. See the table.` : ""}
              </figcaption>
            </figure>
            <details class="table-view">
              <summary>Show as a table</summary>
              <table>
                <thead><tr><th scope="col">Version</th><th scope="col">Round</th><th scope="col">Status</th><th scope="col">Score</th></tr></thead>
                <tbody>${tableRows}</tbody>
              </table>
            </details>
          </div>
        </section>`;
}
