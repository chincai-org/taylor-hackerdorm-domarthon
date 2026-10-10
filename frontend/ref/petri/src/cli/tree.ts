/**
 * The materialised view of §6.10, rebuilt on every load.
 *
 * Nothing here is stored. Status is derived from the evidence every time, so a
 * stale cache can never contradict the log. `.petri/index/` is a cache that
 * `petri fsck` recomputes and compares.
 *
 * The CLI builds this view because it is the only layer that may import the
 * store (L2), the reducer (L2) and the policy (L3) at once.
 */
import type { PetriNode, NodeStatus } from '../core/schema.js';
import type { ReplayNode, ReplayResult } from '../consensus/replay.js';
import { replay } from '../consensus/replay.js';
import {
  evaluate,
  type CountedVerification,
  type LedgerKind,
  type NodeFacts,
  type Verdict,
} from '../policy/acceptance.js';
import type { VerificationSigned } from '../consensus/messages.js';
import { checkReport, independentReports } from '../trust/report.js';
import type { SignedReport } from '../trust/report.js';
import type { IgnoredKind, IgnoredVerification, VerifierTally } from './banner.js';
import { contentId } from '../core/canonical.js';
import { medianInt } from '../core/schema.js';
import { asCanon, type Ctx } from './context.js';
import { EXIT, fail } from './exit.js';

export interface TreeView {
  /** Every node that exists on disk, or in the log, or in both. */
  nodes: Map<string, PetriNode>;
  /** The full verdict per node, including every ignored verification and why. */
  verdicts: Map<string, Verdict>;
  /** parent id (or 'root') -> child ids, sorted. */
  children: Map<string, string[]>;
  /** Nodes whose parent is 'root', sorted by sequence then id. */
  roots: string[];
  /** The raw reducer output, for commands that report skipped log entries. */
  replay: ReplayResult;
  /** Nodes present in the log but absent from this machine's object store. */
  missing: string[];
}

/** Build a `VerificationSigned` view of a stored report, for the acceptance rule. */
function signedMessageOf(nodeId: string, parent: string, tree: string, signed: SignedReport):
  | { pub: string; msg: VerificationSigned }
  | null {
  const checked = checkReport(signed);
  if (!checked.ok) return null;
  const r = checked.report;
  const scores = r.candidate.runs.map((x) => x.scoreBp);
  const msg: VerificationSigned = {
    candMedianBp: r.candidate.medianBp,
    clean: true,
    deltaMedianBp: r.deltaMedianBp,
    envHash: contentId(asCanon(r.env)),
    mode: r.mode,
    node: r.candidate.node,
    parent: r.parent.node,
    parentMedianBp: r.parent.medianBp,
    report: checked.id,
    runs: r.runs,
    spreadBp: Math.max(...scores) - Math.min(...scores),
    tree,
    type: 'VerificationSigned',
  };
  if (msg.node !== nodeId || msg.parent !== parent) return null;
  return { pub: signed.pub, msg };
}

/**
 * Load every node, then derive its status.
 *
 * The log is the authority. A node that was written but never published still
 * appears, with the status the evidence on disk supports.
 */
export async function loadTree(ctx: Ctx): Promise<TreeView> {
  const log = ctx.log();
  let result: ReplayResult;
  try {
    result = await replay(log.read(), ctx.config.treeId, ctx.config.policy);
  } catch (err) {
    fail(EXIT.INTEGRITY, (err as Error).message);
  }

  const nodes = new Map<string, PetriNode>();
  const verdicts = new Map<string, Verdict>();
  const missing: string[] = [];
  const onDisk = new Set(ctx.store.listNodeIds());

  for (const [id, rn] of result.nodes) {
    if (!onDisk.has(id)) {
      missing.push(id);
      continue;
    }
    const built = materialise(ctx, id, rn);
    nodes.set(id, built.node);
    verdicts.set(id, built.verdict);
  }

  // A node written locally but not yet published is still real. Show it.
  for (const id of onDisk) {
    if (nodes.has(id)) continue;
    const built = materialise(ctx, id, null);
    nodes.set(id, built.node);
    verdicts.set(id, built.verdict);
  }

  const children = new Map<string, string[]>();
  for (const id of [...nodes.keys()].sort()) {
    const parent = nodes.get(id)!.manifest.parent;
    const list = children.get(parent) ?? [];
    list.push(id);
    children.set(parent, list);
  }
  for (const [, list] of children) {
    list.sort((a, b) => {
      const sa = nodes.get(a)!.seq;
      const sb = nodes.get(b)!.seq;
      return sa === sb ? a.localeCompare(b) : sa - sb;
    });
  }

  return {
    nodes,
    verdicts,
    children,
    roots: children.get('root') ?? [],
    replay: result,
    missing: missing.sort(),
  };
}

function materialise(
  ctx: Ctx,
  id: string,
  rn: ReplayNode | null,
): { node: PetriNode; verdict: Verdict } {
  const manifest = ctx.store.readManifest(id);
  const detail = ctx.store.readDetail(id);
  const verifications = ctx.store.readVerifications(id);

  let facts: NodeFacts | null = rn;   // ReplayNode IS a NodeFacts.
  if (facts === null) {
    // Not in the log. Derive from the reports stored beside the node.
    const map = new Map<string, CountedVerification>();
    let seq = 0;
    for (const signed of verifications) {
      const view = signedMessageOf(id, manifest.parent, manifest.tree, signed);
      if (view === null) continue;
      seq += 1;
      if (!map.has(view.pub)) map.set(view.pub, { pub: view.pub, msg: view.msg, seq });
    }
    facts = {
      nodeId: id,
      author: manifest.author,
      bench: manifest.bench,
      mode: detail.mode,
      parent: manifest.parent,
      verifications: map,
      withdrawn: false,
      superseded: false,
    };
  }

  // The rule runs here, not in the reducer, because only this layer knows the
  // ledger. `replay` is pure and ledger-blind, so its own verdict always uses
  // the weakest wording. The decision is identical; only the sentence differs.
  const ledger: LedgerKind = ctx.config.ledger;
  const verdict = evaluate(facts, ctx.config.policy, ledger);

  let diff = '';
  try {
    diff = ctx.store.readDiff(id);
  } catch {
    diff = '';
  }

  return {
    node: {
      id,
      manifest,
      detail,
      diff,
      verifications,
      status: verdict.status,
      statusCode: verdict.code,
      statusReason: verdict.reason,
      verifiedDeltaBp: verdict.deltaBp,
      disputed: rn?.disputed ?? false,
      mode: detail.mode,
      trust: ctx.trust,
      seq: rn?.submittedSeq ?? 0,
      consensusNanos: rn?.submittedNanos ?? '0',
    },
    verdict,
  };
}

/**
 * The stored reports that the acceptance rule actually counted, one per key.
 *
 * `PetriNode.verifications` is the RAW file list. It holds the author's own
 * reports and every repeat from one key. Nothing user-facing may count that
 * list. The collapse rule itself lives in `independentReports`, so there is one
 * definition of "one key is one vote", not a second copy here.
 *
 * The verdict is the authority when it is available: policy can drop a report
 * that the collapse rule keeps, for example a report with too few runs.
 */
function countedReports(node: PetriNode, verdict?: Verdict): SignedReport[] {
  const { counted } = independentReports(node.manifest.author, node.verifications);
  if (verdict === undefined) return counted;
  const keys = new Set(verdict.counted);
  return counted.filter((r) => keys.has(r.pub));
}

/** The short label for a status line. `pub === author` is a fact, not a guess. */
function kindOf(pub: string, why: string, author: string): IgnoredKind {
  if (pub === author) return 'self-report';
  if (why.includes('already verified')) return 'duplicate key';
  if (why.includes('did not check out')) return 'invalid report';
  return 'policy';
}

/**
 * The verifier count a reader may trust, and every report that did not count.
 *
 * `counted` is the verdict's own set when a verdict is given, so the number on
 * the status line can never disagree with the number in the reason sentence.
 */
export function verifierTally(node: PetriNode, verdict?: Verdict): VerifierTally {
  const author = node.manifest.author;
  const { counted, ignored } = independentReports(author, node.verifications);
  const out: IgnoredVerification[] = ignored.map((i) => ({
    pub: i.pub,
    kind: kindOf(i.pub, i.why, author),
    why: i.why,
  }));
  if (verdict === undefined) return { counted: counted.length, ignored: out };

  const keys = new Set(verdict.counted);
  for (const report of counted) {
    if (keys.has(report.pub)) continue;
    const why = verdict.ignored.find((i) => i.pub === report.pub)?.why
      ?? 'the acceptance rule did not count this report';
    out.push({ pub: report.pub, kind: kindOf(report.pub, why, author), why });
  }
  return { counted: verdict.counted.length, ignored: out };
}

/** What the acceptance rule decided about ONE stored report. */
export interface ReportVerdict {
  counted: boolean;
  /** The reason it did not count. Empty when it counted. */
  why: string;
}

/**
 * The verdict on every stored report of a node, keyed by REPORT ID.
 *
 * `verifierTally` gives a reader the numbers. This gives a per-file answer, for
 * `petri export`, which must label each report row on its own. The key is the
 * report id and never the public key: one key can store several reports and only
 * the first one counts, so a per-key answer marks the repeat as counted and
 * inflates the evidence a viewer sees.
 *
 * A report that does not check out has no trustworthy id and is absent here.
 * Every caller already drops those rows.
 */
export function reportVerdicts(node: PetriNode, verdict?: Verdict): Map<string, ReportVerdict> {
  const author = node.manifest.author;
  const { counted, ignored } = independentReports(author, node.verifications);
  const out = new Map<string, ReportVerdict>();

  for (const i of ignored) {
    if (i.id !== null) out.set(i.id, { counted: false, why: i.why });
  }

  const keys = verdict === undefined ? null : new Set(verdict.counted);
  for (const report of counted) {
    const checked = checkReport(report);
    if (!checked.ok) continue; // Unreachable: independentReports already checked it.
    if (keys === null || keys.has(report.pub)) {
      out.set(checked.id, { counted: true, why: '' });
      continue;
    }
    out.set(checked.id, {
      counted: false,
      why: verdict?.ignored.find((i) => i.pub === report.pub)?.why
        ?? 'the acceptance rule did not count this report',
    });
  }
  return out;
}

/** Every counted verifier delta on a node, for a contested status line. */
export function deltasOf(node: PetriNode, verdict?: Verdict): number[] {
  const out: number[] = [];
  for (const signed of countedReports(node, verdict)) {
    const checked = checkReport(signed);
    if (checked.ok) out.push(checked.report.deltaMedianBp);
  }
  return out;
}

/** The median score a node's own author claimed. 0 when it was never measured. */
export function claimedMedianOf(node: PetriNode): number {
  if (node.detail.claimedRuns.length === 0) return node.detail.claimedMedianBp;
  return medianInt(node.detail.claimedRuns.map((r) => r.scoreBp));
}

/** The verified median of a node: the lowest candidate median any verifier measured. */
export function verifiedMedianOf(node: PetriNode, verdict?: Verdict): number | null {
  let lowest: number | null = null;
  for (const signed of countedReports(node, verdict)) {
    const checked = checkReport(signed);
    if (!checked.ok) continue;
    const m = checked.report.candidate.medianBp;
    lowest = lowest === null ? m : Math.min(lowest, m);
  }
  return lowest;
}

/** Root-first path from the root to this node. */
export function lineageOf(view: TreeView, id: string): PetriNode[] {
  const path: PetriNode[] = [];
  const seen = new Set<string>();
  let cur: string = id;
  while (cur !== 'root') {
    if (seen.has(cur)) break; // fsck check 3 reports the cycle. Never loop here.
    seen.add(cur);
    const node = view.nodes.get(cur);
    if (node === undefined) break;
    path.push(node);
    cur = node.manifest.parent;
  }
  return path.reverse();
}

export const depthOf = (view: TreeView, id: string): number => lineageOf(view, id).length;

const LIVE: ReadonlySet<NodeStatus> = new Set<NodeStatus>([
  'pending',
  'accepted',
  'rejected',
  'contested',
]);

/** Accepted leaves. These are the frontiers worth extending. */
export function tipsOf(view: TreeView): PetriNode[] {
  const tips: PetriNode[] = [];
  for (const node of view.nodes.values()) {
    if (node.status !== 'accepted') continue;
    const kids = view.children.get(node.id) ?? [];
    if (kids.some((k) => view.nodes.get(k)?.status === 'accepted')) continue;
    tips.push(node);
  }
  return tips.sort((a, b) => depthOf(view, b.id) - depthOf(view, a.id) || a.id.localeCompare(b.id));
}

/**
 * The node a new candidate extends by default.
 * An accepted leaf wins. With no accepted node, the deepest live node wins.
 */
export function currentTip(view: TreeView): PetriNode | null {
  const accepted = tipsOf(view);
  if (accepted.length > 0) return accepted[0]!;
  const live = [...view.nodes.values()].filter((n) => LIVE.has(n.status));
  if (live.length === 0) return null;
  live.sort(
    (a, b) =>
      depthOf(view, b.id) - depthOf(view, a.id) || a.seq - b.seq || a.id.localeCompare(b.id),
  );
  return live[0]!;
}
