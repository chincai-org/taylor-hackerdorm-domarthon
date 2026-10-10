/**
 * The acceptance rule, at its edges. SPEC.md sections 9.1 to 9.7.
 *
 * Three of the six design rules meet here.
 *   Rule 1: a contributor can never accept their own node, and two verifications
 *           from one key count as one.
 *   Rule 2: the margin is 1000bp, and every counted verifier must clear it alone.
 *   Rule 3: a tie is REJECTED and kept, never hidden.
 *
 * `evaluate` is pure. It does no I/O, reads no clock and uses no randomness, so
 * every case below is exact.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { PolicySchema, type Policy } from '../src/config.js';
import type { VerificationSigned } from '../src/consensus/messages.js';
import { replay } from '../src/consensus/replay.js';
import type { LogEntry } from '../src/consensus/log.js';
import { evaluate, type CountedVerification, type NodeFacts } from '../src/policy/acceptance.js';

const POLICY: Policy = PolicySchema.parse({});

const AUTHOR = 'a'.repeat(64);
const RUNNER_B = 'b'.repeat(64);
const RUNNER_C = 'c'.repeat(64);
const NODE = '1'.repeat(64);
const PARENT = '2'.repeat(64);
const BENCH = '3'.repeat(64);
const TREE = 'petri-main';

/** One `VerificationSigned` body. Only `deltaMedianBp` varies in most cases. */
function message(over: Partial<VerificationSigned> = {}): VerificationSigned {
  return {
    candMedianBp: 7000,
    clean: true,
    deltaMedianBp: 1000,
    envHash: 'e'.repeat(64),
    mode: 'replay',
    node: NODE,
    parent: PARENT,
    parentMedianBp: 6000,
    report: 'f'.repeat(64),
    runs: 5,
    spreadBp: 500,
    tree: TREE,
    type: 'VerificationSigned',
    ...over,
  };
}

/** The node under test, with one verification per entry of `votes`. */
function facts(
  votes: { pub: string; msg?: Partial<VerificationSigned> }[],
  over: Partial<NodeFacts> = {},
): NodeFacts {
  const verifications = new Map<string, CountedVerification>();
  votes.forEach((vote, i) => {
    // The Map is keyed by public key, first-wins. That IS the duplicate-key rule.
    if (verifications.has(vote.pub)) return;
    verifications.set(vote.pub, { pub: vote.pub, msg: message(vote.msg), seq: i + 1 });
  });
  return {
    nodeId: NODE,
    author: AUTHOR,
    bench: BENCH,
    mode: 'replay',
    parent: PARENT,
    verifications,
    withdrawn: false,
    superseded: false,
    ...over,
  };
}

const delta = (bp: number): Partial<VerificationSigned> => ({ deltaMedianBp: bp });

/* -------------------------------------------------------------------------- */
/* Rule 2 — the margin, at the boundary.  SPEC.md sections 4.1 and 9.7.        */
/* -------------------------------------------------------------------------- */

test('the margin is 1000bp and the policy default says so', () => {
  assert.equal(POLICY.minDeltaBp, 1000);
  assert.equal(POLICY.minVerifications, 2);
  assert.equal(POLICY.minRuns, 5);
});

test('exactly at the margin: +1000 and +1200 is accepted at the worst delta', () => {
  const verdict = evaluate(
    facts([{ pub: RUNNER_B, msg: delta(1000) }, { pub: RUNNER_C, msg: delta(1200) }]),
    POLICY,
  );
  assert.equal(verdict.status, 'accepted');
  assert.equal(verdict.code, 'WIN');
  assert.equal(verdict.deltaBp, 1000, 'the most conservative verifier decides');
  assert.deepEqual(verdict.counted.sort(), [RUNNER_B, RUNNER_C].sort());
});

test('one basis point below the margin is rejected as WITHIN_NOISE', () => {
  const verdict = evaluate(
    facts([{ pub: RUNNER_B, msg: delta(999) }, { pub: RUNNER_C, msg: delta(1200) }]),
    POLICY,
  );
  assert.equal(verdict.status, 'rejected');
  assert.equal(verdict.code, 'WITHIN_NOISE');
  assert.equal(verdict.deltaBp, 999);
});

test('every counted verifier must clear the margin alone, not on average', () => {
  // +1500 and +500 average to +1000. The span is exactly 1000, so the
  // disagreement guard does not fire, and the lower verifier decides.
  const verdict = evaluate(
    facts([{ pub: RUNNER_B, msg: delta(1500) }, { pub: RUNNER_C, msg: delta(500) }]),
    POLICY,
  );
  assert.equal(verdict.status, 'rejected');
  assert.equal(verdict.code, 'WITHIN_NOISE');
  assert.equal(verdict.deltaBp, 500);
});

test('a root node that clears the margin is accepted as the baseline', () => {
  const verdict = evaluate(
    facts(
      [
        { pub: RUNNER_B, msg: { ...delta(6000), parent: 'root', parentMedianBp: 0 } },
        { pub: RUNNER_C, msg: { ...delta(6000), parent: 'root', parentMedianBp: 0 } },
      ],
      { parent: 'root' },
    ),
    POLICY,
  );
  assert.equal(verdict.status, 'accepted');
  assert.equal(verdict.code, 'ROOT_BASELINE');
});

test('at and below the negative margin the node is a measured regression', () => {
  const verdict = evaluate(
    facts([{ pub: RUNNER_B, msg: delta(-2000) }, { pub: RUNNER_C, msg: delta(-1500) }]),
    POLICY,
  );
  assert.equal(verdict.status, 'rejected');
  assert.equal(verdict.code, 'REGRESSION');
  assert.equal(verdict.deltaBp, -1500, 'the best delta is reported');
});

/* -------------------------------------------------------------------------- */
/* Rule 3 — an exact tie.                                                      */
/* -------------------------------------------------------------------------- */

test('an exact tie at 0 and 0 is rejected as WITHIN_NOISE, not accepted', () => {
  const verdict = evaluate(
    facts([{ pub: RUNNER_B, msg: delta(0) }, { pub: RUNNER_C, msg: delta(0) }]),
    POLICY,
  );
  assert.equal(verdict.status, 'rejected');
  assert.equal(verdict.code, 'WITHIN_NOISE');
  assert.equal(verdict.deltaBp, 0);
  assert.match(verdict.reason, /tie, not a regression/);
});

test('a tie keeps its evidence: both verifiers stay counted', () => {
  const verdict = evaluate(
    facts([{ pub: RUNNER_B, msg: delta(0) }, { pub: RUNNER_C, msg: delta(0) }]),
    POLICY,
  );
  assert.equal(verdict.counted.length, 2);
  assert.equal(verdict.ignored.length, 0);
});

test('verifiers that disagree on the sign make the node contested, not rejected', () => {
  const verdict = evaluate(
    facts([{ pub: RUNNER_B, msg: delta(1500) }, { pub: RUNNER_C, msg: delta(-1500) }]),
    POLICY,
  );
  assert.equal(verdict.status, 'contested');
  assert.equal(verdict.code, 'CONTESTED');
  assert.equal(verdict.deltaBp, null);
});

/* -------------------------------------------------------------------------- */
/* Rule 1 — self-verification is refused.  SPEC.md section 9.4.                */
/* -------------------------------------------------------------------------- */

test('the author verifying their own node twice counts for nothing', () => {
  const verdict = evaluate(facts([{ pub: AUTHOR, msg: delta(5000) }]), POLICY);
  assert.equal(verdict.status, 'pending');
  assert.equal(verdict.code, 'INSUFFICIENT_VERIFICATIONS');
  assert.equal(verdict.counted.length, 0);
  assert.equal(verdict.deltaBp, null);
  assert.equal(verdict.ignored.length, 1);
  assert.equal(verdict.ignored[0]?.pub, AUTHOR);
  assert.match(String(verdict.ignored[0]?.why), /self-verification/);
});

test('the author cannot turn a losing node into a win', () => {
  const verdict = evaluate(
    facts([
      { pub: AUTHOR, msg: delta(9000) },
      { pub: RUNNER_B, msg: delta(0) },
      { pub: RUNNER_C, msg: delta(0) },
    ]),
    POLICY,
  );
  assert.equal(verdict.status, 'rejected');
  assert.equal(verdict.code, 'WITHIN_NOISE');
  assert.equal(verdict.counted.length, 2);
  assert.equal(verdict.deltaBp, 0);
});

test('one independent verifier is never enough, whatever the delta', () => {
  const verdict = evaluate(facts([{ pub: RUNNER_B, msg: delta(9000) }]), POLICY);
  assert.equal(verdict.status, 'pending');
  assert.equal(verdict.code, 'INSUFFICIENT_VERIFICATIONS');
  assert.equal(verdict.counted.length, 1);
});

/* -------------------------------------------------------------------------- */
/* Rule 1 — one key is one vote.  SPEC.md sections 9.4 and 9.8 rule 4.         */
/* -------------------------------------------------------------------------- */

test('two verifications from one key count as one', () => {
  // `facts` fills the Map first-wins, exactly as the replay reducer does. A key
  // that votes twice therefore leaves one entry, and two such keys are still one
  // short of the two independent verifications acceptance needs.
  const verdict = evaluate(
    facts([
      { pub: RUNNER_B, msg: delta(1500) },
      { pub: RUNNER_B, msg: delta(9000) },
      { pub: RUNNER_B, msg: delta(9000) },
    ]),
    POLICY,
  );
  assert.equal(verdict.counted.length, 1, 'one key is one vote, forever');
  assert.equal(verdict.status, 'pending');
  assert.equal(verdict.code, 'INSUFFICIENT_VERIFICATIONS');
});

test('one key voting twice cannot stand in for a second independent runner', () => {
  const twoKeys = evaluate(
    facts([{ pub: RUNNER_B, msg: delta(1500) }, { pub: RUNNER_C, msg: delta(1500) }]),
    POLICY,
  );
  const oneKeyTwice = evaluate(
    facts([{ pub: RUNNER_B, msg: delta(1500) }, { pub: RUNNER_B, msg: delta(1500) }]),
    POLICY,
  );
  assert.equal(twoKeys.status, 'accepted');
  assert.equal(oneKeyTwice.status, 'pending');
});

test('the replay reducer keeps the FIRST verification from a key and skips the rest', async () => {
  const entries: LogEntry[] = [
    entry(1, AUTHOR, {
      bench: BENCH, hyp: 'A hypothesis long enough to pass the schema.', node: NODE,
      parent: PARENT, tree: TREE, type: 'NodeSubmitted',
    }),
    entry(2, RUNNER_B, message(delta(500))),
    entry(3, RUNNER_B, message(delta(9000))),   // Same key. It must be skipped.
  ];

  const result = await replay(iterate(entries), TREE, POLICY);
  const node = result.nodes.get(NODE);
  assert.ok(node !== undefined);
  assert.equal(node.verifications.size, 1, 'one key is one vote');
  assert.equal(node.verifications.get(RUNNER_B)?.msg.deltaMedianBp, 500, 'the first one wins');
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0]?.reason ?? '', /one key is one vote/);
  assert.equal(node.verdict.code, 'INSUFFICIENT_VERIFICATIONS');
});

test('the replay reducer reads the signer from the envelope, never from the body', async () => {
  // The body of entry 2 claims the node belongs to a different parent. The signer
  // is still RUNNER_B, so the verification is counted and then dropped on its merits.
  const entries: LogEntry[] = [
    entry(1, AUTHOR, {
      bench: BENCH, hyp: 'A hypothesis long enough to pass the schema.', node: NODE,
      parent: PARENT, tree: TREE, type: 'NodeSubmitted',
    }),
    entry(2, AUTHOR, message(delta(9000))),
    entry(3, RUNNER_B, message(delta(9000))),
    entry(4, RUNNER_C, message(delta(9000))),
  ];

  const result = await replay(iterate(entries), TREE, POLICY);
  const node = result.nodes.get(NODE);
  assert.ok(node !== undefined);
  assert.equal(node.author, AUTHOR);
  assert.equal(node.verdict.status, 'accepted');
  assert.equal(node.verdict.counted.length, 2, "the author's own vote never counts");
  assert.equal(node.verdict.ignored.length, 1);
});

/* -------------------------------------------------------------------------- */
/* The guards that refuse to judge.                                            */
/* -------------------------------------------------------------------------- */

test('an unclean batch rejects the node, whatever the delta', () => {
  const verdict = evaluate(
    facts([
      { pub: RUNNER_B, msg: { ...delta(3000), clean: false } },
      { pub: RUNNER_C, msg: delta(3000) },
    ]),
    POLICY,
  );
  assert.equal(verdict.status, 'rejected');
  assert.equal(verdict.code, 'NOT_CLEAN');
});

test('a spread above the limit leaves the node pending, never rejected', () => {
  const verdict = evaluate(
    facts([
      { pub: RUNNER_B, msg: { ...delta(3000), spreadBp: 7000 } },
      { pub: RUNNER_C, msg: delta(3000) },
    ]),
    POLICY,
  );
  assert.equal(verdict.status, 'pending');
  assert.equal(verdict.code, 'RUNS_TOO_NOISY');
});

test('an even run count has no unique median and is ignored', () => {
  // 6 clears policy.minRuns of 5, so only the odd-count rule can drop it.
  const verdict = evaluate(
    facts([{ pub: RUNNER_B, msg: { ...delta(3000), runs: 6 } }, { pub: RUNNER_C, msg: delta(3000) }]),
    POLICY,
  );
  assert.equal(verdict.code, 'INSUFFICIENT_VERIFICATIONS');
  assert.match(String(verdict.ignored[0]?.why), /even run count/);
});

test('too few runs is ignored, and says so', () => {
  const verdict = evaluate(
    facts([{ pub: RUNNER_B, msg: { ...delta(3000), runs: 3 } }, { pub: RUNNER_C, msg: delta(3000) }]),
    POLICY,
  );
  assert.equal(verdict.code, 'INSUFFICIENT_VERIFICATIONS');
  assert.match(String(verdict.ignored[0]?.why), /only 3 runs, the minimum is 5/);
});

test('a verification in the other mode is ignored, with the reason recorded', () => {
  const verdict = evaluate(
    facts([{ pub: RUNNER_B, msg: { ...delta(3000), mode: 'live' } }, { pub: RUNNER_C, msg: delta(3000) }]),
    POLICY,
  );
  assert.equal(verdict.code, 'INSUFFICIENT_VERIFICATIONS');
  assert.match(String(verdict.ignored[0]?.why), /mode live cannot support a replay node/);
});

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function entry(seq: number, pub: string, body: LogEntry['envelope']['body']): LogEntry {
  return {
    chain: '0'.repeat(64),
    consensusNanos: String(1_789_200_000_000_000_000n + BigInt(seq)).padStart(19, '0'),
    envelope: { body, pub, sig: '0'.repeat(128), ver: 1 },
    payer: 'local',
    seq,
    source: 'local',
    topic: `local:${TREE}`,
  };
}

async function* iterate(entries: readonly LogEntry[]): AsyncIterable<LogEntry> {
  for (const e of entries) yield e;
}
