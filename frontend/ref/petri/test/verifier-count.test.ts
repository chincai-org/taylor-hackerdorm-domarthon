/**
 * The printed verifier count must equal the counted set. SPEC.md sections 8.9,
 * 9.3 and 9.4.
 *
 * A reader trusts the number on the status line. The acceptance rule collapses
 * two reports from one key into one vote and drops the author's own report, so
 * the number of report FILES is always the wrong number to print. These checks
 * pin the two together for the three ways they can drift apart: a duplicate key,
 * a self-report and a report the policy refuses.
 *
 * They also pin design rule 1's signing-time guard, which was dead code until
 * `petri verify` called it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { PolicySchema, type Policy } from '../src/config.js';
import { REPO_ROOT } from '../src/core/root.js';
import type { EnvDescriptor, Mode, NodeDetail, NodeManifest, PetriNode } from '../src/core/schema.js';
import type { VerificationSigned } from '../src/consensus/messages.js';
import {
  evaluate,
  type CountedVerification,
  type NodeFacts,
  type Verdict,
} from '../src/policy/acceptance.js';
import { statusLine, verifiersPhrase } from '../src/cli/banner.js';
import { deltasOf, reportVerdicts, verifiedMedianOf, verifierTally } from '../src/cli/tree.js';
import { identityFromSeedHex } from '../src/trust/identity.js';
import {
  assertNotSelfVerification,
  buildSignedReport,
  checkReport,
  SelfVerificationError,
  type SignedReport,
} from '../src/trust/report.js';

const POLICY: Policy = PolicySchema.parse({});

const AUTHOR = identityFromSeedHex('a'.repeat(64), 'author');
const RUNNER_B = identityFromSeedHex('b'.repeat(64), 'runner-b');
const RUNNER_C = identityFromSeedHex('c'.repeat(64), 'runner-c');

const TREE = 'petri-main';
const BENCH = '3'.repeat(64);
const PARENT = '2'.repeat(64);
const NODE = '1'.repeat(64);
const TOTAL = 20;

const env = (mode: Mode): EnvDescriptor => ({
  arch: 'arm64',
  benchId: BENCH,
  ledger: 'local',
  mode,
  model: 'replay',
  nodeVersion: 'v22.0.0',
  petriCommit: 'unknown',
  platform: 'darwin',
});

/** One paired report. `passed` fixes the delta, so every case is exact. */
function report(
  id: ReturnType<typeof identityFromSeedHex>,
  opts: { parentPassed: number; candidatePassed: number; mode?: Mode; startedAt?: number },
): SignedReport {
  const mode = opts.mode ?? 'replay';
  const side = (passed: number): { passed: number; resultId: string; tokens: number; wallMs: number }[] =>
    Array.from({ length: 5 }, (_, i) => ({
      passed,
      resultId: `${i}`.repeat(64),
      tokens: 100,
      wallMs: 10,
    }));
  return buildSignedReport(
    {
      tree: TREE,
      bench: BENCH,
      mode,
      parentNode: PARENT,
      candidateNode: NODE,
      total: TOTAL,
      parentRuns: side(opts.parentPassed),
      candidateRuns: side(opts.candidatePassed),
      startedAt: opts.startedAt ?? 1,
      env: env(mode),
    },
    id,
  );
}

const MANIFEST: NodeManifest = {
  protocol: 'petri/node/1',
  tree: TREE,
  parent: PARENT,
  author: AUTHOR.publicKeyHex,
  harness: '4'.repeat(64),
  bench: BENCH,
  detail: '5'.repeat(64),
  hypothesis: 'Sending full signatures raises the median, because most failures are shape errors.',
  nonce: '',
};

const DETAIL: NodeDetail = {
  protocol: 'petri/detail/1',
  node: NODE,
  mode: 'replay',
  proposal: {
    hypothesis: 'Sending full signatures raises the median, because most failures are shape errors.',
    falsifiedIf: 'The verified delta stays below 1000bp on both verifiers.',
    primaryArea: 'prompt',
    motif: 'full-signatures',
    metric: 'score',
    predictedDelta: 1000,
    reasoning: 'The model guesses argument order without the signature.',
    whyNotUntested: null,
    contradicts: [],
    files: [{ path: 'harness/prompt.ts', contents: 'export const P = 1;\n' }],
  },
  derivedAreas: ['prompt'],
  areaMismatch: false,
  claimedRuns: [],
  claimedMedianBp: 0,
  parentHarness: '6'.repeat(64),
  provenance: {
    source: 'human',
    model: 'none',
    promptHash: '0'.repeat(64),
    digestHash: '',
    seed: 7,
  },
  mechanical: { cls: 'ok', command: '', exitCode: 0, evidence: '' },
};

/** A node carrying the RAW report list, exactly as the store hands it over. */
function node(verifications: SignedReport[], verdict: Verdict): PetriNode {
  return {
    id: NODE,
    manifest: MANIFEST,
    detail: DETAIL,
    diff: '',
    verifications,
    status: verdict.status,
    statusCode: verdict.code,
    statusReason: verdict.reason,
    verifiedDeltaBp: verdict.deltaBp,
    disputed: false,
    mode: 'replay',
    trust: 'local-unverified',
    seq: 1,
    consensusNanos: '0',
  };
}

/**
 * The facts the reducer would build from the same reports: the FIRST message
 * from each key, the author included, because the rule drops the author itself.
 */
function factsOf(verifications: SignedReport[]): NodeFacts {
  const map = new Map<string, CountedVerification>();
  verifications.forEach((signed, i) => {
    const checked = checkReport(signed);
    if (!checked.ok) return;
    const r = checked.report;
    const scores = r.candidate.runs.map((x) => x.scoreBp);
    const msg: VerificationSigned = {
      candMedianBp: r.candidate.medianBp,
      clean: true,
      deltaMedianBp: r.deltaMedianBp,
      envHash: 'e'.repeat(64),
      mode: r.mode,
      node: r.candidate.node,
      parent: r.parent.node,
      parentMedianBp: r.parent.medianBp,
      report: checked.id,
      runs: r.runs,
      spreadBp: Math.max(...scores) - Math.min(...scores),
      tree: TREE,
      type: 'VerificationSigned',
    };
    if (!map.has(signed.pub)) map.set(signed.pub, { pub: signed.pub, msg, seq: i + 1 });
  });
  return {
    nodeId: NODE,
    author: AUTHOR.publicKeyHex,
    bench: BENCH,
    mode: 'replay',
    parent: PARENT,
    verifications: map,
    withdrawn: false,
    superseded: false,
  };
}

const build = (verifications: SignedReport[]): { node: PetriNode; verdict: Verdict } => {
  const verdict = evaluate(factsOf(verifications), POLICY, 'local');
  return { node: node(verifications, verdict), verdict };
};

/** The counted number on the line is the counted number in the rule. Always. */
function assertLineMatchesRule(n: PetriNode, verdict: Verdict): void {
  const tally = verifierTally(n, verdict);
  assert.equal(
    tally.counted,
    verdict.counted.length,
    'the printed count is not the count the rule used',
  );
  const line = statusLine({
    id: n.id,
    status: n.status,
    deltaBp: n.verifiedDeltaBp,
    deltas: deltasOf(n, verdict),
    verifiers: tally,
    mode: n.mode,
    trust: n.trust,
  });
  assert.match(line, new RegExp(`verifiers ${verdict.counted.length} counted`));
  if (n.verifications.length !== verdict.counted.length) {
    assert.doesNotMatch(
      line,
      new RegExp(`verifiers ${n.verifications.length} `),
      'the raw report count reached the status line',
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Case 1 — two reports from ONE key.                                          */
/* -------------------------------------------------------------------------- */

test('a duplicate key is printed as one counted verification, and the repeat is named', () => {
  const reports = [
    report(RUNNER_B, { parentPassed: 5, candidatePassed: 19 }),
    report(RUNNER_C, { parentPassed: 5, candidatePassed: 19 }),
    // The same key again, with a different number. It is still ONE vote.
    report(RUNNER_C, { parentPassed: 5, candidatePassed: 20, startedAt: 2 }),
  ];
  const { node: n, verdict } = build(reports);

  assert.equal(n.verifications.length, 3, 'three reports are on disk');
  assert.equal(verdict.counted.length, 2, 'the rule counts two keys');

  const tally = verifierTally(n, verdict);
  assert.equal(tally.counted, 2);
  assert.equal(tally.ignored.length, 1);
  assert.equal(tally.ignored[0]?.kind, 'duplicate key');
  assert.equal(verifiersPhrase(tally), '2 counted, 1 ignored (duplicate key)');
  assertLineMatchesRule(n, verdict);

  // The contested delta range must not read the repeat either.
  assert.deepEqual(deltasOf(n, verdict), [7000, 7000]);
});

/* -------------------------------------------------------------------------- */
/* Case 2 — the author verifies their own node. Design rule 1.                 */
/* -------------------------------------------------------------------------- */

test('a self-report is printed as ignored, never as a verifier', () => {
  const reports = [
    report(AUTHOR, { parentPassed: 5, candidatePassed: 20 }),
    report(RUNNER_B, { parentPassed: 5, candidatePassed: 19 }),
  ];
  const { node: n, verdict } = build(reports);

  assert.equal(n.verifications.length, 2, 'two reports are on disk');
  assert.equal(verdict.counted.length, 1, 'the author never counts');

  const tally = verifierTally(n, verdict);
  assert.equal(tally.counted, 1);
  assert.equal(tally.ignored.length, 1);
  assert.equal(tally.ignored[0]?.kind, 'self-report');
  assert.equal(tally.ignored[0]?.pub, AUTHOR.publicKeyHex);
  assert.equal(verifiersPhrase(tally), '1 counted, 1 ignored (self-report)');
  assertLineMatchesRule(n, verdict);

  // The author scored 10000bp. It must not reach the verified median either.
  assert.equal(verifiedMedianOf(n, verdict), 9500);
  assert.deepEqual(deltasOf(n, verdict), [7000]);
});

/* -------------------------------------------------------------------------- */
/* Case 1b — the per-report answer `petri export` writes for the web app.       */
/* -------------------------------------------------------------------------- */

test('the export flag marks the repeat, not just the key, as ignored', () => {
  const reports = [
    report(RUNNER_B, { parentPassed: 5, candidatePassed: 19 }),
    report(RUNNER_C, { parentPassed: 5, candidatePassed: 19 }),
    report(RUNNER_C, { parentPassed: 5, candidatePassed: 20, startedAt: 2 }),
  ];
  const { node: n, verdict } = build(reports);
  const decided = reportVerdicts(n, verdict);

  const idOf = (r: SignedReport): string => {
    const checked = checkReport(r);
    assert.ok(checked.ok);
    return checked.id;
  };
  const [first, second, repeat] = reports.map(idOf);

  assert.equal(decided.size, 3, 'every readable report gets an answer of its own');
  assert.equal(decided.get(first!)?.counted, true);
  assert.equal(decided.get(second!)?.counted, true);
  // A per-KEY answer marks this one counted too, and the page then shows three.
  assert.equal(decided.get(repeat!)?.counted, false);
  assert.match(decided.get(repeat!)?.why ?? '', /already verified this node/);

  const counted = [...decided.values()].filter((v) => v.counted).length;
  assert.equal(counted, verdict.counted.length, 'the page count must be the rule count');
  assert.equal(counted, verifierTally(n, verdict).counted, 'the page and the CLI must agree');
});

/* -------------------------------------------------------------------------- */
/* Case 3 — a report from the other mode. The policy refuses it.               */
/* -------------------------------------------------------------------------- */

test('a live report on a replay node is printed as ignored, with the policy reason', () => {
  const reports = [
    report(RUNNER_B, { parentPassed: 5, candidatePassed: 19 }),
    report(RUNNER_C, { parentPassed: 5, candidatePassed: 19, mode: 'live' }),
  ];
  const { node: n, verdict } = build(reports);

  assert.equal(n.verifications.length, 2, 'two reports are on disk');
  assert.equal(verdict.counted.length, 1, 'a live number cannot support a replay node');

  const tally = verifierTally(n, verdict);
  assert.equal(tally.counted, 1);
  assert.equal(tally.ignored.length, 1);
  assert.equal(tally.ignored[0]?.kind, 'policy');
  assert.match(tally.ignored[0]?.why ?? '', /mode live cannot support a replay node/);
  assert.equal(verifiersPhrase(tally), '1 counted, 1 ignored (policy)');
  assertLineMatchesRule(n, verdict);

  // The status is pending, so the reason must not claim two verifications.
  assert.equal(verdict.status, 'pending');
  assert.match(verdict.reason, /^1 of 2 /);
});

/* -------------------------------------------------------------------------- */
/* The clean case still reads cleanly.                                         */
/* -------------------------------------------------------------------------- */

test('with nothing ignored the line says "2 counted" and names no reason', () => {
  const reports = [
    report(RUNNER_B, { parentPassed: 5, candidatePassed: 19 }),
    report(RUNNER_C, { parentPassed: 5, candidatePassed: 19 }),
  ];
  const { node: n, verdict } = build(reports);
  const tally = verifierTally(n, verdict);
  assert.equal(verifiersPhrase(tally), '2 counted');
  assertLineMatchesRule(n, verdict);
});

/* -------------------------------------------------------------------------- */
/* The verdict may not claim independence a local log cannot prove.            */
/* -------------------------------------------------------------------------- */

test('a local ledger verdict never calls two keys independent', () => {
  const facts = factsOf([
    report(RUNNER_B, { parentPassed: 5, candidatePassed: 19 }),
    report(RUNNER_C, { parentPassed: 5, candidatePassed: 19 }),
  ]);
  const local = evaluate(facts, POLICY, 'local');
  assert.equal(local.status, 'accepted');
  assert.doesNotMatch(local.reason, /independent/);
  assert.match(local.reason, /2 verifications from distinct keys/);
  assert.match(local.reason, /one person can hold every key/);

  const hcs = evaluate(facts, POLICY, 'hcs');
  assert.equal(hcs.status, 'accepted');
  assert.match(hcs.reason, /2 independent verifications/);
  assert.doesNotMatch(hcs.reason, /one person can hold every key/);

  // A caller that does not know the ledger gets the WEAKEST claim.
  assert.equal(evaluate(facts, POLICY).reason, local.reason);
});

/* -------------------------------------------------------------------------- */
/* Design rule 1, enforcement 1 of 3. The guard must not be dead code.         */
/* -------------------------------------------------------------------------- */

test('the self-verification guard throws exit code 4 and `petri verify` calls it', () => {
  assert.doesNotThrow(() =>
    assertNotSelfVerification(NODE, AUTHOR.publicKeyHex, RUNNER_B.publicKeyHex),
  );
  assert.throws(
    () => assertNotSelfVerification(NODE, AUTHOR.publicKeyHex, AUTHOR.publicKeyHex),
    (err: unknown) =>
      err instanceof SelfVerificationError && err.exitCode === 4 && /cannot verify your own/.test(err.message),
  );

  const source = readFileSync(join(REPO_ROOT, 'src/cli/verify.ts'), 'utf8');
  assert.match(
    source,
    /assertNotSelfVerification\(/,
    '`petri verify` must call the guard, or the guard is protection nobody runs',
  );
});
