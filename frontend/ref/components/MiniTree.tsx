import { buildForest, tidySlots } from "@/lib/layout";
import type { ExportNode } from "@/lib/types";
import { isBlocked } from "@/lib/format";
import { Glyph } from "./Glyph";

/** A small, label-free preview of a tree's shape for the gallery cards. */
export function MiniTree({ nodes }: { nodes: ExportNode[] }) {
  const forest = buildForest(nodes);
  const status = new Map(nodes.map((n) => [n.id, n.status]));
  const { slots, rows, maxDepth } = tidySlots(forest, (id) => status.get(id));
  const COL = 70;
  const ROW = 24;
  const P = 16;
  // A minimum drawing area, so a one-version branch keeps a small dot instead of
  // being stretched to fill the card. Small trees sit centred in that area.
  const cols = Math.max(maxDepth, 3);
  const spanRows = Math.max(rows - 1, 3);
  const dx = ((cols - maxDepth) * COL) / 2;
  const dy = ((spanRows - (rows - 1)) * ROW) / 2;
  const at = (id: string) => ({ x: P + dx + slots[id]!.depth * COL, y: P + dy + slots[id]!.row * ROW });
  const width = P * 2 + cols * COL;
  const height = P * 2 + spanRows * ROW;
  return (
    <svg className="mini" viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      {nodes.filter((n) => slots[n.parent] && slots[n.id]).map((n) => {
        const a = at(n.parent);
        const b = at(n.id);
        const mx = (a.x + b.x) / 2;
        return <path key={n.id} className={n.status === "rejected" ? "h-edge dead" : "h-edge"} d={`M${a.x} ${a.y} C ${mx} ${a.y}, ${mx} ${b.y}, ${b.x} ${b.y}`} />;
      })}
      {nodes.filter((n) => slots[n.id]).map((n) => {
        const { x, y } = at(n.id);
        return <Glyph key={n.id} status={n.status} cx={x} cy={y} r={5} />;
      })}
    </svg>
  );
}
