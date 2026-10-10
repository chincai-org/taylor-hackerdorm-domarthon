/**
 * `runCandidate()` — the ONLY function that writes a node. SPEC.md §13.7.
 *
 * `evolve` builds the `Proposal` by asking a model. `submit` builds it from flags
 * and from files a human edited. From the guards onward the two paths are the same
 * code, so a human faces the same rules as a model.
 *
 * The loop never throws away a record:
 *   - a proposal that will not parse  -> a node with `mechanical.cls = malformed-proposal`
 *   - a patch that breaks a rule      -> a node with the guard class and its reason
 *   - a patch that does not compile   -> a node carrying the verbatim tsc output
 * Each of those writes a node, publishes it, and exits 0. SPEC.md §13.5.
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { contentId, sha256Hex, type Canon } from '../core/canonical.js';
import { EMPTY_HARNESS_ID, detailToCanon, harnessId } from '../core/ids.js';
import { notFoundError, usageError } from '../core/errors.js';
import {
  medianInt,
  type ClaimedRun,
  type EnvDescriptor,
  type HarnessSnapshot,
  type Mode,
  type NodeDetail,
  type NodeManifest,
  type PetriNode,
} from '../core/schema.js';
import { loadConfig, type PetriConfig } from '../config.js';
import { REPO_ROOT } from '../core/root.js';
import { loadIdentity, type Identity } from '../trust/identity.js';
import { seal, type SignedEnvelope } from '../trust/envelope.js';
import { openLog, type ConsensusLog } from '../consensus/log.js';
import type { NodeSubmitted } from '../consensus/messages.js';
import { evaluate, type NodeFacts } from '../policy/acceptance.js';
import { PetriStore } from '../store/store.js';
import { readSnapshot } from '../store/snapshot.js';
import { configPath, identityPath } from '../store/paths.js';
import { writeJsonFile } from '../store/json.js';
import { classifyAreas, type Area } from '../flatten/areas.js';
import { buildDigest, type Digest } from '../flatten/digest.js';
import { renderDigest } from '../flatten/render.js';
import { medianOf, type MedianResult } from '../../bench/src/median.js';
import { loadSolve, runOnce } from '../../bench/src/runner.js';
import type { RunResult } from '../../bench/src/schema.js';
import { ModelPool } from '../model/client.js';
import { FixtureMissingError } from '../model/replay.js';
import type { ModelClient } from '../../harness/contract.js';

import { changedFiles, changedLineCount, unifiedDiff } from './diff.js';
import { runGuards, type DigestFacts } from './guards.js';
import {
  buildProposalPrompt,
  hypothesisProblems,
  NO_PROMPT_HASH,
  type BuiltPrompt,
} from './prompt.js';
import { propose } from './propose.js';
import {
  clipEvidence,
  MECHANICAL_OK,
  mechanicalFailure,
  ProposalSchema,
  type MechanicalResult,
  type Proposal,
  type Provenance,
} from './schema.js';
import { typecheckScratch } from './typecheck.js';

export { REPO_ROOT };
export const PETRI_DIR = `${REPO_ROOT}/.petri`;
export const SCRATCH_ROOT = `${PETRI_DIR}/scratch`;
/** Every harness path in a snapshot starts with this. */
export const HARNESS_PREFIX = 'harness/';

// ---------------------------------------------------------------------------
// Ports. Every API this module needs from a module it does not own sits here.
// ---------------------------------------------------------------------------

/** Everything `runCandidate` hands the store when it writes a node. */
export interface WriteNodeArgs {
  readonly nodeId: string;
  readonly manifest: NodeManifest;
  /** `manifest.detail`. The stored file lives at this content id. */
  readonly detailId: string;
  /** The detail with its `node` back-reference filled in. SPEC.md §6.4. */
  readonly detail: NodeDetail;
  /** The exact canonical value: `node` filled, a null `whyNotUntested` dropped. */
  readonly detailCanon: Canon;
  /** Display only. Never hashed. */
  readonly diff: string;
  /** The sealed `NodeSubmitted`, byte-identical to the one published. */
  readonly envelope: SignedEnvelope<NodeSubmitted>;
  /** The harness snapshot this node runs. Stored as a `HarnessObject`. */
  readonly harness: HarnessSnapshot;
}

export interface StorePort {
  readManifest(nodeId: string): NodeManifest;
  readHarness(harnessId: string): HarnessSnapshot;
  writeNode(args: WriteNodeArgs): void;
}

export interface MeasureRequest {
  /** The scratch directory that holds the candidate `harness/`. */
  readonly harnessDir: string;
  readonly harnessId: string;
  /**
   * The lineage label written into each `RunResult.node`.
   * The candidate node id cannot be known here: it commits to the claimed runs.
   * The parent id is used instead. `RunResult.harness` identifies what ran.
   */
  readonly node: string;
  readonly benchId: string;
  readonly mode: Mode;
  readonly repeats: number;
  readonly seeds: readonly string[];
  readonly allowGraded: boolean;
}

export interface MeasureResult {
  readonly median: MedianResult;
  /** One entry per clean run, in attempt order. */
  readonly runs: readonly RunResult[];
}

export interface EvolveDeps {
  repoRoot: string;
  config: PetriConfig;
  identity: Identity;
  store: StorePort;
  digest: Digest;
  openConsensusLog(config: PetriConfig, identity: Identity, root?: string): ConsensusLog;
  readDirSnapshot(dir: string): HarnessSnapshot;
  measure(request: MeasureRequest): Promise<MeasureResult>;
  /** A failure the caller already decided, such as a proposal that would not parse. */
  priorMechanical: MechanicalResult | null;
  allowGraded: boolean;
  now(): number;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Snapshot content is UTF-8 with no carriage return. SPEC.md §3.2. */
export function normalizeContents(text: string): string {
  const body = text.replace(/\r\n?/g, '\n');
  return body.endsWith('\n') || body === '' ? body : `${body}\n`;
}

/** Re-key a directory snapshot so every path carries the `harness/` prefix. */
export function prefixSnapshot(snapshot: HarnessSnapshot, prefix: string): HarnessSnapshot {
  const out: Record<string, string> = {};
  for (const [path, contents] of Object.entries(snapshot)) {
    out[path.startsWith(prefix) ? path : `${prefix}${path}`] = contents;
  }
  return out;
}

/**
 * The manifest hypothesis. One trimmed line, single spaces, at most 240 escaped
 * bytes. SPEC.md §6.3. The full text, up to 600 characters, stays in the proposal.
 */
export function manifestHypothesis(raw: string): string {
  const fits = (v: string): boolean => Buffer.byteLength(JSON.stringify(v), 'utf8') <= 240;
  let s = raw.replace(/\s+/g, ' ').trim();
  if (s.length < 12) s = `${s} — no hypothesis was supplied`.trim();
  if (fits(s)) return s;
  let cut = s;
  while (cut.length > 1 && !fits(`${cut.trimEnd()}…`)) cut = cut.slice(0, -1);
  return `${cut.trimEnd()}…`;
}

/**
 * The exact canonical value of a detail. SPEC.md §13.2.
 *
 * The rule lives in `src/core/ids.ts`, which owns every id maker. Re-exported here
 * because this module's callers already import it from this path. A second copy
 * that listed the fields by hand would silently drop any field added later, and the
 * two copies would then hash one detail to two ids.
 */
export { detailToCanon };

/** The seeds of the author's own claimed runs. They are a claim, not a vote. */
export function claimedSeeds(harness: string, seed: number, repeats: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < repeats; i++) {
    out.push(sha256Hex(`petri/evolve/seed/1|${harness}|${seed}|${i}`));
  }
  return out;
}

/** What the digest forbids. Both lists drive the `rule-violation` guard. */
export function digestFacts(digest: Digest): DigestFacts {
  return {
    saturatedAreas: digest.areas.filter((a) => a.verdict === 'SATURATED').map((a) => a.area),
    exhaustedMotifs: digest.exhaustedMotifs.map((m) => m.motif),
  };
}

function writeWorkspace(workspace: string, snapshot: HarnessSnapshot): void {
  for (const [path, contents] of Object.entries(snapshot)) {
    const file = join(workspace, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, contents, 'utf8');
  }
}

/** Read a scratch `harness/` directory back into a prefixed snapshot. */
function readWorkspaceHarness(workspace: string, deps: EvolveDeps): HarnessSnapshot {
  return prefixSnapshot(deps.readDirSnapshot(join(workspace, 'harness')), HARNESS_PREFIX);
}

// ---------------------------------------------------------------------------
// runCandidate
// ---------------------------------------------------------------------------

export interface CandidateInput {
  parentId: string;
  proposal: Proposal;
  provenance: Provenance;
  runs: number;
  seed: number;
  mode: Mode;
}

/** What `runCandidate` produced, beside the node itself. */
export interface CandidateOutcome {
  readonly node: PetriNode;
  readonly workspace: string;
  readonly runId: string;
  readonly mechanical: MechanicalResult;
  readonly median: MedianResult | null;
}

/**
 * Build, guard, typecheck, measure and write one candidate node.
 * It returns a node whose computed status is `pending`, even when the measured
 * delta is negative. Two independent verifications decide the outcome, never this.
 */
export async function runCandidate(
  input: CandidateInput,
  overrides: Partial<EvolveDeps> = {},
): Promise<PetriNode> {
  return (await runCandidateDetailed(input, overrides)).node;
}

export async function runCandidateDetailed(
  input: CandidateInput,
  overrides: Partial<EvolveDeps> = {},
): Promise<CandidateOutcome> {
  if (!Number.isInteger(input.runs) || input.runs < 1) {
    throw usageError(`petri: --runs must be a positive integer, got ${input.runs}`);
  }
  if (input.runs % 2 === 0) {
    throw usageError(`petri: --runs must be odd, got ${input.runs}. An even count has no unique median.`);
  }

  const deps = resolveDeps(overrides);
  const runId = randomUUID();
  const workspace = join(deps.repoRoot, '.petri', 'scratch', runId);

  // 1. The base the patch applies to.
  const base = loadBaseSnapshot(input.parentId, deps);
  const parentHarnessId = input.parentId === 'root' ? EMPTY_HARNESS_ID : harnessId(base);

  // 2. Apply the patch. A path outside `harness/` is never written to the tree,
  //    but its full contents stay in `detail.proposal.files`, so nothing is lost.
  const candidate: Record<string, string> = { ...base };
  for (const f of input.proposal.files) {
    if (!f.path.startsWith(HARNESS_PREFIX) || f.path.includes('..')) continue;
    if (f.path === 'harness/contract.ts') continue;
    candidate[f.path] = normalizeContents(f.contents);
  }

  writeWorkspace(workspace, candidate);
  writeJsonFile(join(workspace, 'proposal.json'), {
    parent: input.parentId,
    mode: input.mode,
    runs: input.runs,
    seed: input.seed,
    proposal: input.proposal,
    provenance: input.provenance,
  });

  // 3. The diff, the changed lines and the derived areas.
  const diff = unifiedDiff(base, candidate);
  const changed = changedFiles(base, candidate);
  const changedLines = changedLineCount(base, candidate);
  const classified = classifyAreas(changed);
  const derivedAreas: Area[] = classified.areas.length > 0
    ? classified.areas
    : [input.proposal.primaryArea];
  const areaMismatch = !derivedAreas.includes(input.proposal.primaryArea);

  // 4. The guards, then the typecheck. The first failure wins.
  let mechanical: MechanicalResult = deps.priorMechanical ?? MECHANICAL_OK;

  if (mechanical.cls === 'ok') {
    const failure = runGuards({
      proposal: input.proposal,
      changedLines,
      facts: digestFacts(deps.digest),
    });
    if (failure !== null) mechanical = mechanicalFailure(failure.cls, failure.message);
  }

  if (mechanical.cls === 'ok') {
    const tc = typecheckScratch({ workspace, repoRoot: deps.repoRoot });
    if (!tc.ok) {
      mechanical = {
        cls: 'typecheck-failed',
        command: tc.command.slice(0, 400),
        exitCode: tc.exitCode,
        evidence: clipEvidence(tc.output === '' ? 'tsc failed with no output' : tc.output),
      };
    }
  }

  const candidateHarnessId = harnessId(candidate);

  // 5. Measure, but only when the patch actually ran.
  let claimedRuns: ClaimedRun[] = [];
  let claimedMedianBp = 0;
  let median: MedianResult | null = null;

  if (mechanical.cls === 'ok') {
    let result: MeasureResult | null = null;
    try {
      result = await deps.measure({
        harnessDir: join(workspace, 'harness'),
        harnessId: candidateHarnessId,
        node: input.parentId,
        benchId: deps.config.bench.id,
        mode: input.mode,
        repeats: input.runs,
        seeds: claimedSeeds(candidateHarnessId, input.seed, input.runs),
        allowGraded: deps.allowGraded,
      });
    } catch (err) {
      // Replay holds recorded answers for known harness versions only. A new version
      // passed every check but cannot be scored here, so record it unscored instead
      // of dropping the experiment. It stays pending and can be scored live later.
      if (!(err instanceof FixtureMissingError)) throw err;
      mechanical = mechanicalFailure(
        'not-scored',
        'Replay has no recorded answers for this harness, so nobody could score it yet.\n'
          + 'Score it live with --mode live and ANTHROPIC_API_KEY.\n\n'
          + err.message,
      );
    }
    if (result !== null) {
      median = result.median;
      const runs = result.runs.map<ClaimedRun>((r) => ({
        passed: r.passed, scoreBp: r.scoreBp, tokens: r.tokens, wallMs: r.wallMs,
      }));
      // A short or even batch cannot carry a median. It is recorded as no claim at all.
      if (runs.length >= 3 && runs.length % 2 === 1) {
        claimedRuns = runs;
        claimedMedianBp = medianInt(runs.map((r) => r.scoreBp));
      }
    }
  }

  // 6. The detail, hashed with an empty `node` back-reference. SPEC.md §6.4.
  const detail: NodeDetail = {
    protocol: 'petri/detail/1',
    node: '',
    mode: input.mode,
    proposal: input.proposal,
    derivedAreas,
    areaMismatch,
    claimedRuns,
    claimedMedianBp,
    parentHarness: parentHarnessId,
    provenance: input.provenance,
    mechanical,
  };
  const detailId = contentId(detailToCanon(detail));

  // 7. The manifest. Its content id is the node id.
  const hypothesis = manifestHypothesis(input.proposal.hypothesis);
  const manifest: NodeManifest = {
    protocol: 'petri/node/1',
    tree: deps.config.treeId,
    parent: input.parentId,
    author: deps.identity.publicKeyHex,
    harness: candidateHarnessId,
    bench: deps.config.bench.id,
    detail: detailId,
    hypothesis,
    nonce: '',
  };
  const nodeId = contentId({ ...manifest });

  const stored: NodeDetail = { ...detail, node: nodeId };
  const body: NodeSubmitted = {
    bench: deps.config.bench.id,
    hyp: hypothesis,
    node: nodeId,
    parent: input.parentId,
    tree: deps.config.treeId,
    type: 'NodeSubmitted',
  };
  const envelope = seal<NodeSubmitted>('msg', body, deps.identity);

  // 8. Write first, publish second. A publish that fails leaves a node on disk
  //    that `petri publish <id>` can send again.
  deps.store.writeNode({
    nodeId,
    manifest,
    detailId,
    detail: stored,
    detailCanon: detailToCanon(stored),
    diff,
    envelope,
    harness: candidate,
  });

  const log = deps.openConsensusLog(deps.config, deps.identity, deps.repoRoot);
  let seq = 0;
  try {
    const receipt = await log.publish(body);
    seq = receipt.seq;
  } finally {
    await log.close();
  }

  // 9. The materialised view. Status is derived, never stored. SPEC.md §6.10.
  const facts: NodeFacts = {
    nodeId,
    author: deps.identity.publicKeyHex,
    bench: deps.config.bench.id,
    mode: input.mode,
    parent: input.parentId,
    verifications: new Map(),
    withdrawn: false,
    superseded: false,
  };
  const verdict = evaluate(facts, deps.config.policy);

  const node: PetriNode = {
    id: nodeId,
    manifest,
    detail: stored,
    diff,
    verifications: [],
    status: verdict.status,
    statusCode: verdict.code,
    statusReason: verdict.reason,
    verifiedDeltaBp: verdict.deltaBp,
    disputed: false,
    mode: input.mode,
    trust: deps.config.ledger === 'hcs' ? 'hcs' : 'local-unverified',
    seq,
    consensusNanos: String(BigInt(deps.now()) * 1_000_000n).padStart(19, '0'),
  };

  return { node, workspace, runId, mechanical, median };
}

// ---------------------------------------------------------------------------
// The model path: petri evolve
// ---------------------------------------------------------------------------

export interface EvolveOptions {
  /** Defaults to the digest head, or 'root' when the tree is empty. */
  readonly parentId?: string | undefined;
  readonly runs?: number | undefined;
  readonly seed?: number | undefined;
  readonly mode?: Mode | undefined;
  /** Print the prompt and stop. SPEC.md §13.1 step 3. */
  readonly dryRun?: boolean | undefined;
  readonly forceArea?: Area | undefined;
  /** `--proposal reply.json`. Skips the model call. Provenance becomes model-via-human. */
  readonly proposalFile?: string | undefined;
  /** Required unless `dryRun` or `proposalFile` is set. The caller picks live or graded. */
  readonly model?: ModelClient | undefined;
  /** The model name recorded in provenance. */
  readonly modelName?: string | undefined;
  readonly maxTokens?: number | undefined;
  readonly digestMaxTokens?: number | undefined;
  readonly allowGraded?: boolean | undefined;
  readonly deps?: Partial<EvolveDeps> | undefined;
}

export type EvolveOutcome =
  | { readonly kind: 'dry-run'; readonly prompt: BuiltPrompt; readonly digestText: string }
  | ({ readonly kind: 'node' } & CandidateOutcome);

/**
 * The loop of SPEC.md §13.1.
 * Every failure below step 6 still produces a node, so the tree records the attempt.
 */
export async function runEvolve(options: EvolveOptions = {}): Promise<EvolveOutcome> {
  const deps = resolveDeps(options.deps ?? {});
  const digest = deps.digest;
  const digestText = renderDigest(digest, options.digestMaxTokens ?? 6000);

  const parentId = options.parentId ?? (digest.head.nodeId !== '' ? digest.head.nodeId : 'root');
  const mode = options.mode ?? deps.config.mode;
  const runs = options.runs ?? deps.config.runsPerVerification;
  const seed = options.seed ?? 7;

  const parentHarness = loadBaseSnapshot(parentId, deps);
  const prompt = buildProposalPrompt({
    digestText,
    digest,
    parentHarness,
    parentId,
    forceArea: options.forceArea,
    minDeltaBp: deps.config.policy.minDeltaBp,
  });

  if (options.dryRun === true) return { kind: 'dry-run', prompt, digestText };

  let proposal: Proposal | null = null;
  let priorMechanical: MechanicalResult | null = null;
  let source: Provenance['source'] = 'model';
  let modelName = options.modelName ?? (mode === 'replay' ? 'graded' : 'claude-sonnet-5');
  let promptHash = prompt.promptHash;

  if (options.proposalFile !== undefined) {
    source = 'model-via-human';
    modelName = options.modelName ?? 'none';
    const read = readProposalFile(options.proposalFile);
    if (read.ok) proposal = read.proposal;
    else priorMechanical = mechanicalFailure('malformed-proposal', read.evidence);
  } else {
    if (options.model === undefined) {
      throw usageError('petri: evolve needs a model client. Pass --dry-run or --proposal <file>.');
    }
    const outcome = await propose({
      model: options.model,
      prompt,
      maxTokens: options.maxTokens,
    });
    if (outcome.ok) proposal = outcome.proposal;
    else priorMechanical = mechanicalFailure('malformed-proposal', outcome.evidence);
  }

  if (proposal === null) {
    proposal = fallbackProposal(parentHarness, options.forceArea ?? 'other', priorMechanical);
  }

  const provenance: Provenance = {
    source,
    model: modelName,
    promptHash,
    digestHash: digest.digestHash,
    seed,
  };

  const outcome = await runCandidateDetailed(
    { parentId, proposal, provenance, runs, seed, mode },
    { ...(options.deps ?? {}), ...depsSnapshot(deps), priorMechanical },
  );
  return { kind: 'node', ...outcome };
}

/** Read and validate a proposal a human saved from a chat interface. */
export function readProposalFile(
  path: string,
): { ok: true; proposal: Proposal } | { ok: false; evidence: string } {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw notFoundError(`petri: cannot read ${path}: ${(err as Error).message}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    return { ok: false, evidence: `${path} is not JSON: ${(err as Error).message}\n\n${text}` };
  }
  const parsed = ProposalSchema.safeParse(value);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((i) => `  - ${i.path.length > 0 ? i.path.join('.') : '(root)'}: ${i.message}`)
      .join('\n');
    return { ok: false, evidence: `${path} does not match ProposalSchema:\n${problems}` };
  }
  const vague = hypothesisProblems(parsed.data.hypothesis, parsed.data.falsifiedIf);
  if (vague.length > 0) {
    return {
      ok: false,
      evidence: `${path} carries a hypothesis that nothing can falsify:\n`
        + vague.map((p) => `  - ${p}`).join('\n'),
    };
  }
  return { ok: true, proposal: parsed.data };
}

/**
 * The record written when no usable proposal exists.
 * It changes nothing, so the node ships the parent harness and the mechanical
 * class says why it was never measured.
 */
export function fallbackProposal(
  parentHarness: HarnessSnapshot,
  area: Area,
  mechanical: MechanicalResult | null,
): Proposal {
  const paths = Object.keys(parentHarness).sort();
  const pick = paths.includes('harness/index.ts')
    ? 'harness/index.ts'
    : paths.find((p) => p !== 'harness/contract.ts');
  const file = pick !== undefined
    ? { path: pick, contents: parentHarness[pick] ?? '// unreadable\n' }
    : { path: 'harness/index.ts', contents: '// the proposal could not be parsed. No change was applied.\n' };

  return {
    hypothesis: 'The proposal could not be parsed, so no change was applied and nothing was measured.',
    falsifiedIf: 'Nothing was measured. There is no number that could refute this node.',
    primaryArea: area,
    motif: 'malformed-proposal',
    metric: 'score',
    predictedDelta: 1,
    reasoning: mechanical === null
      ? 'No proposal was produced.'
      : `The proposer failed with ${mechanical.cls}. The verbatim reply is in mechanical.evidence.`,
    whyNotUntested: null,
    contradicts: [],
    files: [file],
  };
}

// ---------------------------------------------------------------------------
// The human path: petri propose, petri submit
// ---------------------------------------------------------------------------

export interface PrepareWorkspaceOptions {
  readonly parentId?: string | undefined;
  readonly area: Area;
  readonly motif: string;
  readonly hypothesis: string;
  readonly falsifiedIf: string;
  readonly metric: 'score' | 'tokens';
  readonly predictedDelta: number;
  readonly reasoning?: string | undefined;
  readonly deps?: Partial<EvolveDeps> | undefined;
}

export interface WorkspaceInfo {
  readonly runId: string;
  readonly workspace: string;
  readonly harnessDir: string;
  readonly parentId: string;
  readonly files: string[];
}

/**
 * `petri propose` — copy the parent harness into a scratch workspace and write
 * the metadata beside it. It runs nothing. A human edits the TypeScript with any
 * editor, then calls `submitWorkspace`.
 */
export function prepareWorkspace(options: PrepareWorkspaceOptions): WorkspaceInfo {
  const deps = resolveDeps(options.deps ?? {});
  const parentId = options.parentId
    ?? (deps.digest.head.nodeId !== '' ? deps.digest.head.nodeId : 'root');
  const base = loadBaseSnapshot(parentId, deps);

  const runId = randomUUID();
  const workspace = join(deps.repoRoot, '.petri', 'scratch', runId);
  writeWorkspace(workspace, base);

  writeJsonFile(join(workspace, 'proposal.json'), {
    parent: parentId,
    hypothesis: options.hypothesis,
    falsifiedIf: options.falsifiedIf,
    primaryArea: options.area,
    motif: options.motif,
    metric: options.metric,
    predictedDelta: options.predictedDelta,
    reasoning: options.reasoning ?? '',
    whyNotUntested: null,
    contradicts: [],
  });

  return {
    runId,
    workspace,
    harnessDir: join(workspace, 'harness'),
    parentId,
    files: Object.keys(base).sort(),
  };
}

export interface SubmitOptions {
  /** The workspace `petri propose` printed, or any directory holding `harness/`. */
  readonly workspace: string;
  readonly parentId?: string | undefined;
  readonly runs?: number | undefined;
  readonly seed?: number | undefined;
  readonly mode?: Mode | undefined;
  /** Command-line overrides. Each one wins over `proposal.json`. */
  readonly hypothesis?: string | undefined;
  readonly falsifiedIf?: string | undefined;
  readonly area?: Area | undefined;
  readonly motif?: string | undefined;
  readonly metric?: 'score' | 'tokens' | undefined;
  readonly predictedDelta?: number | undefined;
  readonly reasoning?: string | undefined;
  readonly whyNotUntested?: string | null | undefined;
  readonly contradicts?: readonly { nodeId: string; why: string }[] | undefined;
  readonly allowGraded?: boolean | undefined;
  readonly deps?: Partial<EvolveDeps> | undefined;
}

interface WorkspaceMeta {
  parent?: string;
  hypothesis?: string;
  falsifiedIf?: string;
  primaryArea?: string;
  motif?: string;
  metric?: string;
  predictedDelta?: number;
  reasoning?: string;
  whyNotUntested?: string | null;
  contradicts?: { nodeId: string; why: string }[];
}

function readWorkspaceMeta(workspace: string): WorkspaceMeta {
  try {
    const raw = readFileSync(join(workspace, 'proposal.json'), 'utf8');
    const value = JSON.parse(raw) as WorkspaceMeta & { proposal?: WorkspaceMeta };
    // `runCandidate` writes a nested `proposal` key. `prepareWorkspace` writes a flat one.
    if (value.proposal === undefined) return value;
    // An absent parent stays absent. `{ parent: undefined }` is not the same shape,
    // and `exactOptionalPropertyTypes` is on so that the two cannot be confused.
    const parent = value.parent ?? value.proposal.parent;
    return parent === undefined ? { ...value.proposal } : { ...value.proposal, parent };
  } catch {
    return {};
  }
}

/**
 * `petri submit` — take an already-edited harness directory and package it into a
 * candidate node. The hypothesis may come from the command line or from
 * `proposal.json`. Everything after this point is the same code the model path runs.
 */
export async function submitWorkspace(options: SubmitOptions): Promise<CandidateOutcome> {
  const deps = resolveDeps(options.deps ?? {});
  const meta = readWorkspaceMeta(options.workspace);

  const harnessDir = join(options.workspace, 'harness');
  if (!isDirectory(harnessDir)) {
    throw notFoundError(`petri: ${harnessDir} does not exist. Run \`petri propose\` first.`);
  }

  const parentId = options.parentId ?? meta.parent ?? 'root';
  const base = loadBaseSnapshot(parentId, deps);
  const edited = readWorkspaceHarness(options.workspace, deps);

  const changed = changedFiles(base, edited);
  if (changed.length === 0) {
    throw usageError(
      `petri: no file under ${harnessDir} differs from the parent harness. There is nothing to measure.`,
    );
  }

  const hypothesis = options.hypothesis ?? meta.hypothesis ?? '';
  const falsifiedIf = options.falsifiedIf ?? meta.falsifiedIf ?? '';
  const vague = hypothesisProblems(hypothesis, falsifiedIf);
  if (vague.length > 0) {
    throw usageError(
      `petri: the hypothesis is not falsifiable, so the node would teach nobody anything.\n`
      + vague.map((p) => `  - ${p}`).join('\n')
      + '\nPass --hypothesis "Because <fact>, <change> will raise the median by at least <N>bp."',
    );
  }

  const files = changed
    .filter((c) => edited[c.path] !== undefined)
    .map((c) => ({ path: c.path, contents: edited[c.path]! }));

  // More than two changed files cannot fit a proposal. Keep the first two so the
  // record exists, and let the guard record the real reason.
  const kept = files.slice(0, 2);
  let priorMechanical: MechanicalResult | null = null;
  if (files.length > 2 || kept.length === 0) {
    priorMechanical = mechanicalFailure(
      'patch-too-large',
      `${changed.length} files changed. The limit is 2.\n`
      + changed.map((c) => `  ${c.path}  +${c.addedLines.length} -${c.removedLines.length}`).join('\n'),
    );
  }

  const proposal: Proposal = {
    hypothesis,
    falsifiedIf,
    primaryArea: options.area ?? asArea(meta.primaryArea) ?? 'other',
    motif: options.motif ?? (typeof meta.motif === 'string' ? meta.motif : 'human-edit'),
    metric: options.metric ?? (meta.metric === 'tokens' ? 'tokens' : 'score'),
    predictedDelta: options.predictedDelta ?? meta.predictedDelta ?? 1000,
    reasoning: options.reasoning ?? meta.reasoning ?? '',
    whyNotUntested: options.whyNotUntested ?? meta.whyNotUntested ?? null,
    contradicts: [...(options.contradicts ?? meta.contradicts ?? [])],
    files: kept.length > 0 ? kept : [{ path: 'harness/index.ts', contents: edited['harness/index.ts'] ?? '' }],
  };

  const provenance: Provenance = {
    source: 'human',
    model: 'none',
    promptHash: NO_PROMPT_HASH,
    digestHash: deps.digest.digestHash,
    seed: options.seed ?? 7,
  };

  return runCandidateDetailed(
    {
      parentId,
      proposal,
      provenance,
      runs: options.runs ?? deps.config.runsPerVerification,
      seed: options.seed ?? 7,
      mode: options.mode ?? deps.config.mode,
    },
    {
      ...(options.deps ?? {}),
      ...depsSnapshot(deps),
      priorMechanical,
      ...(options.allowGraded === undefined ? {} : { allowGraded: options.allowGraded }),
    },
  );
}

// ---------------------------------------------------------------------------
// Wiring. Every assumption about a module this file does not own lives below.
// ---------------------------------------------------------------------------

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function asArea(value: string | undefined): Area | undefined {
  if (value === undefined) return undefined;
  return AREA_SET.has(value) ? (value as Area) : undefined;
}

const AREA_SET = new Set<string>([
  'prompt', 'retrieval', 'recovery', 'loop', 'decoding',
  'budget', 'verification', 'decomposition', 'memory', 'other',
]);

/** The parent harness a patch applies to. A root patches the repo's own `harness/`. */
export function loadBaseSnapshot(parentId: string, deps: EvolveDeps): HarnessSnapshot {
  if (parentId === 'root') {
    return prefixSnapshot(deps.readDirSnapshot(join(deps.repoRoot, 'harness')), HARNESS_PREFIX);
  }
  const manifest = deps.store.readManifest(parentId);
  return deps.store.readHarness(manifest.harness);
}

/** Re-use resolved dependencies across a nested call, without rebuilding them. */
function depsSnapshot(deps: EvolveDeps): Partial<EvolveDeps> {
  return {
    repoRoot: deps.repoRoot,
    config: deps.config,
    identity: deps.identity,
    store: deps.store,
    digest: deps.digest,
    openConsensusLog: deps.openConsensusLog,
    readDirSnapshot: deps.readDirSnapshot,
    measure: deps.measure,
    allowGraded: deps.allowGraded,
    now: deps.now,
  };
}

function storePort(store: PetriStore): StorePort {
  return {
    readManifest: (nodeId: string) => store.readManifest(nodeId),
    // `PetriStore` names this read `getHarness`: it reads the object store, not a
    // node directory. The port keeps the `readHarness` name this module already uses.
    readHarness: (id: string) => store.getHarness(id),
    writeNode: (args: WriteNodeArgs) => { store.writeNode(args); },
  };
}

async function defaultMeasure(request: MeasureRequest): Promise<MeasureResult> {
  const solve = await loadSolve(request.harnessDir);
  const pool = new ModelPool({
    mode: request.mode,
    harnessId: request.harnessId,
    allowGraded: request.allowGraded,
  });
  const env: EnvDescriptor = {
    arch: process.arch,
    benchId: request.benchId,
    ledger: 'local',
    mode: request.mode,
    model: pool.effectiveModel(),
    nodeVersion: process.version,
    petriCommit: 'unknown',
    platform: process.platform,
  };

  const result = await medianOf(
    async (attemptIndex) => {
      const seed = request.seeds[attemptIndex];
      if (seed === undefined) {
        throw usageError(
          `petri: attempt ${attemptIndex} has no seed. ` +
          `${request.seeds.length} seeds were derived for ${request.repeats} runs.`,
        );
      }
      return runOnce({
        solve,
        makeContext: pool.makeContext,
        node: request.node,
        harness: request.harnessId,
        bench: request.benchId,
        mode: request.mode,
        attemptIndex,
        seed,
        env,
      });
    },
    {
      node: request.node,
      harness: request.harnessId,
      bench: request.benchId,
      mode: request.mode,
      repeats: request.repeats,
    },
  );
  return { median: result.median, runs: result.runs };
}

/**
 * The digest of an empty tree.
 *
 * `buildDigest` takes the materialised nodes, and materialising them needs the
 * consensus log, which only the CLI opens. Every caller that holds a loaded tree
 * therefore passes `digest` in the overrides. With none, this module reads an
 * empty tree: no area is saturated, no motif is exhausted, and the head is 'root'.
 */
function emptyTreeDigest(config: PetriConfig): Digest {
  return buildDigest({
    nodes: [],
    bench: config.bench.id,
    benchName: config.bench.name,
    mode: config.mode,
    ledger: config.ledger,
    taskCount: 0,
    runs: config.runsPerVerification,
    constraints: { minDeltaBp: config.policy.minDeltaBp },
  });
}

/** Fill in whatever the caller did not supply. Nothing is built twice. */
export function resolveDeps(overrides: Partial<EvolveDeps>): EvolveDeps {
  const repoRoot = overrides.repoRoot ?? REPO_ROOT;
  const config = overrides.config ?? loadConfig(configPath(repoRoot));
  const identity = overrides.identity ?? loadIdentity(identityPath(repoRoot));
  const store = overrides.store ?? storePort(new PetriStore(repoRoot));
  const digest = overrides.digest ?? emptyTreeDigest(config);
  return {
    repoRoot,
    config,
    identity,
    store,
    digest,
    openConsensusLog: overrides.openConsensusLog ?? openLog,
    readDirSnapshot: overrides.readDirSnapshot ?? readSnapshot,
    measure: overrides.measure ?? defaultMeasure,
    priorMechanical: overrides.priorMechanical ?? null,
    allowGraded: overrides.allowGraded ?? false,
    now: overrides.now ?? Date.now,
  };
}

/** Exported so a caller can list a scratch workspace without guessing its layout. */
export function listWorkspaceFiles(workspace: string): string[] {
  const harnessDir = join(workspace, 'harness');
  if (!isDirectory(harnessDir)) return [];
  return readdirSync(harnessDir).filter((f) => f.endsWith('.ts')).sort();
}
