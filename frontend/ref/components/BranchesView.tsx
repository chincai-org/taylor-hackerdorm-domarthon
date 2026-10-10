"use client";

import { clip, objectiveOf, shortTasks } from "@/lib/format";
import type { Forest } from "@/lib/layout";
import type { ExportNode } from "@/lib/types";
import { MiniTree } from "./MiniTree";

interface Props {
  forest: Forest;
  nodes: ExportNode[];
  benchTotal: number;
  /** Open a branch in the tree view, with its first version selected. */
  onOpen: (id: string) => void;
}

interface Member { n: ExportNode; depth: number }

interface Totals {
  versions: number;
  accepted: number;
  rejected: number;
  pending: number;
  bestBp: number | null;
  depth: number;
}

function totalsOf(members: Member[]): Totals {
  const accepted = members.filter((m) => m.n.status === "accepted");
  return {
    versions: members.length,
    accepted: accepted.length,
    rejected: members.filter((m) => m.n.status === "rejected").length,
    pending: members.filter((m) => m.n.status === "pending").length,
    bestBp: accepted.length === 0 ? null : Math.max(...accepted.map((m) => m.n.detail.claimedMedianBp)),
    depth: Math.max(0, ...members.map((m) => m.depth)),
  };
}

/** One branch = everything under one child of the start version. */
export function BranchesView({ forest, nodes, benchTotal, onOpen }: Props) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const collect = (id: string, depth: number, acc: Member[]): Member[] => {
    const n = byId.get(id);
    if (n) acc.push({ n, depth });
    for (const k of forest.children[id] ?? []) collect(k, depth + 1, acc);
    return acc;
  };

  const branches = forest.roots.flatMap((root) =>
    (forest.children[root] ?? []).map((id) => ({ head: byId.get(id)!, members: collect(id, 1, []) })),
  );
  const all = totalsOf(branches.flatMap((b) => b.members));

  return (
    <div className="branches">
      <dl className="branch-totals">
        <div><dt>Branches</dt><dd>{branches.length}</dd></div>
        <div><dt>Versions</dt><dd>{nodes.length}</dd></div>
        <div><dt>Accepted</dt><dd>{all.accepted}</dd></div>
        <div><dt>Rejected, kept</dt><dd>{all.rejected}</dd></div>
        <div><dt>Pending</dt><dd>{all.pending}</dd></div>
        <div><dt>Best</dt><dd>{all.bestBp === null ? "—" : shortTasks(all.bestBp, benchTotal)}</dd></div>
        <div><dt>Deepest</dt><dd>{all.depth} {all.depth === 1 ? "step" : "steps"}</dd></div>
      </dl>

      <ul className="branch-grid">
        {branches.map((b, i) => {
          const t = totalsOf(b.members);
          const verdict = t.accepted > 0 ? "Improved" : t.rejected === t.versions ? "Dead end" : "Open";
          return (
            <li key={b.head.id} className="branch-card">
              <div className="branch-top">
                <span className="eyebrow">Branch {i + 1} · {objectiveOf(b.head)}</span>
                <span className={verdict === "Improved" ? "tag tag-real" : verdict === "Dead end" ? "tag tag-example" : "tag"}>{verdict}</span>
              </div>
              <p className="branch-hyp">{clip(b.head.hypothesis, 110)}</p>
              <div className="card-mini"><MiniTree nodes={b.members.map((m) => m.n)} /></div>
              <dl className="card-stats">
                <div><dt>Versions</dt><dd>{t.versions}</dd></div>
                <div><dt>Accepted</dt><dd>{t.accepted}</dd></div>
                <div><dt>Rejected</dt><dd>{t.rejected}</dd></div>
                <div><dt>Pending</dt><dd>{t.pending}</dd></div>
              </dl>
              <div className="branch-foot">
                <span>best {t.bestBp === null ? "—" : shortTasks(t.bestBp, benchTotal)} · {t.depth} {t.depth === 1 ? "step" : "steps"} deep</span>
                <button type="button" onClick={() => onOpen(b.head.id)}>Show in tree →</button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
