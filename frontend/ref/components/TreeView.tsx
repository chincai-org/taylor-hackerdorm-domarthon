"use client";

import type { ReactNode } from "react";
import { STATUS_WORD, isBlocked, nodeNumbers, wordOf } from "@/lib/format";
import type { Forest } from "@/lib/layout";
import type { ExportNode } from "@/lib/types";
import { Glyph } from "./Glyph";

interface Props {
  forest: Forest;
  nodes: ExportNode[];
  selected: string;
  onSelect: (id: string) => void;
  benchTotal: number;
  minVerifications: number;
}

const DEAD = new Set(["rejected", "withdrawn", "superseded"]);

/** The same lineage as a vertical list, for narrow screens. */
export function TreeView({ forest, nodes, selected, onSelect, benchTotal, minVerifications }: Props) {
  const byId = new Map(nodes.map((n) => [n.id, n]));

  // A render function, not a nested component, so rows keep focus across renders.
  const branch = (id: string): ReactNode => {
    const n = byId.get(id);
    if (!n) return null;
    const kids = forest.children[id] ?? [];
    const sel = id === selected;
    return (
      <li key={id} className={`t-node s-${n.status}${DEAD.has(n.status) ? " dead" : ""}`}>
        <button type="button" id={`node-${n.short}`} className={sel ? "t-row is-selected" : "t-row"}
          aria-pressed={sel} onClick={() => onSelect(id)}>
          <svg className="t-glyph" width="16" height="16" aria-hidden="true">
            <Glyph status={n.status} cx={8} cy={8} r={5.5} />
          </svg>
          <span className="t-text">
            <span className="t-word">{wordOf(n)} · {n.short}</span>
            <span className="t-hyp">{n.hypothesis}</span>
            <span className="t-num">{nodeNumbers(n, nodes, benchTotal, minVerifications)}</span>
          </span>
        </button>
        {kids.length > 0 && <ul>{kids.map(branch)}</ul>}
      </li>
    );
  };

  return (
    <ul className="tree list-view" aria-label={`Lineage of ${nodes.length} harness versions`}>
      {forest.roots.map(branch)}
    </ul>
  );
}
