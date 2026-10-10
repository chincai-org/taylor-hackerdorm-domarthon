/**
 * The context flattener. SPEC.md §12.2.
 *
 * Input: the whole tree. Output: a compact digest an agent reads before it
 * proposes node N+1. The digest is deterministic: the same ledger always gives
 * the same bytes. No model takes part.
 */

import { medianInt, type Mode, type NodeStatus, type PetriNode } from '../core/schema.js';
import { sha256Hex } from '../core/canonical.js';
import { AREAS, AREA_INDEX, classifyAreas, isArea, type Area, type ChangedFile } from './areas.js';
import { fmtBp, renderDigest } from './render.js';

export type Verdict = 'PRODUCTIVE' | 'SATURATED' | 'OPEN' | 'NEVER TRIED';

export interface MotifStat {
  motif: string; area: Area; attempts: number; accepted: number;
  bestDeltaBp: number; nodeIds: string[]; exhausted: boolean;
  /** Added. Attempts still waiting for two independent verifications. */
  pending: number;
  /** Added. The mechanical class that stopped every attempt, or null. */
  mechanical: string | null;
}

/** Added. The best measured node of an area, whatever its status. */
export interface AreaBest {
  nodeId: string; label: string; motif: string; deltaBp: number;
  status: NodeStatus; accepted: boolean; tokenDeltaPerTask: number | null;
}

export interface AreaStat {
  area: Area; tried: number; accepted: number; rejected: number; pending: number;
  bestDeltaBp: number | null; bestNodeId: string | null;
  verdict: Verdict; motifs: MotifStat[];
  /** Added. Nodes in this area whose verifiers disagreed on the sign. */
  contested: number;
  /** Added. The best measured node, accepted or not. Null when nothing measured. */
  best: AreaBest | null;
  /** Added. Generated, factual lines. Never an opinion the data does not carry. */
  notes: string[];
}

export interface FailureCard {
  nodeId: string; area: Area; motif: string;
  hypothesis: string;        // VERBATIM.
  hypothesisTruncated: boolean;
  rejection: string;         // "REGRESSION -830bp (6820 -> 5990)"
  tokenDelta: number | null; // Tokens per task, against the parent.
}

/** Added. One row of the accepted spine, reduced to display numbers. */
export interface SpineRow {
  nodeId: string; label: string; area: Area | '-'; motif: string;
  medianBp: number; deltaBp: number | null;
  tokensPerTask: number | null; hypothesis: string;
}

/** Added. The rules section 8 prints. SPEC.md §12.4, §13.2, §13.3. */
export interface DigestConstraints {
  minDeltaBp: number; maxFiles: number; maxChangedLines: number;
  maxCalls: number; maxTokens: number;
}

export interface Digest {
  bench: string; benchName: string;
  mode: Mode; ledger: 'hcs' | 'local';
  taskCount: number; runs: number;
  totals: { nodes: number; accepted: number; rejected: number; pending: number; contested: number };
  head: { nodeId: string; medianBp: number };
  root: { nodeId: string; medianBp: number };
  spine: PetriNode[];
  areas: AreaStat[];
  neverTried: Area[];
  notableFailures: FailureCard[];
  exhaustedMotifs: MotifStat[];
  mechanicalFailures: { nodeId: string; cls: string; evidenceHead: string }[];
  knownMotifs: string[];
  /**
   * sha256 of the rendered text, first 8 hex characters.
   *
   * OBSERVATION, never identity. The rendered text covers every node this
   * machine holds, including nodes that were written locally and never
   * published, so two machines reading one tree can print two hashes. It tells
   * a reader which digest a proposer read. It must never enter a node id, and
   * `src/core/ids.ts` drops it. SPEC.md §6.4a.
   */
  digestHash: string;
  /** Added. Node id -> the short label the text prints, "n000" style. */
  labels: Record<string, string>;
  /** Added. The display numbers of each spine row, so the renderer only formats. */
  spineRows: SpineRow[];
  /** Added. Nodes measured in the other mode. A digest never mixes modes. */
  excludedByMode: number;
  /** Added. */
  constraints: DigestConstraints;
}

export interface DigestInput {
  readonly nodes: readonly PetriNode[];
  readonly bench: string;
  readonly benchName: string;
  readonly mode: Mode;
  readonly ledger: 'hcs' | 'local';
  readonly taskCount: number;
  readonly runs: number;
  readonly constraints?: Partial<DigestConstraints>;
}

export const DEFAULT_CONSTRAINTS: DigestConstraints = {
  minDeltaBp: 1000, maxFiles: 2, maxChangedLines: 120, maxCalls: 8, maxTokens: 120_000,
};

/** A hypothesis is quoted verbatim up to this many characters. §12.2. */
export const HYPOTHESIS_CHARS = 240;
/** The notable-failure section holds at most this many cards. §12.2. */
export const MAX_FAILURE_CARDS = 6;
/** A motif dies after this many attempts with nothing to show. §12.2. */
export const MOTIF_EXHAUSTED_AT = 2;
/** An area is broad, so it needs more before it closes. §12.2. */
export const AREA_SATURATED_AT = 3;

/** Rejection class priority for the notable-failure ranking. Lower ranks first. */
const CLASS_PRIORITY: Record<string, number> = {
  REGRESSION: 0,
  CONTESTED: 1,
  WITHIN_NOISE: 2,
  'typecheck-failed': 3,
  'malformed-proposal': 4,
};
const CLASS_PRIORITY_OTHER = 5;
/** Stands in for a missing delta in a sort key. Real deltas never reach it. */
const NO_DELTA = -1_000_000;
const PLACEHOLDER_HASH = '00000000';

// ---------------------------------------------------------------------------
// One node, reduced to the numbers the digest prints
// ---------------------------------------------------------------------------

interface NodeView {
  node: PetriNode;
  id: string;
  label: string;
  parent: string;
  isRoot: boolean;
  area: Area;
  motif: string;
  status: NodeStatus;
  statusCode: string;
  /** The measured median of this node, in basis points. Null when nothing ran. */
  medianBp: number | null;
  /** The parent side of the SAME paired report, so the two are comparable. */
  parentMedianBp: number | null;
  /** The agreed delta. Null when no verifier measured it. */
  deltaBp: number | null;
  /** True when a runner other than the author produced the numbers above. */
  verified: boolean;
  tokensPerTask: number | null;
  mechanical: string;
  mechanicalEvidence: string;
  hypothesisLine: string;   // The signed one-liner from the manifest.
  hypothesisFull: string;   // The proposal text. Longer. Quoted verbatim.
}

type Report = PetriNode['verifications'][number]['body'];

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** A median that never throws. An even count takes the lower middle element. */
function medianSafe(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  if (xs.length % 2 === 1) return medianInt(xs);
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[xs.length / 2 - 1] ?? null;
}

/** The unified diff is display only. It is the fallback when derivedAreas is empty. */
function changedFilesFromDiff(diff: string): ChangedFile[] {
  const files: ChangedFile[] = [];
  let cur: ChangedFile | null = null;
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('+++ ')) {
      const p = raw.slice(4).trim().replace(/^b\//, '');
      if (p !== '' && p !== '/dev/null') {
        cur = { path: p, addedLines: [], removedLines: [] };
        files.push(cur);
      }
      continue;
    }
    if (raw.startsWith('--- ') || raw.startsWith('@@')
      || raw.startsWith('diff ') || raw.startsWith('index ')) continue;
    if (cur === null) continue;
    if (raw.startsWith('+')) cur.addedLines.push(raw.slice(1));
    else if (raw.startsWith('-')) cur.removedLines.push(raw.slice(1));
  }
  return files;
}

/**
 * The area a node counts toward. The digest uses the DERIVED set, so a model
 * cannot mislabel its way around a saturated area. §12.1.
 */
function areaOf(node: PetriNode): Area {
  const derived = node.detail.derivedAreas.filter(isArea);
  const declared = node.detail.proposal.primaryArea;
  if (!node.detail.areaMismatch && isArea(declared) && derived.includes(declared)) return declared;
  const first = derived[0];
  if (first !== undefined) return first;
  if (node.diff !== '') return classifyAreas(changedFilesFromDiff(node.diff)).primaryArea;
  return 'other';
}

/**
 * The paired report that decides. §9 gives the decision to the most
 * conservative verifier, so the digest prints that verifier's numbers. Both
 * medians come from ONE report, on one machine, so they are comparable.
 * The author's own report counts for display only, and never when an
 * independent one exists.
 */
function decisiveReport(node: PetriNode): { report: Report; independent: boolean } | null {
  const mine = node.verifications.filter((v) => v.body.candidate.node === node.id);
  const independent = mine.filter((v) => v.pub !== node.manifest.author);
  const use = independent.length > 0 ? independent : mine;
  if (use.length === 0) return null;
  const sorted = [...use].sort(
    (a, b) => a.body.deltaMedianBp - b.body.deltaMedianBp || cmp(a.pub, b.pub),
  );
  const chosen = sorted[0];
  if (chosen === undefined) return null;
  return { report: chosen.body, independent: independent.length > 0 };
}

function buildView(node: PetriNode, label: string, taskCount: number): NodeView {
  const decisive = decisiveReport(node);
  const report = decisive?.report ?? null;

  const claimedTokens = medianSafe(node.detail.claimedRuns.map((r) => r.tokens));
  const reportTokens = report === null ? null : medianSafe(report.candidate.runs.map((r) => r.tokens));
  const tokens = claimedTokens ?? reportTokens;

  const medianBp = report !== null
    ? report.candidate.medianBp
    : node.detail.claimedRuns.length > 0 ? node.detail.claimedMedianBp : null;

  return {
    node,
    id: node.id,
    label,
    parent: node.manifest.parent,
    isRoot: node.manifest.parent === 'root',
    area: areaOf(node),
    motif: node.detail.proposal.motif,
    status: node.status,
    statusCode: String(node.statusCode),
    medianBp,
    parentMedianBp: report?.parent.medianBp ?? null,
    deltaBp: node.verifiedDeltaBp ?? report?.deltaMedianBp ?? null,
    verified: decisive?.independent ?? false,
    tokensPerTask: tokens === null || taskCount <= 0 ? null : Math.round(tokens / taskCount),
    mechanical: node.detail.mechanical.cls,
    mechanicalEvidence: node.detail.mechanical.evidence,
    hypothesisLine: node.manifest.hypothesis,
    hypothesisFull: node.detail.proposal.hypothesis !== ''
      ? node.detail.proposal.hypothesis
      : node.manifest.hypothesis,
  };
}

// ---------------------------------------------------------------------------
// buildDigest
// ---------------------------------------------------------------------------

export function buildDigest(input: DigestInput): Digest {
  const constraints: DigestConstraints = { ...DEFAULT_CONSTRAINTS, ...(input.constraints ?? {}) };
  const taskCount = input.taskCount;

  // A replay number and a live number can never be compared. §9.6. The digest
  // states its mode in the header, and the other mode enters no statistic.
  const ordered = [...input.nodes].sort(
    (a, b) => a.seq - b.seq || cmp(a.consensusNanos, b.consensusNanos) || cmp(a.id, b.id),
  );
  const kept = ordered.filter((n) => n.mode === input.mode);
  const excludedByMode = ordered.length - kept.length;

  const views = kept.map((n, i) => buildView(n, `n${String(i).padStart(3, '0')}`, taskCount));
  const byId = new Map<string, NodeView>(views.map((v) => [v.id, v]));
  const labels: Record<string, string> = {};
  for (const v of views) labels[v.id] = v.label;

  const totals = {
    nodes: views.length,
    accepted: views.filter((v) => v.status === 'accepted').length,
    rejected: views.filter((v) => v.status === 'rejected').length,
    pending: views.filter((v) => v.status === 'pending').length,
    contested: views.filter((v) => v.status === 'contested').length,
  };

  // --- the accepted spine ---------------------------------------------------
  const accepted = views.filter((v) => v.status === 'accepted');
  const headView = [...accepted]
    .sort((a, b) => (b.medianBp ?? NO_DELTA) - (a.medianBp ?? NO_DELTA) || cmp(a.id, b.id))[0]
    ?? null;

  const spineViews: NodeView[] = [];
  let cursor: NodeView | null = headView;
  while (cursor !== null && spineViews.length <= views.length) {
    spineViews.unshift(cursor);
    cursor = cursor.isRoot ? null : byId.get(cursor.parent) ?? null;
  }
  const rootView = spineViews[0] ?? views.find((v) => v.isRoot) ?? null;

  const spineRows: SpineRow[] = spineViews.map((v) => ({
    nodeId: v.id,
    label: v.label,
    area: v.isRoot ? '-' : v.area,
    motif: v.motif === '' ? '-' : v.motif,
    medianBp: v.medianBp ?? 0,
    deltaBp: v.isRoot ? null : v.deltaBp,
    tokensPerTask: v.tokensPerTask,
    hypothesis: v.hypothesisLine,
  }));

  // --- per-area statistics --------------------------------------------------
  // The root introduces the whole harness, so it belongs to no single area.
  const changeViews = views.filter((v) => !v.isRoot);
  const areas = AREAS.map((area) => areaStat(area, changeViews.filter((v) => v.area === area), byId));
  areas.sort((a, b) =>
    b.tried - a.tried
    || b.accepted - a.accepted
    || (b.bestDeltaBp ?? NO_DELTA) - (a.bestDeltaBp ?? NO_DELTA)
    || AREA_INDEX[a.area] - AREA_INDEX[b.area]);

  const neverTried = AREAS.filter((a) => (areas.find((s) => s.area === a)?.tried ?? 0) === 0);

  const exhaustedMotifs = areas
    .flatMap((s) => s.motifs.filter((m) => m.exhausted))
    .sort((a, b) => AREA_INDEX[a.area] - AREA_INDEX[b.area] || cmp(a.motif, b.motif));

  // --- notable failures -----------------------------------------------------
  const notableFailures = changeViews
    .filter((v) => v.status === 'rejected' || v.status === 'contested' || v.mechanical !== 'ok')
    .sort((a, b) =>
      classPriority(a) - classPriority(b)
      || Math.abs(b.deltaBp ?? 0) - Math.abs(a.deltaBp ?? 0)
      || cmp(a.id, b.id))
    .slice(0, MAX_FAILURE_CARDS)
    .map((v) => failureCard(v, byId));

  const mechanicalFailures = changeViews
    .filter((v) => v.mechanical !== 'ok')
    .map((v) => ({
      nodeId: v.id,
      cls: v.mechanical,
      evidenceHead: evidenceHead(v.mechanicalEvidence),
    }));

  // --- the motif vocabulary, grouped by area --------------------------------
  const knownMotifs: string[] = [];
  for (const area of AREAS) {
    for (const v of changeViews) {
      if (v.area !== area || v.motif === '') continue;
      if (!knownMotifs.includes(v.motif)) knownMotifs.push(v.motif);
    }
  }

  const partial: Digest = {
    bench: input.bench,
    benchName: input.benchName,
    mode: input.mode,
    ledger: input.ledger,
    taskCount,
    runs: input.runs,
    totals,
    head: { nodeId: headView?.id ?? '', medianBp: headView?.medianBp ?? 0 },
    root: { nodeId: rootView?.id ?? '', medianBp: rootView?.medianBp ?? 0 },
    spine: spineViews.map((v) => v.node),
    areas,
    neverTried,
    notableFailures,
    exhaustedMotifs,
    mechanicalFailures,
    knownMotifs,
    digestHash: PLACEHOLDER_HASH,
    labels,
    spineRows,
    excludedByMode,
    constraints,
  };

  // The hash covers the whole rendering, with the hash field held at a fixed
  // placeholder and no token cap. Rendering is a pure function of the digest,
  // so the value is stable on every machine and at every budget.
  const hash = sha256Hex(renderDigest(partial, Number.MAX_SAFE_INTEGER)).slice(0, 8);
  return { ...partial, digestHash: hash };
}

function classPriority(v: NodeView): number {
  const key = v.status === 'rejected' || v.status === 'contested' ? v.statusCode : v.mechanical;
  return CLASS_PRIORITY[key] ?? CLASS_PRIORITY_OTHER;
}

// ---------------------------------------------------------------------------
// Area statistics
// ---------------------------------------------------------------------------

function areaStat(area: Area, inArea: NodeView[], byId: Map<string, NodeView>): AreaStat {
  const tried = inArea.length;
  const acceptedNodes = inArea.filter((v) => v.status === 'accepted');
  const rejected = inArea.filter((v) => v.status === 'rejected').length;
  const pending = inArea.filter((v) => v.status === 'pending').length;
  const contested = inArea.filter((v) => v.status === 'contested').length;

  const measured = inArea.filter((v) => v.deltaBp !== null);
  const bestView = [...measured]
    .sort((a, b) => (b.deltaBp ?? NO_DELTA) - (a.deltaBp ?? NO_DELTA) || cmp(a.id, b.id))[0]
    ?? null;
  const bestDeltaBp = bestView?.deltaBp ?? null;
  const motifs = motifStats(area, inArea);

  let verdict: Verdict;
  if (tried === 0) verdict = 'NEVER TRIED';
  else if (acceptedNodes.length > 0 && bestDeltaBp !== null && bestDeltaBp > 0) verdict = 'PRODUCTIVE';
  else if (tried >= AREA_SATURATED_AT && acceptedNodes.length === 0) verdict = 'SATURATED';
  else verdict = 'OPEN';

  const best: AreaBest | null = bestView === null ? null : {
    nodeId: bestView.id,
    label: bestView.label,
    motif: bestView.motif === '' ? '-' : bestView.motif,
    deltaBp: bestView.deltaBp ?? 0,
    status: bestView.status,
    accepted: bestView.status === 'accepted',
    tokenDeltaPerTask: tokenDelta(bestView, byId),
  };

  return {
    area, tried, accepted: acceptedNodes.length, rejected, pending, contested,
    bestDeltaBp, bestNodeId: bestView?.id ?? null,
    verdict, motifs, best, notes: areaNotes(area, inArea, verdict, best),
  };
}

function motifStats(area: Area, inArea: NodeView[]): MotifStat[] {
  const order: string[] = [];
  const groups = new Map<string, NodeView[]>();
  for (const v of inArea) {
    const key = v.motif === '' ? '(unnamed)' : v.motif;
    const list = groups.get(key);
    if (list === undefined) { groups.set(key, [v]); order.push(key); } else list.push(v);
  }

  const stats: MotifStat[] = order.map((motif) => {
    const group = groups.get(motif) ?? [];
    const accepted = group.filter((v) => v.status === 'accepted').length;
    const deltas = group.map((v) => v.deltaBp).filter((d): d is number => d !== null);
    const bestDeltaBp = deltas.length === 0 ? 0 : Math.max(...deltas);
    const allMechanical = group.length > 0 && group.every((v) => v.mechanical !== 'ok');
    return {
      motif, area,
      attempts: group.length,
      accepted,
      bestDeltaBp,
      nodeIds: group.map((v) => v.id),
      exhausted: group.length >= MOTIF_EXHAUSTED_AT && accepted === 0 && bestDeltaBp <= 0,
      pending: group.filter((v) => v.status === 'pending').length,
      mechanical: allMechanical ? group[0]?.mechanical ?? null : null,
    };
  });

  const firstSeen = new Map<string, number>(order.map((m, i) => [m, i]));
  return stats.sort((a, b) =>
    b.accepted - a.accepted
    || b.bestDeltaBp - a.bestDeltaBp
    || b.attempts - a.attempts
    || (firstSeen.get(a.motif) ?? 0) - (firstSeen.get(b.motif) ?? 0));
}

/** Every note states a fact the tree already holds. None is an opinion. */
function areaNotes(area: Area, inArea: NodeView[], verdict: Verdict, best: AreaBest | null): string[] {
  const notes: string[] = [];
  if (inArea.length === 0) return notes;

  let streak = 0;
  for (let i = inArea.length - 1; i >= 0; i--) {
    if (inArea[i]?.status === 'accepted') break;
    streak++;
  }
  if (streak >= AREA_SATURATED_AT) {
    notes.push(`the last ${streak} ${area} nodes all failed.`
      + (verdict === 'SATURATED' ? ` Cheap ${area} edits look mined out.` : ''));
  }

  if (best !== null && best.accepted) {
    const relapse = inArea
      .filter((v) => v.motif === best.motif && v.id !== best.nodeId && (v.deltaBp ?? 0) < 0)
      .sort((a, b) => (a.deltaBp ?? 0) - (b.deltaBp ?? 0))[0];
    if (relapse !== undefined) {
      notes.push(`${relapse.label} reused motif ${best.motif} and lost `
        + `${Math.abs(relapse.deltaBp ?? 0)}bp. The win does not generalise as written.`);
    }
  }

  const cheapest = inArea.filter((v) => v.tokensPerTask !== null);
  const dearest = [...cheapest].sort((a, b) => (b.tokensPerTask ?? 0) - (a.tokensPerTask ?? 0))[0];
  if (dearest !== undefined && dearest.status === 'rejected' && best !== null && best.accepted) {
    const bestTokens = inArea.find((v) => v.id === best.nodeId)?.tokensPerTask ?? null;
    if (bestTokens !== null && bestTokens > 0 && (dearest.tokensPerTask ?? 0) >= 2 * bestTokens) {
      notes.push(`${dearest.label} spent ${Math.round((dearest.tokensPerTask ?? 0) / bestTokens)}x `
        + `the tokens of the best node here and still failed.`);
    }
  }

  return notes;
}

// ---------------------------------------------------------------------------
// Failure cards and mechanical evidence
// ---------------------------------------------------------------------------

function tokenDelta(v: NodeView, byId: Map<string, NodeView>): number | null {
  const parentTokens = byId.get(v.parent)?.tokensPerTask ?? null;
  if (v.tokensPerTask === null || parentTokens === null) return null;
  return v.tokensPerTask - parentTokens;
}

function failureCard(v: NodeView, byId: Map<string, NodeView>): FailureCard {
  const hypothesis = v.hypothesisFull;
  const truncated = hypothesis.length > HYPOTHESIS_CHARS;

  const isScored = v.status === 'rejected' || v.status === 'contested';
  let rejection = isScored ? v.statusCode : v.mechanical;
  if (v.deltaBp !== null) {
    rejection += ` ${fmtBp(v.deltaBp)}`;
    if (v.parentMedianBp !== null && v.medianBp !== null) {
      rejection += ` (${v.parentMedianBp} -> ${v.medianBp})`;
    }
  } else if (v.mechanical !== 'ok') {
    rejection += ' (never ran)';
  }

  return {
    nodeId: v.id,
    area: v.area,
    motif: v.motif === '' ? '-' : v.motif,
    hypothesis: truncated ? hypothesis.slice(0, HYPOTHESIS_CHARS) : hypothesis,
    hypothesisTruncated: truncated,
    rejection,
    tokenDelta: tokenDelta(v, byId),
  };
}

function evidenceHead(evidence: string): string {
  const collapsed = evidence.split('\n').map((l) => l.trim()).filter((l) => l !== '').join(' ');
  return collapsed.length > 200 ? `${collapsed.slice(0, 199)}…` : collapsed;
}
