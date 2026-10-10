/**
 * Node-id determinism. SPEC.md sections 3.1, 6.3, 6.8 and 17.6 to 17.8.
 *
 * The node id is the content id of the manifest and nothing else. It must not
 * depend on the order the manifest keys were written in, because a JSON reader in
 * another language gives another order. If it did, one node would have two ids and
 * a parent link would point at nothing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { canonicalJson } from '../src/core/canonical.js';
import { detailDigestInput, detailIdOf, harnessId, nodeIdOf } from '../src/core/ids.js';
import type { Canon } from '../src/core/canonical.js';
import type { NodeDetail, NodeManifest } from '../src/core/schema.js';
import { NodeManifestSchema } from '../src/core/schema.js';
import { seedBaseFor, seedFor } from '../src/trust/report.js';

const AUTHOR_A = 'd04ab232742bb4ab3a1368bd4615e4e6d0224ab71a016baf8520a332c9778737';
const BENCH = 'aa80a75294768bd3bc81ed688e6fd0b4ea2741b68c3508fa37b023f1d70b5cb8';

/** G5. SPEC.md section 17.6. */
const ROOT_MANIFEST: NodeManifest = {
  protocol: 'petri/node/1',
  tree: 'petri-main',
  parent: 'root',
  author: AUTHOR_A,
  harness: '3c1ed617cef3c5b19aa7200aa51aaa540247bc21e4c5a0f0c33c9cc31a564d12',
  bench: BENCH,
  detail: 'd'.repeat(64),
  hypothesis: 'Single-shot prompt. No retry. No test run. This is the honest baseline.',
  nonce: '',
};

const ROOT_ID = 'a5966c17a7d5ee36571983655df9c4c7e168b7602b90ae0b373d10b6b51e78a6';
const CHILD_HARNESS = '88658e3e002e3c34a8a83b4d9f4fce37c5686015e38a373578cc74747ce8701d';
const CHILD_ID = 'a3572a8d3168357ad34c4afbebc65a4f55ccfa2c0bc5f157d4f65391dea75fa4';

/** G6. SPEC.md section 17.7. */
const CHILD_MANIFEST: NodeManifest = {
  ...ROOT_MANIFEST,
  parent: ROOT_ID,
  harness: CHILD_HARNESS,
  detail: 'e'.repeat(64),
  hypothesis:
    'Because the prompt sends only symbol names, sending full signatures will '
    + 'raise the median by at least 500bp.',
};

test('G5: the root manifest canonicalises to 465 bytes and the frozen id', () => {
  assert.equal(Buffer.byteLength(canonicalJson(ROOT_MANIFEST as unknown as Canon), 'utf8'), 465);
  assert.equal(nodeIdOf(ROOT_MANIFEST), ROOT_ID);
});

test('G5: reversing the key order does not change the node id', () => {
  const reversed = Object.fromEntries(
    Object.entries(ROOT_MANIFEST).reverse(),
  ) as unknown as NodeManifest;
  assert.notDeepEqual(Object.keys(reversed), Object.keys(ROOT_MANIFEST));
  assert.equal(nodeIdOf(reversed), ROOT_ID);
});

test('the node id does not depend on key order, for any rotation of the keys', () => {
  const entries = Object.entries(CHILD_MANIFEST);
  for (let shift = 0; shift < entries.length; shift++) {
    const rotated = [...entries.slice(shift), ...entries.slice(0, shift)];
    const manifest = Object.fromEntries(rotated) as unknown as NodeManifest;
    assert.equal(nodeIdOf(manifest), CHILD_ID, `rotation by ${shift} changed the id`);
  }
});

test('G6: the child harness id and the child node id are frozen', () => {
  assert.equal(
    harnessId({ 'agent/loop.ts': 'export const N = 2;\n', 'agent/prompt.md': '# system\n' }),
    CHILD_HARNESS,
  );
  assert.equal(nodeIdOf(CHILD_MANIFEST), CHILD_ID);
});

test('one changed byte anywhere changes the node id', () => {
  for (const field of ['tree', 'parent', 'author', 'harness', 'bench', 'detail', 'hypothesis'] as const) {
    const edited: NodeManifest = { ...CHILD_MANIFEST };
    const current = edited[field];
    edited[field] = field === 'hypothesis' ? `${current} ` : current.replace(/.$/, 'f');
    assert.notEqual(nodeIdOf(edited), CHILD_ID, `editing ${field} left the id unchanged`);
  }
});

test('the nonce lets one author re-propose an identical node under a new id', () => {
  const again: NodeManifest = { ...CHILD_MANIFEST, nonce: '00' };
  assert.notEqual(nodeIdOf(again), CHILD_ID);
});

test('the manifest schema refuses a hypothesis with a newline, so the hash is stable', () => {
  const bad = { ...CHILD_MANIFEST, hypothesis: 'A hypothesis\nover two lines.' };
  assert.equal(NodeManifestSchema.safeParse(bad).success, false);
  assert.equal(NodeManifestSchema.safeParse(CHILD_MANIFEST).success, true);
});

/* -------------------------------------------------------------------------- */
/* G7 — the derived seeds. SPEC.md sections 6.8 and 17.8.                      */
/* -------------------------------------------------------------------------- */

test('G7: the seeds derive from the candidate node id alone', () => {
  assert.equal(
    seedBaseFor(CHILD_ID),
    '4c581ad0d819234f5a99865db43a8587ffca23ac77f7c3c3b63a7836f4018c22',
  );
  assert.equal(
    seedFor(CHILD_ID, 0),
    '3243d3cd35431fc285c97fe2f6273f342ded906bbcb350f11ec84e98dc384bc2',
  );
  assert.equal(
    seedFor(CHILD_ID, 1),
    '06746f61f42545668c29d7adc8477c9aeb4211965c701b73ac45e86b4032c4e7',
  );
  assert.equal(
    seedFor(CHILD_ID, 2),
    '2240b3377b527447667e6b40d465fa344ad0784413bcc7559f32b1c8c273e91f',
  );
});

/* -------------------------------------------------------------------------- */
/* Section 6.4 — the one deliberate exception.                                 */
/* -------------------------------------------------------------------------- */

const DETAIL: NodeDetail = {
  protocol: 'petri/detail/1',
  node: '',
  mode: 'replay',
  proposal: {
    hypothesis: 'Because the prompt sends only symbol names, sending signatures will help.',
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
  parentHarness: CHILD_HARNESS,
  provenance: {
    source: 'human',
    model: 'none',
    promptHash: '0'.repeat(64),
    digestHash: '',
    seed: 7,
  },
  mechanical: { cls: 'ok', command: '', exitCode: 0, evidence: '' },
};

test('the detail id blanks the node back-reference, so filling it in changes nothing', () => {
  const filled: NodeDetail = { ...DETAIL, node: CHILD_ID };
  assert.equal(detailIdOf(filled), detailIdOf(DETAIL));
});

test('a null whyNotUntested is dropped, because canonical JSON forbids null', () => {
  const canon = detailDigestInput(DETAIL) as { proposal: Record<string, unknown> };
  assert.equal('whyNotUntested' in canon.proposal, false);
  // It must survive the encoder, which is the whole point of dropping the key.
  assert.doesNotThrow(() => canonicalJson(detailDigestInput(DETAIL)));
});

test('a non-null whyNotUntested is kept and changes the detail id', () => {
  const stated: NodeDetail = {
    ...DETAIL,
    proposal: { ...DETAIL.proposal, whyNotUntested: 'The retrieval area has no fixtures yet.' },
  };
  const canon = detailDigestInput(stated) as { proposal: Record<string, unknown> };
  assert.equal(canon.proposal['whyNotUntested'], 'The retrieval area has no fixtures yet.');
  assert.notEqual(detailIdOf(stated), detailIdOf(DETAIL));
});
