/**
 * The paired verification report. SPEC.md sections 5.3, 6.5, 6.6, 6.7, 6.8, 9.4.
 *
 * Why one report covers both sides. A verifier who runs only the candidate
 * proves nothing. Four things move an absolute score: the machine, test
 * flakiness, model drift and baseline drift. Only a delta measured on one
 * machine, in one session, with one seed set, is comparable.
 *
 * It also blocks one attack. A dishonest author measures the parent on a slow
 * machine and the candidate on a fast one, then claims a large gain. A paired
 * report makes that impossible, because the verifier produces both numbers.
 *
 * Every record type here is a TYPE ALIAS, not an interface. A report is hashed
 * and signed, so it must satisfy `Canon`. TypeScript gives an implicit index
 * signature to an object type alias and NOT to an interface.
 *
 * The record types and their Zod schemas are declared ONCE, in src/core/schema.ts,
 * which SPEC.md section 15 makes the owner of every shared interface and schema.
 * This file re-exports them, so `import { VerificationReport } from '../trust/report.js'`
 * keeps working and there is still only one declaration to keep in step with §6.5.
 */

import { contentId, sha256Hex } from '../core/canonical.js';
import {
  REPORT_PROTOCOL, VerificationReportSchema, medianInt, scoreBp,
  type EnvDescriptor, type Mode, type RunRecord, type SideSummary,
  type SignedReport, type VerificationReport,
} from '../core/schema.js';
import { openEnvelope, seal } from './envelope.js';
import type { Identity } from './identity.js';

export {
  REPORT_PROTOCOL, RunRecordSchema, SideSummarySchema, EnvDescriptorSchema,
  VerificationReportSchema,
} from '../core/schema.js';
export type {
  EnvDescriptor, RunRecord, SideSummary, SignedReport, VerificationReport,
} from '../core/schema.js';

// ---------------------------------------------------------------------------
// Seeds and ids. SPEC.md sections 6.6 and 6.8.
// ---------------------------------------------------------------------------

/**
 * Run i of the parent and run i of the candidate use the same seed. The seed
 * derives from the node id, so every honest verifier uses the same seeds.
 */
export const seedFor = (candidateNodeId: string, i: number): string =>
  sha256Hex(`petri/seed/1|${candidateNodeId}|${i}`);
export const seedBaseFor = (candidateNodeId: string): string =>
  sha256Hex(`petri/seed/1|${candidateNodeId}`);
export const reportId = (report: VerificationReport): string => contentId(report);

/** max minus min of one side's per-run scores. This is `spreadBp` on the wire. */
export function spreadBpOf(side: SideSummary): number {
  if (side.runs.length === 0) throw new Error('spread of an empty run list');
  const scores = side.runs.map((r) => r.scoreBp);
  return Math.max(...scores) - Math.min(...scores);
}

// ---------------------------------------------------------------------------
// Building and signing a report.
// ---------------------------------------------------------------------------

/** One measured run, before the derived numbers are filled in. */
export type RunInput = {
  passed: number;
  resultId: string;
  tokens: number;
  wallMs: number;
};

export type BuildReportInput = {
  tree: string;
  bench: string;
  mode: Mode;
  /** The VERIFIER public key. It must equal the key that signs the envelope. */
  runner: string;
  /** The parent node id, or the literal 'root'. SPEC.md section 6.9. */
  parentNode: string;
  /** The candidate node id. Every seed derives from it. */
  candidateNode: string;
  /** The task count. It MUST be the same on both sides. */
  total: number;
  parentRuns: readonly RunInput[];
  candidateRuns: readonly RunInput[];
  startedAt: number;
  env: EnvDescriptor;
};

/**
 * Fill in every derived number, then assert the result against the schema.
 * `checkReport` recomputes all of it, so a mistake here fails immediately.
 */
export function buildReport(input: BuildReportInput): VerificationReport {
  const n = input.candidateRuns.length;
  if (input.parentRuns.length !== n) {
    throw new Error(
      `petri: a paired report needs the same run count on both sides, got ` +
      `${input.parentRuns.length} parent and ${n} candidate.`,
    );
  }
  if (n % 2 === 0) throw new Error(`petri: the run count must be odd, got ${n}.`);
  if (n < 3) throw new Error(`petri: a report needs at least 3 runs, got ${n}.`);

  const side = (node: string, runs: readonly RunInput[]): SideSummary => {
    const records: RunRecord[] = runs.map((r, i) => ({
      passed: r.passed,
      resultId: r.resultId,
      scoreBp: scoreBp(r.passed, input.total),
      seed: seedFor(input.candidateNode, i),
      tokens: r.tokens,
      wallMs: r.wallMs,
    }));
    return {
      medianBp: medianInt(records.map((x) => x.scoreBp)),
      node,
      runs: records,
      total: input.total,
    };
  };

  const parent = side(input.parentNode, input.parentRuns);
  const candidate = side(input.candidateNode, input.candidateRuns);
  const deltas = candidate.runs.map((c, i) => c.scoreBp - parent.runs[i]!.scoreBp);

  const report: VerificationReport = {
    protocol: REPORT_PROTOCOL,
    tree: input.tree,
    bench: input.bench,
    mode: input.mode,
    runner: input.runner,
    runs: n,
    parent,
    candidate,
    deltaMedianBp: medianInt(deltas),
    seedBase: seedBaseFor(input.candidateNode),
    startedAt: input.startedAt,
    env: input.env,
  };

  const parsed = VerificationReportSchema.safeParse(report);
  if (!parsed.success) {
    throw new Error(`petri: built an invalid verification report: ${parsed.error.message}`);
  }
  return report;
}

/**
 * Sign a report. The signed bytes are `"petri/v1/report\n" + canonicalBytes(report)`.
 * ed25519 is deterministic, so signing the same report twice gives the same 64 bytes.
 */
export function signReport(report: VerificationReport, id: Identity): SignedReport {
  if (report.runner !== id.publicKeyHex) {
    throw new Error(
      `petri: report.runner is ${report.runner} but this identity is ${id.publicKeyHex}. ` +
      `The signer is read from the envelope, so the two must agree.`,
    );
  }
  return seal('report', report, id);
}

/** Build and sign in one step. The runner field is taken from the identity. */
export function buildSignedReport(
  input: Omit<BuildReportInput, 'runner'>, id: Identity,
): SignedReport {
  return signReport(buildReport({ ...input, runner: id.publicKeyHex }), id);
}

// ---------------------------------------------------------------------------
// Checking a report. SPEC.md section 6.7.
// ---------------------------------------------------------------------------

export type CheckReport =
  | { ok: true; report: VerificationReport; id: string }
  | { ok: false; reason: string };

/** Full structural and cryptographic check of a stored report. */
export function checkReport(value: unknown, expectedId?: string): CheckReport {
  const opened = openEnvelope<VerificationReport>('report', value);
  if (!opened.ok) return { ok: false, reason: opened.reason };
  const parsed = VerificationReportSchema.safeParse(opened.body);
  if (!parsed.success) return { ok: false, reason: `schema: ${parsed.error.message}` };
  const r = parsed.data;

  if (r.runner !== opened.pub) return { ok: false, reason: 'report.runner is not the signer' };
  if (r.runs % 2 === 0) return { ok: false, reason: `even run count ${r.runs}` };
  if (r.parent.runs.length !== r.runs || r.candidate.runs.length !== r.runs) {
    return { ok: false, reason: 'the run count does not match the run arrays' };
  }
  if (r.parent.total !== r.candidate.total) {
    return { ok: false, reason: 'the test totals differ between the two sides' };
  }
  if (r.env.mode !== r.mode) return { ok: false, reason: 'env.mode differs from report.mode' };
  if (r.env.benchId !== r.bench) return { ok: false, reason: 'env.benchId differs from report.bench' };
  if (r.seedBase !== seedBaseFor(r.candidate.node)) {
    return { ok: false, reason: 'seedBase is not derived from the candidate node id' };
  }

  // Recompute every derived number. A signature proves authorship, not arithmetic.
  if (medianInt(r.parent.runs.map((x) => x.scoreBp)) !== r.parent.medianBp) {
    return { ok: false, reason: 'the parent median is wrong' };
  }
  if (medianInt(r.candidate.runs.map((x) => x.scoreBp)) !== r.candidate.medianBp) {
    return { ok: false, reason: 'the candidate median is wrong' };
  }
  const deltas = r.candidate.runs.map((c, i) => c.scoreBp - r.parent.runs[i]!.scoreBp);
  if (medianInt(deltas) !== r.deltaMedianBp) return { ok: false, reason: 'the delta median is wrong' };

  for (let i = 0; i < r.runs; i++) {
    if (scoreBp(r.parent.runs[i]!.passed, r.parent.total) !== r.parent.runs[i]!.scoreBp) {
      return { ok: false, reason: `parent run ${i}: scoreBp does not match passed/total` };
    }
    if (scoreBp(r.candidate.runs[i]!.passed, r.candidate.total) !== r.candidate.runs[i]!.scoreBp) {
      return { ok: false, reason: `candidate run ${i}: scoreBp does not match passed/total` };
    }
    const want = seedFor(r.candidate.node, i);
    if (r.parent.runs[i]!.seed !== want || r.candidate.runs[i]!.seed !== want) {
      return { ok: false, reason: `run ${i}: the seed is not the derived seed` };
    }
  }

  const id = reportId(r);
  if (expectedId !== undefined && id !== expectedId) {
    return { ok: false, reason: `report id mismatch: ${id} != ${expectedId}` };
  }
  return { ok: true, report: r, id };
}

// ---------------------------------------------------------------------------
// Design rule 1. A contributor can never accept their own node.
// SPEC.md sections 9.3 and 9.4. This module holds the signing-time half and the
// collapse rule. src/policy/acceptance.ts holds the counting half.
// ---------------------------------------------------------------------------

/** Thrown at signing time, before any work is done. Exit code 4, REFUSED. */
export class SelfVerificationError extends Error {
  readonly exitCode = 4;
  constructor(readonly nodeId: string, readonly author: string) {
    super(`petri: you are the author of ${nodeId.slice(0, 8)}. You cannot verify your own node.`);
    this.name = 'SelfVerificationError';
  }
}

/**
 * Enforcement 1 of 3. `petri verify` calls this before it runs anything.
 * The author key comes from the node manifest. The runner key comes from the
 * loaded identity. Neither is read from a message body.
 */
export function assertNotSelfVerification(
  nodeId: string, authorPublicKey: string, runnerPublicKey: string,
): void {
  if (authorPublicKey === runnerPublicKey) {
    throw new SelfVerificationError(nodeId, authorPublicKey);
  }
}

/**
 * One stored report that did not count.
 *
 * `id` is the report id, so a caller can name the exact FILE that lost its vote.
 * One key can store several reports and only the first counts, so the key alone
 * does not identify the loser. `id` is null when the report does not check out,
 * because an unreadable report has no trustworthy id.
 */
export type IgnoredReport = { pub: string; id: string | null; why: string };

export type IndependentReports = {
  /** At most one report per public key, and never the author's own. */
  counted: SignedReport[];
  /** Every report that did not count, and why. */
  ignored: IgnoredReport[];
};

/**
 * Reduce a pile of stored reports to the independent verification set.
 *
 * Two rules, both from design rule 1:
 *   1. The author's own public key never counts, however many reports it signs.
 *   2. Two reports from the same public key count as ONE. The first wins.
 *
 * The signer is always `envelope.pub`, which the signature check covers.
 * `report.runner` exists for readers only, and `checkReport` asserts the two
 * are equal.
 *
 * Pass the reports in the order they were recorded. For an HCS or local log
 * that is sequence order, which makes the result deterministic everywhere.
 */
export function independentReports(
  authorPublicKey: string, reports: readonly unknown[],
): IndependentReports {
  const byKey = new Map<string, SignedReport>();
  const ignored: IgnoredReport[] = [];

  for (const value of reports) {
    const checked = checkReport(value);
    if (!checked.ok) {
      const pub = typeof (value as { pub?: unknown } | null)?.pub === 'string'
        ? (value as { pub: string }).pub
        : '(unreadable)';
      ignored.push({ pub, id: null, why: `the report did not check out: ${checked.reason}` });
      continue;
    }
    const pub = checked.report.runner;
    if (pub === authorPublicKey) {
      ignored.push({ pub, id: checked.id, why: 'self-verification: the signer is the node author' });
      continue;
    }
    if (byKey.has(pub)) {
      ignored.push({
        pub,
        id: checked.id,
        why: 'this key already verified this node. One key is one vote, so the first report wins.',
      });
      continue;
    }
    byKey.set(pub, value as SignedReport);
  }

  return { counted: [...byKey.values()], ignored };
}
