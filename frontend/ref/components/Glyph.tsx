import type { NodeStatus } from "@/lib/types";

/** Status by shape first, colour second. Remove the colour and it still reads. */
export function Glyph({ status, cx, cy, r, blocked = false }: { status: NodeStatus; cx: number; cy: number; r: number; blocked?: boolean }) {
  const d = r * 0.53;
  if (blocked) {
    return (
      <g>
        <circle className="g-hollow g-wait" cx={cx} cy={cy} r={r} />
        <path className="g-slash" d={`M${cx - d} ${cy + d} L${cx + d} ${cy - d}`} />
      </g>
    );
  }
  switch (status) {
    case "accepted":
      return <circle className="g-pass" cx={cx} cy={cy} r={r} />;
    case "rejected":
      return (
        <g>
          <circle className="g-hollow g-fail" cx={cx} cy={cy} r={r} />
          <path className="g-x" d={`M${cx - d} ${cy - d} L${cx + d} ${cy + d} M${cx + d} ${cy - d} L${cx - d} ${cy + d}`} />
        </g>
      );
    case "contested":
      return <path className="g-hollow g-wait" d={`M${cx} ${cy - r} L${cx + r} ${cy + r * 0.8} L${cx - r} ${cy + r * 0.8} Z`} />;
    default:
      return (
        <g>
          <circle className="g-hollow g-wait" cx={cx} cy={cy} r={r} />
          <circle className="g-dot" cx={cx} cy={cy} r={r * 0.28} />
        </g>
      );
  }
}
