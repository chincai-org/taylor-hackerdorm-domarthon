import { claimBp, isBlocked, isRoot, rootRerunBp, signedBp, STATUS_WORD, tasks, tasksOf } from "@/lib/format";
import type { ExportNode, PetriExport } from "@/lib/types";

/** The score a node was measured at by other keys. Falls back to the author claim. */
function scoreBpOf(n: ExportNode, nodes: ExportNode[], ids: Set<string>): number {
  if (isBlocked(n)) return claimBp(n, nodes);
  if (isRoot(n, ids)) return rootRerunBp(n, nodes) ?? n.detail.claimedMedianBp;
  return n.verifications.find((v) => v.counted)?.candidate.medianBp ?? n.detail.claimedMedianBp;
}

const W = 900;
const H = 340;
const L = 70;
const RIGHT = 860;
const T = 46;
const B = 280;

export function Stats({ d }: { d: PetriExport }) {
  const total = d.bench.total;
  const nodes = d.nodes;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const ids = new Set(byId.keys());

  const depthOf = (n: ExportNode): number => {
    let depth = 0;
    let cur: ExportNode | undefined = n;
    const seen = new Set<string>();
    while (cur && !isRoot(cur, ids) && !seen.has(cur.id)) { seen.add(cur.id); cur = byId.get(cur.parent); depth++; }
    return depth;
  };
  const all = nodes.map((n) => ({ n, d: depthOf(n), t: tasksOf(scoreBpOf(n, nodes, ids), total) }));
  // Like an eval chart, plot only versions that were measured. A blocked version has no score.
  const pts = all.filter((p) => !isBlocked(p.n));
  const unscored = all.length - pts.length;

  // The accepted spine: the best version and every ancestor back to the start.
  const spine: typeof pts = [];
  let cur = byId.get(d.stats.head);
  const guard = new Set<string>();
  while (cur && !guard.has(cur.id)) {
    guard.add(cur.id);
    const p = pts.find((x) => x.n.id === cur!.id);
    if (p) spine.unshift(p);
    cur = isRoot(cur, ids) ? undefined : byId.get(cur.parent);
  }
  const onSpine = new Set(spine.map((p) => p.n.id));
  const others = pts.filter((p) => !onSpine.has(p.n.id));

  const head = spine.at(-1) ?? null;
  const needBp = head ? head.n.detail.claimedMedianBp + d.policy.minDeltaBp : null;
  const beatable = needBp !== null && needBp <= 10000;
  const needTasks = needBp === null ? null : tasksOf(needBp, total);
  const goalTasks = needTasks === null ? null : beatable ? needTasks : total;

  const rounds = Math.max(2, Math.max(0, ...pts.map((p) => p.d)) + 1);
  const x = (depth: number) => L + (depth / rounds) * (RIGHT - L);
  const y = (t: number) => B - (t / total) * (B - T);
  const ticks = [0, 1, 2, 3, 4].map((i) => Math.round((i * total) / 4));

  // Failed tries sit just right of their round, fanned out, so they never hide a spine marker.
  const shift = new Map<string, number>();
  const perRound = new Map<number, number>();
  for (const p of others) {
    const i = perRound.get(p.d) ?? 0;
    shift.set(p.n.id, 20 + i * 18);
    perRound.set(p.d, i + 1);
  }

  return (
    <section className="stats" aria-labelledby="stats-title">
      <div className="stats-head">
        <h2 id="stats-title">Stats</h2>
        <p className="muted">Most tries fail. The best score only moves up.</p>
      </div>

      <dl className="goalstrip">
        <div><dt>Best so far</dt><dd>{head ? tasks(head.n.detail.claimedMedianBp, total) : "none yet"}<small>{head ? `${head.n.short} · ${head.n.detail.claimedMedianBp}bp` : "no accepted version"}</small></dd></div>
        <div>
          <dt>Goal</dt>
          <dd>{goalTasks === null ? "—" : tasks((goalTasks * 10000) / total, total)}</dd>
          <small className="dd-note">{beatable || needTasks === null
            ? `${signedBp(d.policy.minDeltaBp)} over the best, checked by ${d.policy.minVerifications} other keys`
            : `the full benchmark · a win over ${head!.n.short} needs ${needTasks} of ${total}`}</small>
        </div>
        <div><dt>Recorded</dt><dd>{d.stats.total} versions<small>{d.stats.accepted} accepted · {d.stats.rejected} rejected and kept · {d.stats.pending} pending</small></dd></div>
      </dl>

      <figure className="chart-figure">
        <div className="plate chart-plate">
          <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-labelledby="chart-cap">
            {ticks.map((t) => (
              <g key={`t-${t}`}>
                <line className={t === 0 ? "c-axis" : "c-grid"} x1={L} x2={RIGHT} y1={y(t)} y2={y(t)} />
                <text className="c-tick" x={L - 12} y={y(t) + 4} textAnchor="end">{t}/{total}</text>
              </g>
            ))}
            {Array.from({ length: rounds + 1 }, (_, r) => (
              <text key={`r-${r}`} className="c-tick" x={x(r)} y={B + 24} textAnchor="middle">{r === 0 ? "start" : `round ${r}`}</text>
            ))}

            {head && goalTasks !== null && (
              <g>
                <line className="c-bar" x1={L} x2={RIGHT} y1={y(goalTasks)} y2={y(goalTasks)} />
                <text className="c-note c-goal" x={RIGHT} y={y(goalTasks) - 9} textAnchor="end">goal · {goalTasks}/{total} tasks</text>
              </g>
            )}

            {others.map((p) => (
              <circle key={p.n.id} className={p.n.status === "accepted" ? "c-pass c-offspine" : p.n.status === "rejected" ? "c-fail" : "c-wait"}
                cx={x(p.d) + (shift.get(p.n.id) ?? 0)} cy={y(p.t)} r={6.5}>
                <title>{`${STATUS_WORD[p.n.status]} ${p.n.short}: ${p.t}/${total} tasks`}</title>
              </circle>
            ))}

            {pts.filter((p) => p.n.status === "accepted" && !onSpine.has(p.n.id)).map((p) => {
              const parent = pts.find((q) => q.n.id === p.n.parent);
              if (!parent) return null;
              const px = x(parent.d) + (shift.get(parent.n.id) ?? 0);
              return <line key={`climb-${p.n.id}`} className="c-line c-climb" x1={px} y1={y(parent.t)} x2={x(p.d) + (shift.get(p.n.id) ?? 0)} y2={y(p.t)} />;
            })}
            {spine.length > 1 && (
              <path className="c-line" d={spine.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.d)} ${y(p.t)}`).join(" ")} />
            )}
            {spine.map((p) => (
              <circle key={p.n.id} className="c-pass" cx={x(p.d)} cy={y(p.t)} r={7}>
                <title>{`${STATUS_WORD[p.n.status]} ${p.n.short}: ${p.t}/${total} tasks`}</title>
              </circle>
            ))}
            {head && <text className="c-val" x={x(head.d)} y={y(head.t) - 15} textAnchor="middle">{head.t}/{total}</text>}
          </svg>
        </div>
        <div className="legend">
          <span><svg width="34" height="14" aria-hidden="true"><line className="c-line" x1="2" x2="32" y1="7" y2="7" /><circle className="c-pass" cx="17" cy="7" r="5" /></svg>Accepted, and became the new parent</span>
          <span><svg width="16" height="16" aria-hidden="true"><circle className="c-fail" cx="8" cy="8" r="5.5" /></svg>Rejected, and kept in the tree</span>
          {others.some((p) => p.n.status !== "accepted" && p.n.status !== "rejected") && (
            <span><svg width="16" height="16" aria-hidden="true"><circle className="c-wait" cx="8" cy="8" r="5.5" /></svg>Pending</span>
          )}
        </div>
        <figcaption id="chart-cap">
          Each round is one generation deeper in the tree. Scores are medians re-run by other keys, from the real tree.
          A version passes only if it beats its parent by {signedBp(d.policy.minDeltaBp)}.
          {unscored > 0 && ` ${unscored} ${unscored === 1 ? "version was" : "versions were"} stopped before scoring and ${unscored === 1 ? "is" : "are"} not plotted. See the table.`}
        </figcaption>
        <details className="table-view">
          <summary>Show as a table</summary>
          <table>
            <thead><tr><th scope="col">Version</th><th scope="col">Round</th><th scope="col">Status</th><th scope="col">Score</th></tr></thead>
            <tbody>
              {all.map((p) => (
                <tr key={p.n.id}><td><code>{p.n.short}</code></td><td>{p.d === 0 ? "start" : p.d}</td><td>{STATUS_WORD[p.n.status]}</td><td>{isBlocked(p.n) ? "not scored" : `${p.t}/${total} tasks`}</td></tr>
              ))}
            </tbody>
          </table>
        </details>
      </figure>
    </section>
  );
}
