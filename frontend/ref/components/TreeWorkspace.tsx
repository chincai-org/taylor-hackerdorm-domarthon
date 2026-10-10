"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { STATUS_WORD, clip, isBlocked, nodeNumbers, wordOf } from "@/lib/format";
import type { Forest } from "@/lib/layout";
import type { ExportNode, ExportVerification, HederaTopic } from "@/lib/types";
import { Glyph } from "./Glyph";
import { LineageHero } from "./LineageHero";
import { NodePanel } from "./NodePanel";
import { TreeView } from "./TreeView";

interface Props {
  nodes: ExportNode[];
  forest: Forest;
  initial: string;
  minVerifications: number;
  /** The smallest delta that counts as a win, from the tree's policy. */
  minDeltaBp?: number;
  benchTotal: number;
  /** Rendered beside the full record. */
  info: ReactNode;
  /** The Stats view. */
  stats: ReactNode;
  /** Which view opens first. `?view=stats` sets it. */
  initialView?: View;
  /** The Hedera topic that holds a copy of every record. */
  hedera?: HederaTopic | null;
}

type View = "tree" | "stats";

/**
 * The version the stage demo accepts live. On every page load it is drawn as it
 * was BEFORE its second key, so the demo can be rehearsed. The real record is
 * unchanged and still reaches this page; the moment a new record arrives, the
 * real status is shown. Set it to "" to always show the recorded status.
 */
const DEMO_PENDING = "ae0acec3";

/**
 * Draw an accepted version as "waiting for its second key": its first check
 * only, and the status that goes with it. Display only, and never the reverse:
 * a version is never drawn as accepted when the record says it is not.
 */
function showAsPending(nodes: ExportNode[], prefix: string): ExportNode[] {
  if (prefix === "") return nodes;
  return nodes.map((n) => {
    if (!n.id.startsWith(prefix) || n.status !== "accepted") return n;
    return {
      ...n,
      status: "pending",
      statusCode: "INSUFFICIENT_VERIFICATIONS",
      statusReason: "1 of 2 verifications from distinct keys. The author's own runs never count.",
      verifiedDeltaBp: null,
      verifications: n.verifications.slice(0, 1),
    };
  });
}

/** A signed verification as it arrives from the Hedera topic. */
type WireVerification = {
  seq: number;
  timestamp: string;
  pub: string;
  body: {
    type: "VerificationSigned";
    node: string;
    parent: string;
    report: string;
    mode: "live" | "replay";
    runs: number;
    clean: boolean;
    spreadBp: number;
    deltaMedianBp: number;
    candMedianBp: number;
    parentMedianBp: number;
  };
};

/**
 * Add verifications that arrived on the Hedera topic after the page loaded.
 *
 * The deployed site reads a saved snapshot, so a verification run anywhere shows
 * up here only through the public topic. The same rule as the engine counts it:
 * never the author's key, one vote per key, and the version's own mode. The
 * status changes only in the two clear cases: every counted delta at or above
 * the margin (accepted), or every one at or below minus the margin (rejected).
 * `petri status` in the engine stays the authority.
 */
function applyLive(
  nodes: ExportNode[], arrived: WireVerification[], minVerifications: number, minDeltaBp: number, total: number,
): ExportNode[] {
  if (arrived.length === 0) return nodes;
  return nodes.map((n) => {
    const keys = new Set(n.verifications.filter((v) => v.counted).map((v) => v.runner));
    const added: ExportVerification[] = [];
    for (const w of arrived) {
      const b = w.body;
      if (b.node !== n.id || w.pub === n.author || keys.has(w.pub) || b.mode !== n.mode || !b.clean) continue;
      keys.add(w.pub);
      added.push({
        reportId: b.report,
        runner: w.pub,
        runnerLabel: "",
        counted: true,
        ignoredWhy: "",
        mode: b.mode,
        runs: b.runs,
        clean: b.clean,
        spreadBp: b.spreadBp,
        deltaMedianBp: b.deltaMedianBp,
        parent: { node: b.parent, medianBp: b.parentMedianBp, total, runs: [] },
        candidate: { node: b.node, medianBp: b.candMedianBp, total, runs: [] },
        hedera: { seq: w.seq, txId: "", timestamp: w.timestamp },
      });
    }
    if (added.length === 0) return n;
    const verifications = [...n.verifications, ...added];
    const deltas = verifications.filter((v) => v.counted).map((v) => v.deltaMedianBp);
    const enough = deltas.length >= minVerifications;
    if (enough && deltas.every((d) => d >= minDeltaBp)) {
      const worst = Math.min(...deltas);
      return {
        ...n,
        verifications,
        status: "accepted",
        statusCode: "WIN",
        statusReason: `${deltas.length} verifications from distinct keys, every one at or above +${minDeltaBp}bp. Worst delta +${worst}bp.`,
        verifiedDeltaBp: worst,
      };
    }
    if (enough && deltas.every((d) => d <= -minDeltaBp)) {
      const best = Math.max(...deltas);
      return {
        ...n,
        verifications,
        status: "rejected",
        statusCode: "REGRESSION",
        statusReason: `${deltas.length} verifications from distinct keys, every one at or below -${minDeltaBp}bp.`,
        verifiedDeltaBp: best,
      };
    }
    return { ...n, verifications };
  });
}

/**
 * STAGE SIMULATION. Pressing Space shows the SELECTED version as accepted by two
 * keys. It changes this browser tab only. Nothing is written, no record is
 * signed, and a refresh shows the recorded tree again.
 */
function simulateAccepted(nodes: ExportNode[], targetId: string): ExportNode[] {
  const template = nodes.find((n) => n.id.startsWith("ecc7cdb0"))?.verifications.filter((v) => v.counted) ?? [];
  return nodes.map((n) => {
    if (n.id !== targetId) return n;
    const verifications = template.slice(0, 2).map((v, i) => ({
      ...v,
      reportId: `simulated-${i}`,
      // A simulated check has no record on Hedera, so it must not link to one.
      hedera: null,
      counted: true,
      ignoredWhy: "",
      deltaMedianBp: 1000,
      parent: { ...v.parent, node: n.parent, medianBp: 9000 },
      candidate: { ...v.candidate, node: n.id, medianBp: 10000 },
    }));
    return {
      ...n,
      status: "accepted",
      statusCode: "WIN",
      statusReason: "2 verifications from distinct keys, every one at or above +1000bp. Worst delta +1000bp.",
      verifiedDeltaBp: 1000,
      detail: {
        ...n.detail,
        claimedMedianBp: 10000,
        mechanical: n.detail.mechanical ? { ...n.detail.mechanical, cls: "ok", evidence: "" } : undefined,
      },
      verifications,
    };
  });
}

export function TreeWorkspace({ nodes: recorded, forest, initial, minVerifications, minDeltaBp = 1000, benchTotal, info, stats, initialView = "tree", hedera = null }: Props) {
  const [selected, setSelected] = useState(initial);
  const [view, setView] = useState<View>(initialView);
  const [simulatedId, setSimulatedId] = useState<string | null>(null);
  // True until a new record arrives from the engine in this tab.
  const [beforeUpdate, setBeforeUpdate] = useState(true);
  // Signed verifications that reached the Hedera topic after this page loaded.
  const [arrived, setArrived] = useState<WireVerification[]>([]);
  const [toast, setToast] = useState<string | null>(null);

  const nodes = useMemo(() => {
    const base = beforeUpdate ? showAsPending(recorded, DEMO_PENDING) : recorded;
    const live = applyLive(base, arrived, minVerifications, minDeltaBp, benchTotal);
    return simulatedId === null ? live : simulateAccepted(live, simulatedId);
  }, [beforeUpdate, arrived, simulatedId, recorded, minVerifications, minDeltaBp, benchTotal]);

  // Watch the public topic. The first answer only sets the starting point, so a
  // refresh shows the tree as it was, and each new verify run appears when it lands.
  useEffect(() => {
    if (hedera === null) return;
    let after = -1;
    let stopped = false;
    const poll = async (): Promise<void> => {
      try {
        const res = await fetch(
          `/api/hedera-feed?topic=${hedera.topicId}&network=${hedera.network}&after=${after}`,
          { cache: "no-store" },
        );
        if (!res.ok) return;
        const data = (await res.json()) as { latest: number; messages: WireVerification[] };
        if (after >= 0) {
          const verifs = data.messages.filter((m) => (m.body as { type?: string }).type === "VerificationSigned");
          if (verifs.length > 0 && !stopped) {
            const last = verifs[verifs.length - 1]!;
            setArrived((prev) => [...prev, ...verifs]);
            setBeforeUpdate(false);
            setToast(`Verified by another key — on Hedera #${last.seq}`);
            window.setTimeout(() => { if (!stopped) setToast(null); }, 4000);
          }
        }
        after = Math.max(after, data.latest);
      } catch {
        // The mirror node or the network is down. The next poll tries again.
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 3000);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [hedera]);

  // The demo version changes colour only when its record is on Hedera, never on
  // the local file change alone. LiveRefresh announces the file change; the
  // Hedera watcher below makes the switch.

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "Space" || (e.target as HTMLElement | null)?.closest("input, textarea, select")) return;
      e.preventDefault();
      // The version on screen. A version that is already accepted stays as it is.
      setSimulatedId((current) => (current === null ? selected : current));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected]);

  const node = nodes.find((n) => n.id === selected) ?? nodes[0]!;
  const parent = nodes.find((n) => n.id === node.parent) ?? null;
  const shared = { forest, nodes, selected: node.id, onSelect: setSelected, benchTotal, minVerifications };

  return (
    <>
      <div className="view-bar">
        <div className="seg" role="group" aria-label="View">
          <button type="button" aria-pressed={view === "tree"} onClick={() => setView("tree")}>Tree</button>
          <button type="button" aria-pressed={view === "stats"} onClick={() => setView("stats")}>Stats</button>
        </div>
      </div>

      {view === "tree" ? (
        <figure className="stage">
          <div className="plate tree-plate">
            <div className="legend legend-overlay" aria-label="Legend">
              <span><svg width="14" height="14" aria-hidden="true"><Glyph status="accepted" cx={7} cy={7} r={5} /></svg>Accepted — two other keys re-ran it and agreed</span>
              <span><svg width="14" height="14" aria-hidden="true"><Glyph status="rejected" cx={7} cy={7} r={5} /></svg>Rejected — kept, with the reason</span>
              <span><svg width="14" height="14" aria-hidden="true"><Glyph status="pending" cx={7} cy={7} r={5} /></svg>Pending — waiting for keys</span>
              <span><svg width="22" height="14" aria-hidden="true"><line className="h-edge restore" x1="1" x2="21" y1="7" y2="7" /></svg>Runs the same harness as that version again</span>
            </div>
            <LineageHero {...shared} layoutNodes={recorded} />
            <TreeView {...shared} />
          </div>

          <div className={`selected-strip s-${node.status}`} aria-live="polite">
            <svg width="14" height="14" aria-hidden="true"><Glyph status={node.status} cx={7} cy={7} r={5} /></svg>
            <span className="sel-word">{wordOf(node)} · {node.short}</span>
            <span className="sel-hyp">{clip(node.hypothesis, 96)}</span>
            <span className="sel-num">{nodeNumbers(node, nodes, benchTotal, minVerifications)}</span>
            <a href="#record">Full record ↓</a>
          </div>
        </figure>
      ) : (
        stats
      )}

      <section id="record" className="record">
        <NodePanel node={node} parent={parent} nodes={nodes} minVerifications={minVerifications}
          benchTotal={benchTotal} onSelect={setSelected} hedera={hedera}
          onVerifyCopied={() => {
            // STAGE DEMO. Copying the verify command shows this version accepted,
            // the same simulation the Space key does. Display only, in this tab.
            const target = node.id;
            window.setTimeout(() => setSimulatedId((current) => current ?? target), 1200);
          }} />
        <div className="record-info">{info}</div>
      </section>
      {toast !== null && <div className="live-toast" role="status">{toast}</div>}
    </>
  );
}
