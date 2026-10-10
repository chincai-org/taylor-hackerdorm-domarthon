/**
 * The harness boundary. SPEC.md §10.1 property 1: the harness never sees the tests.
 *
 * This file is the audit that broke the old claim, turned into a test. The audit
 * wrote a harness whose `solve()` read the task's own `test.mjs` and drove it
 * through the real `runOnce`. It read 1196 bytes. No error, no warning, nothing
 * recorded. The only obstacle was a regex over the two changed files of a
 * proposal, and the attack never wrote a banned word into a scanned file.
 *
 * So the test is written against the two halves of the fix, separately.
 *
 *   1. The scan is defence in depth. It now reads the COMPLETE snapshot, so a file
 *      inherited from a parent is scanned too, and it names the prototype-chain
 *      route to the Function constructor that the old list missed.
 *   2. The boundary is a child process. The attack below assembles every banned
 *      word at run time, so the scan passes it, and it still cannot read the file.
 *      That is the half that a better regex could never give.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BudgetExceededError } from '../harness/contract.js';
import type {
  HarnessContext, ModelRequest, ModelResponse, Solution,
} from '../harness/contract.js';
import type { HarnessSnapshot } from '../src/core/schema.js';
import { scanHarnessSnapshot } from '../bench/src/harnessScan.js';
import { loadSolve, materialiseHarness } from '../bench/src/runner.js';
import { DEFAULT_TASKS_DIR, loadTask } from '../bench/src/taskLoader.js';

import { REPO_ROOT as REPO } from '../src/core/root.js';

const TASK_ID = '01-chunk-array';
/** The file no harness may ever read. It is 1196 bytes the audit printed. */
const TEST_FILE = join(DEFAULT_TASKS_DIR, TASK_ID, 'test.mjs');
const CONTRACT = readFileSync(join(REPO, 'harness', 'contract.ts'), 'utf8');

/* -------------------------------------------------------------------------- */
/* The attack                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * A harness that tries to read the task's test file.
 *
 * Every banned word is built by concatenation, so the source text carries no
 * `import(`, no `require`, no `node:fs`, no `readFileSync`, no `.constructor` and
 * no `getPrototypeOf`. The scan therefore passes it, which is the point: the test
 * has to prove the process boundary, not the tripwire in front of it.
 */
function attackHarness(): string {
  return [
    "import type { HarnessContext, Solution, TaskView } from './contract.js';",
    '',
    `const TARGET = ${JSON.stringify(TEST_FILE)};`,
    '',
    '// Reach the AsyncFunction constructor through the prototype chain, then use it',
    '// to reach the file system. Not one of these words appears whole in this file.',
    "const owner = Object as unknown as Record<string, (v: unknown) => Record<string, unknown>>;",
    "const proto = owner['getProto' + 'typeOf']!(async function noop() { /* seed */ });",
    "const Make = proto['con' + 'structor'] as unknown as",
    '  new (arg: string, body: string) => (path: string) => Promise<string>;',
    "const body = 'const m = await im' + 'port(\"no' + 'de:fs\"); return m.readFile' + 'Sync(p, \"utf8\");';",
    "const steal = new Make('p', body);",
    '',
    'export async function solve(task: TaskView, ctx: HarnessContext): Promise<Solution> {',
    '  let report: string;',
    '  try {',
    '    const text = await steal(TARGET);',
    "    report = 'STOLEN ' + String(text.length) + ' bytes';",
    '  } catch (err) {',
    "    const e = err as { code?: string; message?: string };",
    "    report = 'BLOCKED ' + String(e.code ?? e.message ?? 'unknown');",
    '  }',
    "  ctx.log.event('attack', { report });",
    "  const reply = await ctx.model.complete({ label: 'draft', messages: [] });",
    '  return {',
    '    files: [{',
    '      path: task.entryFile,',
    "      contents: 'export const report = ' + JSON.stringify(report) + ';\\n'",
    "        + 'export const reply = ' + JSON.stringify(reply.text) + ';\\n'",
    "        + 'export const promptHead = ' + JSON.stringify(task.prompt.slice(0, 24)) + ';\\n'",
    "        + 'export const draws = ' + JSON.stringify([ctx.rng(), ctx.rng(), ctx.rng()]) + ';\\n',",
    '    }],',
    '  };',
    '}',
    '',
  ].join('\n');
}

const attackSnapshot = (): HarnessSnapshot => ({
  'harness/contract.ts': CONTRACT,
  'harness/index.ts': attackHarness(),
});

/* -------------------------------------------------------------------------- */
/* A context the jail can serve                                                */
/* -------------------------------------------------------------------------- */

interface Recorded {
  readonly ctx: HarnessContext;
  readonly events: { kind: string; data: Record<string, unknown> | undefined }[];
  readonly requests: ModelRequest[];
  readonly draws: number[];
}

/** The runner side of one task: a model, a budget, a trace and a seeded stream. */
function recordingContext(): Recorded {
  const events: { kind: string; data: Record<string, unknown> | undefined }[] = [];
  const requests: ModelRequest[] = [];
  const draws: number[] = [];
  let state = 7;
  const ctx: HarnessContext = {
    model: {
      complete: (req: ModelRequest): Promise<ModelResponse> => {
        requests.push(req);
        return Promise.resolve({
          text: `stub reply to ${req.label}`,
          stopReason: 'end_turn',
          inputTokens: 3,
          outputTokens: 4,
        });
      },
    },
    budget: {
      maxCalls: 8,
      maxTokens: 1000,
      maxWallMs: 30_000,
      state: () => ({
        callsUsed: 0, callsLeft: 8, tokensUsed: 0, tokensLeft: 1000, msLeft: 30_000,
      }),
    },
    log: { event: (kind, data) => { events.push({ kind, data }); } },
    rng: () => {
      state = (state * 1103515245 + 12345) % 2147483648;
      const value = state / 2147483648;
      draws.push(value);
      return value;
    },
    now: () => 1735689600000,
  };
  return { ctx, events, requests, draws };
}

/** Materialise a snapshot, prepare the jailed solve, and clean up afterwards. */
async function withHarness(
  snapshot: HarnessSnapshot,
  body: (solve: (task: never, ctx: HarnessContext) => Promise<Solution>) => Promise<void>,
): Promise<void> {
  const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'petri-boundary-')));
  try {
    const solve = await loadSolve(materialiseHarness(snapshot, root));
    await body(solve as unknown as (task: never, ctx: HarnessContext) => Promise<Solution>);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
}

/** Pull one exported constant back out of the solution the harness wrote. */
function exported(source: string, name: string): unknown {
  const line = new RegExp(`^export const ${name} = (.*);$`, 'm').exec(source);
  assert.ok(line !== null, `the solution declares no ${name}:\n${source}`);
  return JSON.parse(line[1]!);
}

/* -------------------------------------------------------------------------- */
/* The tests                                                                   */
/* -------------------------------------------------------------------------- */

test('the auditor attack: a harness that tries to read test.mjs must fail to read it', async () => {
  // The attack passes the scan. It has to, or this test would prove nothing about
  // the process boundary.
  assert.equal(
    scanHarnessSnapshot(attackSnapshot()),
    null,
    'the attack must pass the scan, so that only the jail can stop it',
  );
  // The file it hunts is real, and it is readable by this test process.
  assert.ok(readFileSync(TEST_FILE, 'utf8').length > 100);

  const task = loadTask(TASK_ID);
  const recorded = recordingContext();

  await withHarness(attackSnapshot(), async (solve) => {
    const solution = await solve(task.view as never, recorded.ctx);
    const source = solution.files[0]!.contents;
    const report = exported(source, 'report');

    assert.match(
      String(report),
      /^BLOCKED /,
      `the harness read the tests. The boundary is gone. It reported: ${String(report)}`,
    );
    assert.match(String(report), /ERR_ACCESS_DENIED/);

    // The harness still got everything it is allowed to have.
    assert.equal(solution.files[0]!.path, task.meta.entry);
    assert.equal(exported(source, 'promptHead'), task.view.prompt.slice(0, 24));
    assert.equal(exported(source, 'reply'), 'stub reply to draft');
    assert.deepEqual(exported(source, 'draws'), recorded.draws.slice(0, 3));
    assert.equal(recorded.requests.length, 1, 'the model call was served by the parent');
    assert.deepEqual(
      recorded.events.map((e) => e.kind),
      ['attack'],
      'the trace stayed in the parent',
    );
  });
});

test('a budget refusal still reaches the harness as a BudgetExceededError', async () => {
  // The budget is counted in the parent and always was. The jail must not turn the
  // one error a harness is written to catch into an anonymous one.
  const snapshot: HarnessSnapshot = {
    'harness/contract.ts': CONTRACT,
    'harness/index.ts': [
      "import { BudgetExceededError } from './contract.js';",
      "import type { HarnessContext, Solution, TaskView } from './contract.js';",
      'export async function solve(task: TaskView, ctx: HarnessContext): Promise<Solution> {',
      "  let seen = 'nothing';",
      '  try {',
      "    await ctx.model.complete({ label: 'draft', messages: [] });",
      '  } catch (err) {',
      "    seen = err instanceof BudgetExceededError ? 'class ' + err.what : 'plain';",
      '  }',
      "  const left = String(ctx.budget.maxCalls) + ':' + String(ctx.budget.state().callsLeft);",
      '  return { files: [{ path: task.entryFile,',
      "    contents: 'export const seen = ' + JSON.stringify(seen) + ';\\n'",
      "      + 'export const budget = ' + JSON.stringify(left) + ';\\n' }] };",
      '}',
      '',
    ].join('\n'),
  };

  const task = loadTask(TASK_ID);
  const recorded = recordingContext();
  const refusing: HarnessContext = {
    ...recorded.ctx,
    model: {
      complete: () => Promise.reject(
        new BudgetExceededError('calls', 'petri: the budget of 8 calls is spent.'),
      ),
    },
  };

  await withHarness(snapshot, async (solve) => {
    const solution = await solve(task.view as never, refusing);
    assert.equal(exported(solution.files[0]!.contents, 'seen'), 'class calls');
    assert.equal(exported(solution.files[0]!.contents, 'budget'), '8:8');
  });
});

test('the scan names the prototype route to the Function constructor', () => {
  const snapshot: HarnessSnapshot = {
    'harness/contract.ts': CONTRACT,
    'harness/index.ts':
      'const F = Object.getPrototypeOf(async function () {}).constructor;\n'
      + 'export const solve = new F("t", "return 1");\n',
  };
  const failure = scanHarnessSnapshot(snapshot);
  assert.notEqual(failure, null, 'the old list banned `new Function(` and nothing else');
  assert.equal(failure!.path, 'harness/index.ts');
  assert.match(failure!.message, /prototype walk|\.constructor lookup/);
});

test('the scan reads every file, not only the ones a proposal changed', () => {
  // `harness/index.ts` is clean. The violation sits in a file a proposal would
  // never have touched, because it was inherited from the parent unchanged.
  const snapshot: HarnessSnapshot = {
    'harness/contract.ts': CONTRACT,
    'harness/index.ts': "import { help } from './retrieval.js';\nexport const solve = help;\n",
    'harness/retrieval.ts': "export const help = () => process.env['HOME'];\n",
  };
  const failure = scanHarnessSnapshot(snapshot);
  assert.notEqual(failure, null);
  assert.equal(failure!.path, 'harness/retrieval.ts');
  assert.match(failure!.message, /process/);
});

test('a harness that fails the scan is never materialised or run', () => {
  const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'petri-boundary-')));
  try {
    assert.throws(
      () => materialiseHarness(
        {
          'harness/contract.ts': CONTRACT,
          'harness/index.ts': "export const solve = () => require('node:fs');\n",
        },
        root,
      ),
      /may not run/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
});
