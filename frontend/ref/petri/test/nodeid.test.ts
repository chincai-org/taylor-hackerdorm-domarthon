/**
 * A node id is reproducible on a second machine. SPEC.md §6.4a.
 *
 * The claim of `src/core/ids.ts` is that anybody can recompute an id from the
 * stored bytes. That claim holds only when the hashed payload carries nothing
 * about WHERE or WHEN the experiment ran. Three leaks used to break it:
 *
 *   (a) wall-clock time, through `ClaimedRun.wallMs`;
 *   (b) absolute paths and a fresh UUID, through `MechanicalResult.command`
 *       and the raw compiler output in `.evidence`;
 *   (c) local tree state, through `Provenance.digestHash` and `.promptHash`.
 *
 * Every test below fails on that old behaviour and passes on the split of
 * §6.4a. The last two run the real compiler, in two real directories.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  claimedRunIdentity, detailIdOf, detailObservation, diagnosticsOf,
  mechanicalIdentity, nodeIdOf, provenanceIdentity,
} from '../src/core/ids.js';
import { NodeDetailSchema } from '../src/core/schema.js';
import type {
  ClaimedRun, MechanicalResult, NodeDetail, NodeManifest, Provenance,
} from '../src/core/schema.js';
import { typecheckScratch } from '../src/evolve/typecheck.js';

import { REPO_ROOT } from '../src/core/root.js';

const AUTHOR = 'd04ab232742bb4ab3a1368bd4615e4e6d0224ab71a016baf8520a332c9778737';
const BENCH = 'aa80a75294768bd3bc81ed688e6fd0b4ea2741b68c3508fa37b023f1d70b5cb8';
const HARNESS = '88658e3e002e3c34a8a83b4d9f4fce37c5686015e38a373578cc74747ce8701d';
const PARENT = 'a5966c17a7d5ee36571983655df9c4c7e168b7602b90ae0b373d10b6b51e78a6';

/* -------------------------------------------------------------------------- */
/* One experiment, expressed twice.                                            */
/* -------------------------------------------------------------------------- */

const RUNS: ClaimedRun[] = [
  { passed: 12, scoreBp: 6000, tokens: 41_200, wallMs: 1204 },
  { passed: 13, scoreBp: 6500, tokens: 43_980, wallMs: 1187 },
  { passed: 12, scoreBp: 6000, tokens: 40_115, wallMs: 1302 },
];

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
  claimedRuns: RUNS,
  claimedMedianBp: 6000,
  parentHarness: HARNESS,
  provenance: {
    source: 'model',
    model: 'graded',
    promptHash: '0'.repeat(64),
    digestHash: '1a2b3c4d',
    seed: 7,
  },
  mechanical: { cls: 'ok', command: '', exitCode: 0, evidence: '' },
};

const MANIFEST: NodeManifest = {
  protocol: 'petri/node/1',
  tree: 'petri-main',
  parent: PARENT,
  author: AUTHOR,
  harness: HARNESS,
  bench: BENCH,
  detail: 'd'.repeat(64),
  hypothesis: 'Sending full signatures will raise the median by at least 1000bp.',
  nonce: '',
};

/** The node id of one experiment. The detail id is inside the manifest. */
function nodeIdFor(detail: NodeDetail): string {
  return nodeIdOf({ ...MANIFEST, detail: detailIdOf(detail) });
}

/** A detail that differs from DETAIL in the one field named. */
function withProvenance(patch: Partial<Provenance>): NodeDetail {
  return { ...DETAIL, provenance: { ...DETAIL.provenance, ...patch } };
}
function withMechanical(patch: Partial<MechanicalResult>): NodeDetail {
  return { ...DETAIL, mechanical: { ...DETAIL.mechanical, ...patch } };
}
function withWall(wallMs: readonly number[]): NodeDetail {
  return {
    ...DETAIL,
    claimedRuns: DETAIL.claimedRuns.map((r, i) => ({ ...r, wallMs: wallMs[i] ?? r.wallMs })),
  };
}

/* -------------------------------------------------------------------------- */
/* (a) Wall-clock time                                                         */
/* -------------------------------------------------------------------------- */

test('the same experiment hashes to the same id when the wall time differs', () => {
  const expected = nodeIdFor(DETAIL);

  // A fast machine, a loaded machine, a cold cache, a zero, and the largest
  // safe integer. Every one of them is the same experiment.
  const machines = [
    [0, 0, 0],
    [1, 2, 3],
    [1204, 1187, 1302],
    [45_230, 51_188, 47_003],
    [Number.MAX_SAFE_INTEGER, 1, Number.MAX_SAFE_INTEGER],
  ];
  for (const wall of machines) {
    assert.equal(nodeIdFor(withWall(wall)), expected, `wallMs ${wall.join(',')} changed the id`);
  }

  // 500 random timings, which is what 500 machines would produce.
  for (let i = 0; i < 500; i++) {
    const wall = DETAIL.claimedRuns.map(() => Math.floor(Math.random() * 10_000_000));
    assert.equal(nodeIdFor(withWall(wall)), expected, `wallMs ${wall.join(',')} changed the id`);
  }
});

test('the measurement itself still decides the id, so the wall-time test is not vacuous', () => {
  const expected = nodeIdFor(DETAIL);
  const edit = (patch: Partial<ClaimedRun>): NodeDetail => ({
    ...DETAIL,
    claimedRuns: DETAIL.claimedRuns.map((r, i) => (i === 1 ? { ...r, ...patch } : r)),
  });

  assert.notEqual(nodeIdFor(edit({ passed: 11 })), expected, 'passed must be inside the id');
  assert.notEqual(nodeIdFor(edit({ scoreBp: 5500 })), expected, 'scoreBp must be inside the id');
  assert.notEqual(nodeIdFor(edit({ tokens: 43_981 })), expected, 'tokens must be inside the id');
  assert.notEqual(
    nodeIdFor({ ...DETAIL, claimedRuns: [] }), expected,
    'dropping the runs must change the id',
  );
  assert.equal(Object.keys(claimedRunIdentity(RUNS[0]!)).sort().join(','), 'passed,scoreBp,tokens');
});

/* -------------------------------------------------------------------------- */
/* (b) Absolute paths, UUIDs and tool command lines                            */
/* -------------------------------------------------------------------------- */

test('the tool command line is outside the id, whatever compiler ran', () => {
  const expected = nodeIdFor(DETAIL);
  const commands = [
    '',
    'pnpm exec tsc -p /Users/ada/code/petri/.petri/scratch/1f2e/tsconfig.json',
    '/home/grace/petri/node_modules/.bin/tsc -p tsconfig.json',
    'C:\\Users\\Ada\\petri\\node_modules\\.bin\\tsc -p tsconfig.json',
  ];
  for (const command of commands) {
    assert.equal(nodeIdFor(withMechanical({ command })), expected, `command "${command}" changed the id`);
  }
  for (const exitCode of [0, 1, 2, 127]) {
    assert.equal(nodeIdFor(withMechanical({ exitCode })), expected, `exit ${exitCode} changed the id`);
  }
});

test('two machines that compile one broken patch agree, though their paths differ', () => {
  const homes = [
    '/Users/ada/code/petri/.petri/scratch/3f0c9b61-6b2d-4f8e-8f3b-1c2d3e4f5a6b/',
    '/home/grace/work/petri-clone/.petri/scratch/9d8c7b6a-5e4f-3a2b-1c0d-9e8f7a6b5c4d/',
  ];
  const ids = homes.map((prefix) => {
    const evidence = [
      `${prefix}harness/loop.ts(12,3): error TS2345: Argument of type 'string' is not assignable.`,
      `${prefix}harness/prompt.ts(4,18): error TS2322: Type 'number' is not assignable to type 'string'.`,
      '',
      'Found 2 errors in 2 files.',
      '',
      'Errors  Files',
      `     1  ${prefix}harness/loop.ts:12`,
      `     1  ${prefix}harness/prompt.ts:4`,
    ].join('\n');
    return nodeIdFor(withMechanical({
      cls: 'typecheck-failed',
      command: `${prefix}../../../node_modules/.bin/tsc -p tsconfig.json`,
      exitCode: 2,
      evidence,
    }));
  });
  assert.equal(ids[0], ids[1], 'the home directory and the run UUID leaked into the id');

  // The diagnostics themselves still count. A different error is a different node.
  const other = nodeIdFor(withMechanical({
    cls: 'typecheck-failed', command: '', exitCode: 2,
    evidence: 'harness/loop.ts(12,3): error TS2531: Object is possibly null.',
  }));
  assert.notEqual(other, ids[0], 'the diagnostics must be inside the id');
  assert.equal(
    nodeIdFor(withMechanical({ cls: 'typecheck-failed', command: '', exitCode: 2, evidence: '' })),
    nodeIdFor(withMechanical({
      cls: 'typecheck-failed', command: 'x', exitCode: 9,
      evidence: 'no TypeScript compiler could be started. Tried:\n/Users/ada/x -> ENOENT',
    })),
    'a machine with no compiler must not get its own id',
  );
});

test('diagnosticsOf keeps the code and the workspace-relative path, and nothing else', () => {
  const line = '/Users/ada/petri/.petri/scratch/9f/harness/loop.ts(12,3): '
    + "error TS2345: Argument of type 'string' is not assignable.";
  assert.deepEqual(diagnosticsOf(line), ['harness/loop.ts(12,3) TS2345']);
  assert.deepEqual(
    diagnosticsOf('harness\\loop.ts(1,1): error TS1005: \';\' expected.'),
    ['harness/loop.ts(1,1) TS1005'],
  );
  assert.deepEqual(diagnosticsOf('error TS18003: No inputs were found in config file.'), ['TS18003']);
  assert.deepEqual(diagnosticsOf('Found 2 errors in 2 files.\n\nErrors  Files'), []);
  // A home directory may hold a space. The diagnostic must survive it.
  assert.deepEqual(
    diagnosticsOf('/Users/ada/My Code/petri/harness/loop.ts(9,2): error TS2304: Cannot find name.'),
    ['harness/loop.ts(9,2) TS2304'],
  );
  assert.deepEqual(mechanicalIdentity(DETAIL.mechanical), { cls: 'ok', diagnostics: [] });
});

/* -------------------------------------------------------------------------- */
/* (c) Local tree state                                                        */
/* -------------------------------------------------------------------------- */

test('the local digest and the prompt it produced are outside the id', () => {
  const expected = nodeIdFor(DETAIL);
  for (const digestHash of ['', '00000000', 'deadbeef', 'ffffffffffffffff']) {
    assert.equal(nodeIdFor(withProvenance({ digestHash })), expected, `digest ${digestHash} changed the id`);
  }
  for (const promptHash of ['0'.repeat(64), '1'.repeat(64), 'a'.repeat(64)]) {
    assert.equal(nodeIdFor(withProvenance({ promptHash })), expected, 'the prompt hash changed the id');
  }

  // Who proposed it, and with which seed, still count.
  assert.notEqual(nodeIdFor(withProvenance({ source: 'human' })), expected);
  assert.notEqual(nodeIdFor(withProvenance({ model: 'claude-sonnet-5' })), expected);
  assert.notEqual(nodeIdFor(withProvenance({ seed: 8 })), expected);
  assert.equal(Object.keys(provenanceIdentity(DETAIL.provenance)).sort().join(','), 'model,seed,source');
});

/* -------------------------------------------------------------------------- */
/* The whole split, swept                                                      */
/* -------------------------------------------------------------------------- */

test('every observation field is outside the id, and every identity field is inside', () => {
  const expected = nodeIdFor(DETAIL);

  // Everything detailObservation reports, changed at once. One experiment.
  const otherMachine: NodeDetail = {
    ...DETAIL,
    claimedRuns: DETAIL.claimedRuns.map((r) => ({ ...r, wallMs: r.wallMs * 37 + 11 })),
    provenance: { ...DETAIL.provenance, promptHash: 'b'.repeat(64), digestHash: 'cafebabe' },
    mechanical: { ...DETAIL.mechanical, command: '/opt/tsc -p /tmp/xyz/tsconfig.json', exitCode: 3 },
  };
  assert.equal(nodeIdFor(otherMachine), expected);
  assert.notDeepEqual(detailObservation(otherMachine), detailObservation(DETAIL));
  assert.deepEqual(
    Object.keys(detailObservation(DETAIL)).sort(),
    ['claimedWallMs', 'command', 'digestHash', 'evidence', 'exitCode', 'promptHash'],
  );
  // The record with the observations in it is still a valid, storable detail.
  assert.equal(NodeDetailSchema.safeParse(otherMachine).success, true);

  // Every identity field, one at a time.
  const identityEdits: NodeDetail[] = [
    { ...DETAIL, mode: 'live' },
    { ...DETAIL, derivedAreas: ['loop'] },
    { ...DETAIL, areaMismatch: true },
    { ...DETAIL, claimedMedianBp: 6500 },
    { ...DETAIL, parentHarness: 'f'.repeat(64) },
    { ...DETAIL, proposal: { ...DETAIL.proposal, motif: 'other-motif' } },
    { ...DETAIL, proposal: { ...DETAIL.proposal, whyNotUntested: 'No fixtures yet.' } },
    { ...DETAIL, mechanical: { ...DETAIL.mechanical, cls: 'rule-violation' } },
  ];
  for (const edited of identityEdits) {
    assert.notEqual(nodeIdFor(edited), expected, 'an identity field left the id unchanged');
  }
});

test('filling in the node back-reference still changes nothing', () => {
  assert.equal(detailIdOf({ ...DETAIL, node: 'a'.repeat(64) }), detailIdOf(DETAIL));
});

/* -------------------------------------------------------------------------- */
/* The real compiler, in real directories                                      */
/* -------------------------------------------------------------------------- */

/** A harness that cannot compile. The diagnostic is the point of the test. */
const BROKEN = 'export const answer: number = "not a number";\n';

interface Compiled { readonly nodeId: string; readonly diagnostics: readonly string[]; }

/** Build one candidate the way `petri evolve` does: write, compile, hash. */
function compileAt(workspace: string): Compiled {
  mkdirSync(join(workspace, 'harness'), { recursive: true });
  writeFileSync(join(workspace, 'harness', 'index.ts'), BROKEN, 'utf8');

  const tc = typecheckScratch({ workspace, repoRoot: REPO_ROOT });
  const detail = withMechanical({
    cls: 'typecheck-failed',
    command: tc.command.slice(0, 400),
    exitCode: tc.exitCode,
    evidence: tc.output.slice(0, 4000),
  });
  return { nodeId: nodeIdFor(detail), diagnostics: tc.diagnostics };
}

test('the same experiment hashes to the same id from two different working directories', () => {
  const roots = [
    mkdtempSync(join(tmpdir(), 'petri-cwd-one-')),
    mkdtempSync(join(tmpdir(), 'petri-a-much-longer-second-checkout-')),
  ];
  const here = process.cwd();
  const results: Compiled[] = [];
  try {
    for (const root of roots) {
      // A real run: a new UUID under a checkout at another absolute path, and
      // the process sitting in a different working directory each time.
      const workspace = join(root, 'project', '.petri', 'scratch', randomUUID());
      mkdirSync(workspace, { recursive: true });
      process.chdir(root);
      results.push(compileAt(workspace));
    }
  } finally {
    process.chdir(here);
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  }

  assert.deepEqual(
    results[0]!.diagnostics, ['harness/index.ts(1,14) TS2322'],
    'the compiler did not run, so this test proved nothing',
  );
  assert.deepEqual(results[1]!.diagnostics, results[0]!.diagnostics);
  assert.equal(results[0]!.nodeId, results[1]!.nodeId, 'the working directory leaked into the node id');
});

test('the same experiment hashes to the same id under two different home directories', () => {
  const env = process.env;
  const saved = { home: env['HOME'], profile: env['USERPROFILE'] };
  const homes = [
    mkdtempSync(join(tmpdir(), 'petri-home-ada-')),
    mkdtempSync(join(tmpdir(), 'petri-home-grace-with-a-longer-name-')),
  ];
  const results: Compiled[] = [];
  try {
    for (const home of homes) {
      // Everything a home directory decides: the value of $HOME the child
      // process inherits, and the absolute path of the checkout below it.
      env['HOME'] = home;
      env['USERPROFILE'] = home;
      const workspace = join(home, 'code', 'petri', '.petri', 'scratch', randomUUID());
      mkdirSync(workspace, { recursive: true });
      results.push(compileAt(workspace));
    }
  } finally {
    if (saved.home === undefined) delete env['HOME']; else env['HOME'] = saved.home;
    if (saved.profile === undefined) delete env['USERPROFILE']; else env['USERPROFILE'] = saved.profile;
    for (const home of homes) rmSync(home, { recursive: true, force: true });
  }

  assert.deepEqual(
    results[0]!.diagnostics, ['harness/index.ts(1,14) TS2322'],
    'the compiler did not run, so this test proved nothing',
  );
  assert.equal(results[0]!.nodeId, results[1]!.nodeId, 'the home directory leaked into the node id');
});
