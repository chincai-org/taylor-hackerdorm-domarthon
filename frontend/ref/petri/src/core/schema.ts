/**
 * Every shared interface and every shared Zod schema. See SPEC.md section 6.
 *
 * This file is the bottom of the import graph (SPEC.md section 16.3, rule 1).
 * It imports zod and nothing else from Petri. No module declares a second copy
 * of a type that lives here.
 */
import { z } from 'zod';

/* ------------------------------------------------------------------ *
 * Primitive shapes
 * ------------------------------------------------------------------ */

/** Every id in Petri is bare lowercase hexadecimal. There is no prefix. Section 1.1. */
export const Hex64 = z.string().regex(/^[0-9a-f]{64}$/);
/** A 64-byte ed25519 signature, as hex. */
export const Hex128 = z.string().regex(/^[0-9a-f]{128}$/);
export const TreeId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
/** A parent is a node id, or the literal "root" for the first node of a tree. */
export const ParentRef = z.union([Hex64, z.literal('root')]);
/** A side of a paired report names a node id, or "root". */
export const SideRef = ParentRef;

/** The root sentinel. The only non-hex value any id field ever takes. Section 1.2. */
export const ROOT = 'root';

/** Did the harness call a real model? Section 1. */
export type Mode = 'live' | 'replay';
export const ModeSchema = z.enum(['live', 'replay']);

/** Where does the consensus log live? Section 1. */
export type Ledger = 'hcs' | 'local';
export const LedgerSchema = z.enum(['hcs', 'local']);

/** Count the escaped JSON bytes, not the characters. The wire limit is bytes. */
export const byteLen = (max: number) => (s: string) =>
  Buffer.byteLength(JSON.stringify(s), 'utf8') <= max;

/* ------------------------------------------------------------------ *
 * Areas. Section 12.1.
 *
 * The area names live here because NodeDetailSchema needs AreaSchema and
 * core sits below src/flatten/. src/flatten/areas.ts owns AREA_REGISTRY and
 * classifyAreas, and re-exports these two names.
 * ------------------------------------------------------------------ */

export const AREAS = [
  'prompt', 'retrieval', 'recovery', 'loop', 'decoding',
  'budget', 'verification', 'decomposition', 'memory', 'other',
] as const;
export type Area = (typeof AREAS)[number];
export const AreaSchema = z.enum(AREAS);

/** One file a patch touched, as the area classifier reads it. */
export interface ChangedFile {
  path: string;
  addedLines: string[];
  removedLines: string[];
}

/* ------------------------------------------------------------------ *
 * 6.1 Harness snapshot
 * ------------------------------------------------------------------ */

/** A harness snapshot maps a relative POSIX path to UTF-8 file content. */
export type HarnessSnapshot = Readonly<Record<string, string>>;

export const HarnessSnapshotSchema = z.record(
  z.string().min(1).max(512),
  z.string(),
);

/**
 * A harness snapshot as stored in the object store.
 *
 * The harness id is NOT contentId(HarnessObject). It is harnessId(object.files),
 * through the framing of section 3.4. The wrapper exists only so the file on
 * disk says what it is.
 */
export interface HarnessObject {
  protocol: 'petri/harness/1';
  files: Record<string, string>;
}
export const HarnessObjectSchema = z.strictObject({
  protocol: z.literal('petri/harness/1'),
  files: HarnessSnapshotSchema,
});

/* ------------------------------------------------------------------ *
 * 6.2 Benchmark reference
 * ------------------------------------------------------------------ */

/** One task in the benchmark. `testsId` is the content id of test.mjs. */
export interface BenchTask { id: string; testCount: number; testsId: string }

export const BenchTaskSchema = z.strictObject({
  id: z.string().regex(/^\d{2}-[a-z0-9-]+$/),
  testCount: z.int().min(1).max(1000),
  testsId: Hex64,
});

/** The benchmark spec. Its content id is the bench id. */
export interface BenchSpec {
  protocol: 'petri/bench/1';
  id: string;            // A stable human name, e.g. "petri-bench-v1".
  tasks: BenchTask[];    // Ordered by task id, ascending.
  total: number;         // tasks.length. Stored so a reader never has to count.
}
export const BenchSpecSchema = z.strictObject({
  protocol: z.literal('petri/bench/1'),
  id: z.string().min(1).max(64),
  tasks: z.array(BenchTaskSchema).min(1).max(1000),
  total: z.int().min(1).max(1000),
}).refine((s) => s.total === s.tasks.length, 'total must equal tasks.length');

/* ------------------------------------------------------------------ *
 * 6.3 NodeManifest. The hashed core of a node.
 * ------------------------------------------------------------------ */

/**
 * The node id is contentId(NodeManifest). Nothing else.
 * This object is immutable. Every field here is inside the node id.
 */
export interface NodeManifest {
  protocol: 'petri/node/1';
  tree: string;
  parent: string;      // A node id, or "root".
  author: string;      // The author ed25519 public key, Hex64.
  harness: string;     // The harness id of the snapshot this node runs.
  bench: string;       // The bench id this node is measured against.
  detail: string;      // The content id of the NodeDetail.
  hypothesis: string;  // Plain English. Design rule 4. At most 240 escaped bytes.
  nonce: string;       // Lets one author re-propose an identical node. Usually "".
}

export const NodeManifestSchema = z.strictObject({
  protocol: z.literal('petri/node/1'),
  tree: TreeId,
  parent: ParentRef,
  author: Hex64,
  harness: Hex64,
  bench: Hex64,
  detail: Hex64,
  hypothesis: z.string().min(12)
    .refine(byteLen(240), 'hypothesis is over 240 escaped bytes')
    .refine((s) => s.trim() === s && !/\s{2,}/.test(s) && !/[\r\n]/.test(s),
      'hypothesis must be one trimmed line with single spaces, so the hash is stable'),
  nonce: z.string().regex(/^([0-9a-f]{2})*$/).max(64),
});

/* ------------------------------------------------------------------ *
 * 13.2 Proposal, 13.4 Provenance and the mechanical result.
 *
 * These live here because NodeDetailSchema embeds them and core sits below
 * src/evolve/. src/evolve/schema.ts re-exports them. Defining them in evolve
 * and importing them here would make a real load-time cycle, because
 * ProvenanceSchema needs Hex64 from this file.
 * ------------------------------------------------------------------ */

export const ProposalSchema = z.strictObject({
  hypothesis: z.string().min(30).max(600),
  falsifiedIf: z.string().min(15).max(400),
  primaryArea: AreaSchema,
  motif: z.string().max(40).regex(/^[a-z0-9]+(-[a-z0-9]+){0,5}$/),
  metric: z.enum(['score', 'tokens']),
  /** Non-zero and signed. For metric 'score' the unit is basis points. */
  predictedDelta: z.int().refine((n) => n !== 0, 'predictedDelta must be non-zero'),
  reasoning: z.string().max(1200),
  whyNotUntested: z.string().max(400).nullable().default(null),
  contradicts: z.array(z.strictObject({
    nodeId: z.string(), why: z.string().max(300),
  })).max(3).default([]),
  files: z.array(z.strictObject({
    path: z.string().regex(/^harness\/[a-z0-9_-]+\.ts$/),
    contents: z.string().min(1).max(40_000),
  })).min(1).max(2),
});
export type Proposal = z.infer<typeof ProposalSchema>;

export const ProvenanceSchema = z.strictObject({
  source: z.enum(['model', 'human', 'model-via-human']),
  model: z.string().min(1).max(64),   // 'claude-sonnet-5', 'graded', or 'none'.
  promptHash: Hex64,                  // OBSERVATION. sha256 of the exact prompt sent.
  digestHash: z.string().max(16),     // OBSERVATION. Which digest the proposer read.
  seed: z.int().min(0),
});
export type Provenance = z.infer<typeof ProvenanceSchema>;

/** Who proposed the change, with which seed. Inside the node id. */
export type ProvenanceIdentity = Pick<Provenance, 'model' | 'seed' | 'source'>;
/**
 * What this machine happened to read. Display only. NEVER hashed.
 *
 * Both fields summarise the LOCAL tree. The digest covers nodes that exist on
 * this disk and in no log, and the prompt embeds that digest. A second machine
 * holds a different set of nodes, so it would compute a different id for the
 * same experiment. Section 6.4a.
 */
export type ProvenanceObservation = Pick<Provenance, 'digestHash' | 'promptHash'>;

export const MECHANICAL_CLASSES = [
  'ok', 'malformed-proposal', 'patch-out-of-bounds', 'patch-too-large',
  'sandbox-violation', 'contract-violation', 'rule-violation', 'typecheck-failed',
  // Passed every check, but replay has no recorded answers for it, so nobody could score it yet.
  'not-scored',
] as const;
export type MechanicalClass = (typeof MECHANICAL_CLASSES)[number];

export const MechanicalResultSchema = z.strictObject({
  cls: z.enum(MECHANICAL_CLASSES),
  command: z.string().max(400),   // OBSERVATION. '' when there was no command.
  exitCode: z.int(),              // OBSERVATION. 0 when cls is 'ok'.
  evidence: z.string().max(4000), // Verbatim tool output. '' when cls is 'ok'.
});
export type MechanicalResult = z.infer<typeof MechanicalResultSchema>;

/**
 * The two fields the hashed identity is built from.
 *
 * `cls` is hashed verbatim. Of `evidence`, only the ordered TypeScript
 * diagnostics survive, each with a workspace-relative path. The rest of the
 * text is observation: it carries the absolute path of the scratch workspace,
 * a fresh UUID and the tool banner. `diagnosticsOf` in src/core/ids.ts does the
 * reduction.
 */
export type MechanicalIdentitySource = Pick<MechanicalResult, 'cls' | 'evidence'>;
/**
 * The tool command line and its exit code. Display only. NEVER hashed.
 *
 * The command names an absolute tsconfig path and depends on which compiler
 * could be started, so it differs between two machines that ran one patch.
 */
export type MechanicalObservation = Pick<MechanicalResult, 'command' | 'exitCode'>;

/* ------------------------------------------------------------------ *
 * 6.4 NodeDetail. The evidence bundle.
 *
 * 6.4a IDENTITY versus OBSERVATION.
 *
 * A node id must depend ONLY on what the experiment IS. It must never depend
 * on where or when the experiment ran. Two machines that run one patch must
 * compute one node id, or no reader can recompute an id and every parent link
 * is a guess.
 *
 * Every field of a NodeDetail is therefore one of two kinds.
 *
 *   IDENTITY     It describes the experiment: the patch, the hypothesis, the
 *                mode, the parent, the pass counts, the score in basis points,
 *                the token counts. It is hashed.
 *   OBSERVATION  It describes this one execution: wall time, absolute paths,
 *                UUIDs, tool command lines, local tree state. It is stored and
 *                printed beside the identity, exactly as diff.patch is, and it
 *                is NEVER hashed.
 *
 * src/core/ids.ts owns the projection that keeps the two apart, and the guards
 * at the foot of this file fail the build when a new field is classified as
 * neither.
 * ------------------------------------------------------------------ */

/** One run the author measured. `wallMs` is OBSERVATION. The rest is IDENTITY. */
export interface ClaimedRun { passed: number; scoreBp: number; tokens: number; wallMs: number }

export const ClaimedRunSchema = z.strictObject({
  passed: z.int().min(0),
  scoreBp: z.int().min(0).max(10000),
  tokens: z.int().min(0),
  wallMs: z.int().min(0),   // OBSERVATION. Raw Date.now() arithmetic.
});

/** What the run measured. Inside the node id. */
export type ClaimedRunIdentity = Pick<ClaimedRun, 'passed' | 'scoreBp' | 'tokens'>;
/**
 * How long this one execution took. Display only. NEVER hashed.
 *
 * Wall time is the loudest leak of all: it is different on every machine and on
 * every second run of one machine.
 */
export type ClaimedRunObservation = Pick<ClaimedRun, 'wallMs'>;

/**
 * The author's own measurement and the reasoning behind the change.
 * The claimed runs NEVER count toward acceptance. They are a claim, not a vote.
 *
 * `node` is a back-reference and MUST be "" when the detail is hashed.
 * Build order: build the detail with node: "", take its content id, put that id
 * in the manifest, take the node id, then write the detail file with `node`
 * filled in. The stored file therefore does not hash to manifest.detail.
 * Use detailIdOf() from ./ids.js, which blanks the field for you.
 *
 * The stored file also carries the OBSERVATION fields of section 6.4a, which
 * detailIdOf drops. Read them with detailObservation() from ./ids.js.
 */
export interface NodeDetail {
  protocol: 'petri/detail/1';
  node: string;              // The node id, or "" while hashing.
  mode: Mode;
  proposal: Proposal;
  derivedAreas: Area[];      // From the diff classifier.
  areaMismatch: boolean;     // True when the declared area differs from the derived one.
  claimedRuns: ClaimedRun[]; // Odd length, at least 3. May be empty for a mechanical rejection.
  claimedMedianBp: number;   // medianInt over claimedRuns[].scoreBp, or 0 when empty.
  parentHarness: string;     // The parent harness id, or EMPTY_HARNESS_ID for a root.
  provenance: Provenance;
  mechanical: MechanicalResult; // 'ok', or the machine rejection that stopped the run.
}

export const NodeDetailSchema = z.strictObject({
  protocol: z.literal('petri/detail/1'),
  node: z.union([Hex64, z.literal('')]),
  mode: ModeSchema,
  proposal: ProposalSchema,
  derivedAreas: z.array(AreaSchema).min(1),
  areaMismatch: z.boolean(),
  claimedRuns: z.array(ClaimedRunSchema).max(99)
    .refine((a) => a.length === 0 || (a.length >= 3 && a.length % 2 === 1),
      'claimed run count must be 0, or odd and at least 3'),
  claimedMedianBp: z.int().min(0).max(10000),
  parentHarness: Hex64,
  provenance: ProvenanceSchema,
  mechanical: MechanicalResultSchema,
});

/**
 * Everything a stored NodeDetail carries that the node id does NOT cover.
 * Section 6.4a. `petri show` prints it. `detailObservation()` in ./ids.js
 * builds it, and the same file drops every field here before it hashes.
 */
export interface DetailObservation {
  /** The wall time of each claimed run, in run order. */
  claimedWallMs: number[];
  /** The tool command line that produced the mechanical result. */
  command: string;
  /** The exit code that command returned. */
  exitCode: number;
  /** The verbatim tool output. Only its TypeScript diagnostics reach the id. */
  evidence: string;
  /** sha256 of the exact prompt sent. The prompt embeds the local digest. */
  promptHash: string;
  /** Which digest the proposer read. It covers nodes that exist only locally. */
  digestHash: string;
}

/* ------------------------------------------------------------------ *
 * 6.5 VerificationReport. The paired measurement.
 *
 * The record shapes live here so that PetriNode below can name them without
 * core importing from src/trust/, which section 16.3 rule 1 forbids.
 * src/trust/report.ts owns buildReport, checkReport, seedFor and reportId,
 * and re-exports these names.
 * ------------------------------------------------------------------ */

export const REPORT_PROTOCOL = 'petri/verify/1';

/**
 * The four report record types are TYPE ALIASES, not interfaces.
 *
 * A report is hashed and signed, so it must satisfy `Canon`. TypeScript gives an
 * implicit index signature to an object type alias and not to an interface, so an
 * interface here would force a cast at every call to `seal` and `signingBytes`.
 */

/** One benchmark run. Every number is an integer. */
export type RunRecord = {
  passed: number;    // Tasks whose tests all passed.
  resultId: string;  // Hex64. The content id of the raw RunResult in the object store.
  scoreBp: number;   // floor(10000 * passed / total)
  seed: string;      // Hex64. seedFor(candidateNodeId, i).
  tokens: number;    // Total model tokens. 0 in replay mode.
  wallMs: number;    // Observational only. The accept rule never reads it.
};

/** One side of the paired measurement. */
export type SideSummary = {
  medianBp: number;  // medianInt over runs[].scoreBp
  node: string;      // A node id, or "root".
  runs: RunRecord[]; // In run order. Length equals report.runs.
  total: number;     // The task count. It MUST be equal on both sides.
};

/** The machine the measurement ran on. Descriptive. The accept rule never reads it. */
export type EnvDescriptor = {
  arch: string;        // process.arch
  benchId: string;     // Hex64.
  ledger: Ledger;
  mode: Mode;
  model: string;       // 'claude-sonnet-5', or 'none' in replay mode.
  nodeVersion: string; // process.version
  petriCommit: string; // The git commit of this checkout, 40 hex, or 'unknown'.
  platform: string;    // process.platform
};

export type VerificationReport = {
  protocol: 'petri/verify/1';
  tree: string;
  bench: string;         // Hex64. The bench id.
  mode: Mode;            // Inside the signature. A replay report can never pass as live.
  runner: string;        // Hex64. It MUST equal the envelope pub.
  runs: number;          // N. Odd, at least 3.
  parent: SideSummary;
  candidate: SideSummary;
  deltaMedianBp: number; // medianInt over i of (candidate.runs[i].scoreBp - parent.runs[i].scoreBp)
  seedBase: string;      // Hex64.
  startedAt: number;     // Unix milliseconds. Observational.
  env: EnvDescriptor;
};

export const RunRecordSchema = z.strictObject({
  passed: z.int().min(0), resultId: Hex64, scoreBp: z.int().min(0).max(10000),
  seed: Hex64, tokens: z.int().min(0), wallMs: z.int().min(0),
});
export const SideSummarySchema = z.strictObject({
  medianBp: z.int().min(0).max(10000), node: SideRef,
  runs: z.array(RunRecordSchema).min(3).max(99), total: z.int().min(1).max(1000),
});
export const EnvDescriptorSchema = z.strictObject({
  arch: z.string().min(1).max(32), benchId: Hex64,
  ledger: LedgerSchema, mode: ModeSchema,
  model: z.string().min(1).max(64), nodeVersion: z.string().min(1).max(32),
  petriCommit: z.union([z.string().regex(/^[0-9a-f]{40}$/), z.literal('unknown')]),
  platform: z.string().min(1).max(32),
});
export const VerificationReportSchema = z.strictObject({
  protocol: z.literal(REPORT_PROTOCOL), tree: TreeId, bench: Hex64, mode: ModeSchema,
  runner: Hex64, runs: z.int().min(3).max(99),
  parent: SideSummarySchema, candidate: SideSummarySchema,
  deltaMedianBp: z.int().min(-10000).max(10000), seedBase: Hex64,
  startedAt: z.int().min(0), env: EnvDescriptorSchema,
});

/**
 * A sealed envelope, structurally. src/trust/envelope.ts owns SignedEnvelope<B>,
 * seal() and openEnvelope(). The two shapes are identical, so a SignedEnvelope
 * assigns to this type and back.
 *
 * The key order after sorting is body, pub, sig, ver. That is the wire order.
 */
export interface SealedEnvelope<B> {
  body: B;
  pub: string;   // Hex64. The signer public key.
  sig: string;   // 128 hex. The 64-byte signature.
  ver: 1;
}

export type SignedReport = SealedEnvelope<VerificationReport>;

/* ------------------------------------------------------------------ *
 * 6.6 Median and score
 * ------------------------------------------------------------------ */

/** Median of an odd-length integer list. An even length is a protocol error. */
export function medianInt(xs: readonly number[]): number {
  if (xs.length === 0) throw new Error('median of an empty list');
  if (xs.length % 2 === 0) throw new Error(`run count must be odd, got ${xs.length}`);
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[(sorted.length - 1) / 2]!;
}

export function scoreBp(passed: number, total: number): number {
  if (!Number.isInteger(passed) || !Number.isInteger(total)
      || total <= 0 || passed < 0 || passed > total) {
    throw new Error(`bad score inputs passed=${passed} total=${total}`);
  }
  return Math.floor((10000 * passed) / total);
}

/** max minus min. The spread guard of section 4.2 reads this. */
export function spreadOf(xs: readonly number[]): number {
  if (xs.length === 0) throw new Error('spread of an empty list');
  return Math.max(...xs) - Math.min(...xs);
}

/* ------------------------------------------------------------------ *
 * 9.2 The decision code, and 6.10 the materialised view
 * ------------------------------------------------------------------ */

export type NodeStatus =
  | 'pending' | 'accepted' | 'rejected' | 'contested' | 'withdrawn' | 'superseded';

export const NODE_STATUSES: readonly NodeStatus[] = [
  'pending', 'accepted', 'rejected', 'contested', 'withdrawn', 'superseded',
];
export const NodeStatusSchema = z.enum([
  'pending', 'accepted', 'rejected', 'contested', 'withdrawn', 'superseded',
]);

/**
 * The machine-readable outcome of the acceptance rule.
 * src/policy/acceptance.ts owns `evaluate` and re-exports this name.
 */
export type DecisionCode =
  | 'ROOT_BASELINE' | 'WIN'
  | 'REGRESSION' | 'WITHIN_NOISE'
  | 'INSUFFICIENT_VERIFICATIONS' | 'RUNS_TOO_NOISY' | 'RUNNERS_DISAGREE'
  | 'CONTESTED' | 'NOT_CLEAN'
  | 'WITHDRAWN' | 'SUPERSEDED';

/**
 * What the CLI and the agent read. It is NEVER stored. It is rebuilt on load.
 * Status is derived from the evidence every time, so a stale cache can never
 * contradict the evidence.
 */
export interface PetriNode {
  id: string;
  manifest: NodeManifest;
  detail: NodeDetail;
  /** Unified diff against the parent snapshot. Display only. NEVER hashed. */
  diff: string;
  verifications: SignedReport[];
  status: NodeStatus;
  statusCode: DecisionCode;
  statusReason: string;         // Plain English. Safe to print to a terminal.
  verifiedDeltaBp: number | null;
  disputed: boolean;            // A StatusChanged claim disagreed with the computed status.
  mode: Mode;
  trust: 'hcs' | 'local-unverified';
  seq: number;                  // The log sequence number of its NodeSubmitted.
  consensusNanos: string;
}

/* ------------------------------------------------------------------ *
 * 6.11 The compile-time drift guard.
 * These fail the build when an interface and its Zod schema drift apart.
 * ------------------------------------------------------------------ */

type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const _manifest: Exact<NodeManifest, z.infer<typeof NodeManifestSchema>> = true;
const _detail: Exact<NodeDetail, z.infer<typeof NodeDetailSchema>> = true;
const _report: Exact<VerificationReport, z.infer<typeof VerificationReportSchema>> = true;
const _bench: Exact<BenchSpec, z.infer<typeof BenchSpecSchema>> = true;
const _harness: Exact<HarnessObject, z.infer<typeof HarnessObjectSchema>> = true;
const _claimed: Exact<ClaimedRun, z.infer<typeof ClaimedRunSchema>> = true;
const _runRecord: Exact<RunRecord, z.infer<typeof RunRecordSchema>> = true;
const _side: Exact<SideSummary, z.infer<typeof SideSummarySchema>> = true;
const _env: Exact<EnvDescriptor, z.infer<typeof EnvDescriptorSchema>> = true;
const _task: Exact<BenchTask, z.infer<typeof BenchTaskSchema>> = true;

/**
 * The identity-versus-observation guards of section 6.4a.
 *
 * Each one fails the build when a field of the record is in neither half. A new
 * field must therefore be classified before it can be added, and it can never
 * enter a node id by accident.
 */
const _claimedSplit: Exact<ClaimedRun, ClaimedRunIdentity & ClaimedRunObservation> = true;
const _provenanceSplit: Exact<Provenance, ProvenanceIdentity & ProvenanceObservation> = true;
const _mechanicalSplit: Exact<MechanicalResult, MechanicalIdentitySource & MechanicalObservation> = true;

/** Exported so the guards are not dead code that a bundler can drop. */
export const SCHEMA_DRIFT_GUARDS = [
  _manifest, _detail, _report, _bench, _harness,
  _claimed, _runRecord, _side, _env, _task,
  _claimedSplit, _provenanceSplit, _mechanicalSplit,
] as const;
