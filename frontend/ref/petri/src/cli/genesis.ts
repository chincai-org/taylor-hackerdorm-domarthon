/**
 * Write the genesis node: the first node of a tree, whose parent is the empty
 * harness.
 *
 * A genesis node cannot go through `runCandidate()`, because a proposal carries
 * at most two changed files (§13.2) and a genesis carries the whole harness.
 *
 * The genesis node is NOT measured here. §6.4 says an author's own runs never
 * count toward acceptance, so an unmeasured genesis loses nothing. Two
 * independent `petri verify` runs produce the real numbers.
 */
import { contentId, sha256Hex, type Canon } from '../core/canonical.js';
import { EMPTY_HARNESS_ID, detailDigestInput, harnessId, nodeIdOf } from '../core/ids.js';
import type { HarnessSnapshot, NodeDetail, NodeManifest } from '../core/schema.js';
import { NodeDetailSchema, NodeManifestSchema } from '../core/schema.js';
import type { Proposal, Provenance } from '../evolve/schema.js';
import { scanHarnessSnapshot } from '../evolve/guards.js';
import { unifiedDiff } from '../evolve/diff.js';
import { classifyAreas } from '../flatten/areas.js';
import { seal } from '../trust/envelope.js';
import type { NodeSubmitted } from '../consensus/messages.js';
import type { Ctx } from './context.js';
import { EXIT, fail } from './exit.js';
import { changedFiles, readHarness } from './snapshot.js';

export const GENESIS_HYPOTHESIS =
  'Single-shot prompt. No retry. No test run. This is the honest baseline.';

export interface GenesisInput {
  harnessDir: string;
  hypothesis: string;
  /** Written into the proposal so the digest can name the genesis motif. */
  motif?: string;
}

export interface GenesisResult {
  nodeId: string;
  harnessId: string;
  files: number;
  published: boolean;
  seq: number | null;
}

export async function writeGenesis(ctx: Ctx, input: GenesisInput): Promise<GenesisResult> {
  let files: HarnessSnapshot;
  try {
    files = readHarness(input.harnessDir);
  } catch (err) {
    fail(EXIT.NOT_FOUND, `cannot read the harness at ${input.harnessDir}: ${(err as Error).message}`);
  }
  const paths = Object.keys(files);
  if (paths.length === 0) {
    fail(EXIT.NOT_FOUND, `${input.harnessDir} holds no files. A genesis node needs a harness.`);
  }

  // A genesis carries the whole harness, so nothing upstream ever scanned it, and
  // every descendant inherits what it starts with. Scan it here, completely. The
  // jail of `bench/src/harnessJail.ts` is what stops a harness from reading the
  // benchmark tests; this refuses to record a tree that starts by trying.
  const violation = scanHarnessSnapshot(files);
  if (violation !== null) {
    fail(
      EXIT.USAGE,
      `${input.harnessDir} may not be a harness: ${violation.message}\n` +
        '       SPEC.md §11.1 rule 3: a harness file imports its relative siblings ' +
        'inside harness/ and reaches nothing else.',
    );
  }

  const hid = harnessId(files);
  ctx.store.putHarness(files);

  const { areas, primaryArea } = classifyAreas(changedFiles({}, files));

  const entry = paths.find((p) => p.endsWith('index.ts')) ?? paths[0]!;
  const proposal: Proposal = {
    hypothesis: input.hypothesis,
    falsifiedIf: 'A verified median at or below 0bp over the empty harness.',
    primaryArea,
    motif: input.motif ?? 'genesis-v1',
    metric: 'score',
    predictedDelta: 1,
    reasoning:
      'The genesis node states the starting harness. It is not a change to anything, ' +
      'so it makes no claim beyond scoring above the empty harness.',
    whyNotUntested: null,
    contradicts: [],
    files: [{ path: entry, contents: files[entry]! }],
  };

  const provenance: Provenance = {
    source: 'human',
    model: 'none',
    promptHash: sha256Hex(''),
    digestHash: '',
    seed: 0,
  };

  const identity = ctx.identity();
  const detailDraft: NodeDetail = {
    protocol: 'petri/detail/1',
    node: '',
    mode: ctx.config.mode,
    proposal,
    derivedAreas: areas,
    areaMismatch: !areas.includes(primaryArea),
    claimedRuns: [],
    claimedMedianBp: 0,
    parentHarness: EMPTY_HARNESS_ID,
    provenance,
    mechanical: { cls: 'ok', command: '', exitCode: 0, evidence: '' },
  };

  // §6.4 build order: hash the detail with `node` blank, then fill it in.
  const detailId = contentId(detailDigestInput(detailDraft));

  const manifest: NodeManifest = {
    protocol: 'petri/node/1',
    tree: ctx.config.treeId,
    parent: 'root',
    author: identity.runnerId,
    harness: hid,
    bench: ctx.config.bench.id,
    detail: detailId,
    hypothesis: input.hypothesis,
    nonce: '',
  };
  const parsedManifest = NodeManifestSchema.safeParse(manifest);
  if (!parsedManifest.success) {
    fail(EXIT.USAGE, `the genesis manifest is invalid: ${parsedManifest.error.message}`);
  }

  const nodeId = nodeIdOf(manifest);
  const detail: NodeDetail = { ...detailDraft, node: nodeId };
  const parsedDetail = NodeDetailSchema.safeParse(detail);
  if (!parsedDetail.success) {
    fail(EXIT.USAGE, `the genesis detail is invalid: ${parsedDetail.error.message}`);
  }

  const body: NodeSubmitted = {
    bench: manifest.bench,
    hyp: manifest.hypothesis,
    node: nodeId,
    parent: 'root',
    tree: manifest.tree,
    type: 'NodeSubmitted',
  };
  const envelope = seal('msg', body, identity);

  ctx.store.writeNode({
    manifest,
    detail,
    envelope,
    diff: unifiedDiff({}, files),
  });

  let seq: number | null = null;
  let published = false;
  try {
    const receipt = await ctx.log().publish(body);
    seq = receipt.seq;
    published = true;
  } catch (err) {
    process.stderr.write(
      `petri: the node was written but not published: ${(err as Error).message}\n` +
        `       Run \`petri publish ${nodeId.slice(0, 12)}\` when the log is reachable.\n`,
    );
  }

  return { nodeId, harnessId: hid, files: paths.length, published, seq };
}

/**
 * §13.2: `whyNotUntested` is the one nullable field in Petri, and §2 forbids
 * `null` inside hashed bytes. The writer drops the key. The reader restores it
 * through the Zod default.
 *
 * The rule itself lives in `src/core/ids.ts`, which owns every id maker. This is
 * one name for it, not a second copy.
 */
export { detailDigestInput as canonicalDetail };
