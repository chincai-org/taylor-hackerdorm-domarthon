/**
 * `petri export` — the whole tree as one JSON document. SPEC.md §14.5.
 *
 * SPEC.md §15 gives this file the `log`, `replay` and `export` commands. Only
 * `export` is registered today. The other two are not stubbed here, because a
 * command that prints an apology is worse than a command that does not exist:
 * `petri --help` then stays an honest list of what this binary can do.
 *
 * The document is `petri/export/1`, the shape the web app at the repository
 * root reads. It is DISPLAY OUTPUT. It is never hashed and never
 * signed, so §2 of the contract does not bind it and `null` is allowed here for
 * "not computable".
 *
 * Four rules the exporter obeys, all from the contract:
 *   1. Rejected, contested, withdrawn and superseded nodes are all exported.
 *      Design rule 3: a failed experiment is a record.
 *   2. `counted` and `ignoredWhy` are COPIED from the Verdict that
 *      `src/policy/acceptance.ts` produced. A viewer that re-derived acceptance
 *      would be a second implementation of the accept rule.
 *   3. Every cost is a MEDIAN. Nothing here sums or averages a run. §10.9.
 *   4. A label is self-claimed decoration. The Hex64 key is the identity.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

import type { Command } from 'commander';

import type { Policy } from '../config.js';
import { medianInt, type EnvDescriptor, type Mode, type NodeStatus, type PetriNode, type RunRecord } from '../core/schema.js';
import type { DecisionCode } from '../policy/acceptance.js';
import type { LogEntry } from '../consensus/log.js';
import { anchorStatus, loadAnchorConfig, loadAnchorTimes, type AnchorReceipt } from '../consensus/anchor.js';
import { checkReport, spreadBpOf } from '../trust/report.js';
import { EXIT, fail } from './exit.js';
import { globalOptions, note, openCtx, out, type Ctx } from './context.js';
import { shortId, type TrustLabel } from './banner.js';
import { claimedMedianOf, loadTree, reportVerdicts, tipsOf, type TreeView } from './tree.js';

export const EXPORT_PROTOCOL = 'petri/export/1';
const CLI_VERSION = 'petri 0.1.0';

/* ------------------------------------------------------------------ *
 * The document. These interfaces are the binding shape.
 * ------------------------------------------------------------------ */

export interface RunnerRow {
  pub: string;
  /** Self-claimed. NEVER verified. Empty for a key this machine has no name for. */
  label: string;
  note: string;
  reports: number;
}

export interface ExportStats {
  total: number;
  accepted: number;
  rejected: number;
  pending: number;
  contested: number;
  withdrawn: number;
  superseded: number;
  /** The accepted node with the best claimed median, or '' when none is accepted. */
  head: string;
  tips: string[];
}

/** Where one record sits on the Hedera topic. Null until `petri hedera push` sends it. */
export interface ExportHedera {
  seq: number;
  txId: string;
  /** Consensus time from the mirror node, or null until `petri hedera check` reads it. */
  timestamp: string | null;
}

export interface ExportVerification {
  reportId: string;
  hedera: ExportHedera | null;
  /** The ENVELOPE pub, never report.runner. §5.3. */
  runner: string;
  runnerLabel: string;
  sig: string;
  counted: boolean;
  ignoredWhy: string;
  mode: Mode;
  runs: number;
  clean: boolean;
  spreadBp: number;
  deltaMedianBp: number;
  seedBase: string;
  startedAt: number;
  parent: { node: string; medianBp: number; total: number; runs: RunRecord[] };
  candidate: { node: string; medianBp: number; total: number; runs: RunRecord[] };
  env: EnvDescriptor;
}

export interface ExportDetail {
  proposal: {
    hypothesis: string;
    falsifiedIf: string;
    primaryArea: string;
    motif: string;
    metric: 'score' | 'tokens';
    predictedDelta: number;
    reasoning: string;
    whyNotUntested: string | null;
    contradicts: { nodeId: string; why: string }[];
    /** Path and size only. The source lives in the object store. */
    files: { path: string; bytes: number }[];
  };
  derivedAreas: string[];
  areaMismatch: boolean;
  claimedRuns: { passed: number; scoreBp: number; tokens: number; wallMs: number }[];
  claimedMedianBp: number;
  parentHarness: string;
  provenance: {
    source: 'model' | 'human' | 'model-via-human';
    model: string;
    promptHash: string;
    digestHash: string;
    seed: number;
  };
  mechanical: { cls: string; command: string; exitCode: number; evidence: string };
}

export interface ExportNode {
  id: string;
  short: string;
  label: string;
  seq: number;
  consensusNanos: string;
  parent: string;
  tree: string;
  author: string;
  authorLabel: string;
  harness: string;
  bench: string;
  hypothesis: string;
  status: NodeStatus;
  statusCode: DecisionCode;
  statusReason: string;
  verifiedDeltaBp: number | null;
  disputed: boolean;
  mode: Mode;
  trust: TrustLabel;
  detail: ExportDetail;
  diff: string;
  verifications: ExportVerification[];
  costs: { medianTokens: number; medianWallMs: number; tokensPerTask: number };
  /** The NodeSubmitted record on the Hedera topic. */
  hedera: ExportHedera | null;
}

export interface PetriExport {
  protocol: typeof EXPORT_PROTOCOL;
  generatedAt: number;
  cli: string;
  tree: string;
  mode: Mode;
  trust: TrustLabel;
  ledger: {
    kind: 'hcs' | 'local';
    lastSeq: number;
    headHash: string;
    topicId: string;
    network: string;
  };
  /** The Hedera topic that holds a copy of every record, or null. */
  hedera: { topicId: string; network: string } | null;
  bench: { id: string; name: string; total: number };
  policy: Policy;
  runsPerVerification: number;
  runners: RunnerRow[];
  stats: ExportStats;
  nodes: ExportNode[];
}

/* ------------------------------------------------------------------ *
 * Building it
 * ------------------------------------------------------------------ */

/** What the wire message says about a report, and the log says about nothing else. */
interface WireFacts {
  clean: boolean;
  spreadBp: number;
}

/** Read the log once for the head hash and for the two wire-only report fields. */
async function readLogFacts(ctx: Ctx): Promise<{
  lastSeq: number;
  headHash: string;
  wire: Map<string, WireFacts>;
  nodeSeq: Map<string, number>;
  reportSeq: Map<string, number>;
}> {
  const wire = new Map<string, WireFacts>();
  const nodeSeq = new Map<string, number>();
  const reportSeq = new Map<string, number>();
  let lastSeq = 0;
  let headHash = '';
  const entries: AsyncIterable<LogEntry> = ctx.log().read();
  for await (const entry of entries) {
    lastSeq = entry.seq;
    headHash = entry.chain;
    const body = entry.envelope.body;
    if (body.type === 'NodeSubmitted' && !nodeSeq.has(body.node)) nodeSeq.set(body.node, entry.seq);
    if (body.type === 'VerificationSigned' && !reportSeq.has(body.report)) reportSeq.set(body.report, entry.seq);
    // The first message from one key wins, exactly as the reducer decides it.
    if (body.type === 'VerificationSigned' && !wire.has(body.report)) {
      wire.set(body.report, { clean: body.clean, spreadBp: body.spreadBp });
    }
  }
  return { lastSeq, headHash, wire, nodeSeq, reportSeq };
}

/** `n013`. Display only. It must never enter a hash. */
const labelOf = (seq: number): string => `n${String(seq).padStart(3, '0')}`;

/** Medians of the author's CLAIMED runs. Never a sum, never a mean. */
function costsOf(node: PetriNode, taskTotal: number): ExportNode['costs'] {
  const runs = node.detail.claimedRuns;
  if (runs.length === 0) return { medianTokens: 0, medianWallMs: 0, tokensPerTask: 0 };
  const medianTokens = medianInt(runs.map((r) => r.tokens));
  return {
    medianTokens,
    medianWallMs: medianInt(runs.map((r) => r.wallMs)),
    tokensPerTask: taskTotal > 0 ? Math.floor(medianTokens / taskTotal) : 0,
  };
}

function detailOf(node: PetriNode): ExportDetail {
  const d = node.detail;
  return {
    proposal: {
      hypothesis: d.proposal.hypothesis,
      falsifiedIf: d.proposal.falsifiedIf,
      primaryArea: d.proposal.primaryArea,
      motif: d.proposal.motif,
      metric: d.proposal.metric,
      predictedDelta: d.proposal.predictedDelta,
      reasoning: d.proposal.reasoning,
      whyNotUntested: d.proposal.whyNotUntested,
      contradicts: d.proposal.contradicts.map((c) => ({ nodeId: c.nodeId, why: c.why })),
      // Path and byte count only. Carrying the source would roughly double the
      // document, and the page renders `diff`, which is what a reader wants.
      files: d.proposal.files.map((f) => ({
        path: f.path,
        bytes: Buffer.byteLength(f.contents, 'utf8'),
      })),
    },
    derivedAreas: [...d.derivedAreas],
    areaMismatch: d.areaMismatch,
    claimedRuns: d.claimedRuns.map((r) => ({
      passed: r.passed, scoreBp: r.scoreBp, tokens: r.tokens, wallMs: r.wallMs,
    })),
    claimedMedianBp: d.claimedMedianBp,
    parentHarness: d.parentHarness,
    provenance: { ...d.provenance },
    mechanical: { ...d.mechanical },
  };
}

function verificationsOf(
  view: TreeView, node: PetriNode, wire: Map<string, WireFacts>, labels: Map<string, string>,
  hederaOfReport: (reportId: string) => ExportHedera | null,
): ExportVerification[] {
  const verdict = view.verdicts.get(node.id);
  // Keyed by report id, never by key: one key can store several reports and only
  // the first one counts. A per-key answer would mark the repeat counted too.
  const decided = reportVerdicts(node, verdict);
  const rows: ExportVerification[] = [];

  for (const signed of node.verifications) {
    const checked = checkReport(signed);
    if (!checked.ok) continue; // fsck check 6 reports it. The viewer shows evidence only.
    const r = checked.report;
    const facts = wire.get(checked.id);
    rows.push({
      reportId: checked.id,
      hedera: hederaOfReport(checked.id),
      runner: signed.pub,
      runnerLabel: labels.get(signed.pub) ?? '',
      sig: signed.sig,
      counted: decided.get(checked.id)?.counted ?? false,
      ignoredWhy: decided.get(checked.id)?.why ?? 'this report is not in the counted set',
      mode: r.mode,
      runs: r.runs,
      // `clean` exists only on the wire message, so an unpublished report has no
      // honest value for it. Absent from the log reads as not clean, never as clean.
      clean: facts?.clean ?? false,
      spreadBp: facts?.spreadBp ?? spreadBpOf(r.candidate),
      deltaMedianBp: r.deltaMedianBp,
      seedBase: r.seedBase,
      startedAt: r.startedAt,
      parent: {
        node: r.parent.node, medianBp: r.parent.medianBp,
        total: r.parent.total, runs: r.parent.runs,
      },
      candidate: {
        node: r.candidate.node, medianBp: r.candidate.medianBp,
        total: r.candidate.total, runs: r.candidate.runs,
      },
      env: r.env,
    });
  }
  return rows.sort((a, b) => a.reportId.localeCompare(b.reportId));
}

function statsOf(view: TreeView): ExportStats {
  const stats: ExportStats = {
    total: view.nodes.size,
    accepted: 0, rejected: 0, pending: 0, contested: 0, withdrawn: 0, superseded: 0,
    head: '', tips: [],
  };
  let best = -1;
  for (const node of view.nodes.values()) {
    stats[node.status] += 1;
    if (node.status !== 'accepted') continue;
    const claimed = claimedMedianOf(node);
    if (claimed > best) { best = claimed; stats.head = node.id; }
  }
  stats.tips = tipsOf(view).map((n) => n.id);
  return stats;
}

/** One row per key that signed a report in this tree, plus this machine's own key. */
function runnersOf(view: TreeView, labels: Map<string, string>): RunnerRow[] {
  const counts = new Map<string, number>();
  for (const node of view.nodes.values()) {
    for (const signed of node.verifications) {
      counts.set(signed.pub, (counts.get(signed.pub) ?? 0) + 1);
    }
  }
  for (const pub of labels.keys()) if (!counts.has(pub)) counts.set(pub, 0);
  return [...counts]
    .map(([pub, reports]) => ({ pub, label: labels.get(pub) ?? '', note: '', reports }))
    .sort((a, b) => a.pub.localeCompare(b.pub));
}

export async function buildExport(ctx: Ctx, view: TreeView): Promise<PetriExport> {
  const { lastSeq, headHash, wire, nodeSeq, reportSeq } = await readLogFacts(ctx);

  // The Hedera copy of each record: its receipt, plus the consensus time once read back.
  let anchor: { topicId: string; network: string } | null = null;
  let receipts = new Map<number, AnchorReceipt>();
  let times: ReturnType<typeof loadAnchorTimes> = {};
  try {
    const cfg = loadAnchorConfig(ctx.root);
    if (cfg !== null) {
      anchor = { topicId: cfg.topicId, network: cfg.network };
      receipts = anchorStatus(ctx.root).logReceipts;
      times = loadAnchorTimes(ctx.root);
    }
  } catch {
    // A broken anchor file never stops the export. `petri hedera status` reports it.
  }
  const hederaAt = (logSeq: number | undefined): ExportHedera | null => {
    const r = logSeq === undefined ? undefined : receipts.get(logSeq);
    return r === undefined ? null : { seq: r.hcsSeq, txId: r.txId, timestamp: times[String(r.hcsSeq)]?.timestamp ?? null };
  };

  // The only label this machine can honestly supply is its own. Every other key
  // is a bare Hex64, which is the identity anyway.
  const labels = new Map<string, string>();
  try {
    const me = ctx.identity();
    labels.set(me.publicKeyHex, me.label);
  } catch {
    // A read-only checkout has no key. The export still works.
  }

  const taskTotal = benchTotal(ctx);
  const nodes = [...view.nodes.values()]
    .sort((a, b) => a.seq - b.seq || a.id.localeCompare(b.id))
    .map((node): ExportNode => ({
      id: node.id,
      short: node.id.slice(0, 8),
      label: labelOf(node.seq),
      seq: node.seq,
      consensusNanos: node.consensusNanos,
      parent: node.manifest.parent,
      tree: node.manifest.tree,
      author: node.manifest.author,
      authorLabel: labels.get(node.manifest.author) ?? '',
      harness: node.manifest.harness,
      bench: node.manifest.bench,
      hypothesis: node.manifest.hypothesis,
      status: node.status,
      statusCode: node.statusCode,
      statusReason: node.statusReason,
      verifiedDeltaBp: node.verifiedDeltaBp,
      disputed: node.disputed,
      mode: node.mode,
      trust: node.trust,
      detail: detailOf(node),
      diff: node.diff,
      verifications: verificationsOf(view, node, wire, labels, (id) => hederaAt(reportSeq.get(id))),
      costs: costsOf(node, taskTotal),
      hedera: hederaAt(nodeSeq.get(node.id)),
    }));

  return {
    protocol: EXPORT_PROTOCOL,
    generatedAt: Date.now(),
    cli: CLI_VERSION,
    tree: ctx.config.treeId,
    mode: ctx.config.mode,
    trust: ctx.trust,
    ledger: {
      kind: ctx.config.ledger,
      lastSeq,
      headHash: ctx.config.ledger === 'local' ? headHash : '',
      topicId: ctx.config.hedera?.topicId ?? '',
      network: ctx.config.hedera?.network ?? '',
    },
    hedera: anchor,
    bench: { id: ctx.config.bench.id, name: ctx.config.bench.name, total: taskTotal },
    policy: ctx.config.policy,
    runsPerVerification: ctx.config.runsPerVerification,
    runners: runnersOf(view, labels),
    stats: statsOf(view),
    nodes,
  };
}

/** The task count of this tree's bench, or 0 when the spec is not in the store. */
function benchTotal(ctx: Ctx): number {
  try {
    return ctx.store.getBench(ctx.config.bench.id).total;
  } catch {
    return 0;
  }
}

/* ------------------------------------------------------------------ *
 * The command
 * ------------------------------------------------------------------ */

export function registerExport(program: Command): void {
  program
    .command('export')
    .description('write the whole tree as one JSON document, rejected branches included')
    .option('--out <file>', 'write to this file. Default: stdout.')
    .action(async (opts: { out?: string }, cmd: Command) => {
      const g = globalOptions(cmd);
      const ctx = openCtx(cmd);
      const view = await loadTree(ctx);
      const doc = await buildExport(ctx, view);
      await ctx.closeLog();

      const text = `${JSON.stringify(doc, null, 2)}\n`;
      if (opts.out === undefined) {
        out(text.trimEnd());
        return;
      }

      const path = isAbsolute(opts.out) ? opts.out : resolve(process.cwd(), opts.out);
      try {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, text, { encoding: 'utf8', mode: 0o644 });
      } catch (err) {
        fail(EXIT.NOT_FOUND, `could not write ${path}: ${(err as Error).message}`);
      }

      if (g.json) {
        out(JSON.stringify({ out: path, nodes: doc.nodes.length, bytes: text.length }, null, 2));
        return;
      }
      out(`wrote   ${path}`);
      out(`nodes   ${doc.nodes.length}  (${doc.stats.accepted} accepted, ` +
        `${doc.stats.rejected} rejected, ${doc.stats.pending} pending, ` +
        `${doc.stats.contested} contested)`);
      out(`tree    ${doc.tree}  mode ${doc.mode}  trust ${doc.trust}`);
      if (doc.stats.head !== '') out(`head    ${shortId(doc.stats.head)}`);
    });
}
