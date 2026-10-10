/**
 * One whole pass over the benchmark. SPEC.md §10.8 and §10.9.
 *
 * `runOnce` walks every task, asks the harness for a solution, sandboxes it, and
 * aggregates one `RunResult`. It never retries and it never scores a task twice.
 *
 * A crash is classified, and the two classes are handled differently.
 *
 * Class A — the harness's fault. It scores 0. It is never retried. This covers every
 * sandbox outcome other than `pass`, a harness that returns an empty string, a
 * harness that returns non-ESM text, and any exception thrown inside `solve()`.
 *
 * Class B — infrastructure below the harness. It is discarded and retried by
 * `median.ts`. Only the closed list in INFRA qualifies. Anything not on the list is
 * Class A. Uncertainty resolves to Class A, which biases against inflating a score.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { byteCompare, sha256Hex } from '../../src/core/canonical.js';
import { scoreBp } from '../../src/core/schema.js';
import type { HarnessSnapshot, Mode } from '../../src/core/schema.js';
import type { HarnessContext, Solution, TaskView } from '../../harness/contract.js';
import { compileHarness, probeHarness, solveInJail } from './harnessJail.js';
import { ENTRY_FILE, HARNESS_PREFIX, scanHarnessSnapshot } from './harnessScan.js';
import { runInSandbox } from './sandbox.js';
import { DEFAULT_TASKS_DIR, loadTask, listTaskIds, type LoadedTask } from './taskLoader.js';
import { BenchError, type EnvDescriptor, type RunResult, type TaskOutcome } from './schema.js';

export const RUN_PROTOCOL = 'petri/run/1';

const INFRA = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN',
  'EPIPE', 'ENOSPC', 'ENOMEM', 'EMFILE',
]);

/** Class B, and only Class B. Everything else is the harness's fault. */
export function isInfrastructure(e: unknown): boolean {
  const err = e as { status?: number; code?: string };
  if (typeof err?.status === 'number' && (err.status === 429 || err.status >= 500)) return true;
  return typeof err?.code === 'string' && INFRA.has(err.code);
}

/**
 * A Class B failure. `median.ts` discards the attempt, records the reason and retries.
 * The failure is below the harness, so scoring it zero would measure a provider's
 * uptime rather than harness design.
 */
export class InfrastructureError extends Error {
  readonly kind = 'infrastructure';
  readonly taskId: string;
  constructor(taskId: string, cause: unknown) {
    super(`infrastructure failure on task ${taskId}: ${describe(cause)}`);
    this.name = 'InfrastructureError';
    this.taskId = taskId;
    this.cause = cause;
  }
}

/**
 * An error that must stop the whole command, not score one task zero.
 * A replay fixture miss is the case SPEC.md §10.10 rule 1 names: it is a hard error
 * and it never falls back. A producer marks it with `fatal: true` or the name
 * `FixtureMissError`.
 */
export function isFatal(e: unknown): boolean {
  if (e === null || typeof e !== 'object') return false;
  const err = e as { fatal?: unknown; name?: unknown };
  return err.fatal === true || err.name === 'FixtureMissError';
}

/** The frozen entry point of a materialised harness. SPEC.md §11.2. */
export type SolveFn = (task: TaskView, ctx: HarnessContext) => Promise<Solution>;

/**
 * Build the per-task context. `HarnessContext` is fresh for every task, so a harness
 * carries no state between tasks. The model client, the budget and the logger are
 * owned by `src/model/client.ts`, which is why the runner takes a factory.
 */
export type ContextFactory = (task: TaskView, attemptIndex: number, seed: string) => HarnessContext;

export interface RunOnceInput {
  readonly solve: SolveFn;
  readonly makeContext: ContextFactory;
  /** The node under measurement, or "root". */
  readonly node: string;
  readonly harness: string;
  readonly bench: string;
  readonly mode: Mode;
  readonly attemptIndex: number;
  /** Hex64. `seedFor(candidateNodeId, attemptIndex)`. It fixes the task order. */
  readonly seed: string;
  readonly env: EnvDescriptor;
  readonly tasksDir?: string | undefined;
  /** A subset, for `petri bench run --tasks 01,07`. Default: every task. */
  readonly taskIds?: readonly string[] | undefined;
  /** Loaded tasks, when the caller already has them. Default: load from disk. */
  readonly tasks?: readonly LoadedTask[] | undefined;
}

/**
 * Run the benchmark once.
 *
 * Throws `InfrastructureError` on a Class B failure, so the median layer can discard
 * the attempt. Every Class A failure scores its task zero and the run continues.
 */
export async function runOnce(input: RunOnceInput): Promise<RunResult> {
  const tasks = input.tasks !== undefined ? [...input.tasks] : loadTasks(input);
  tasks.sort((a, b) => byteCompare(a.id, b.id));

  const startedAt = Date.now();
  const outcomes = new Map<string, TaskOutcome>();

  // The seed fixes the order tasks are STARTED in, so two honest verifiers work
  // through the same list in the same order. Several tasks run at once, because
  // each one is its own pair of child processes and cannot see the others: the
  // answer and the tests of one task decide its outcome alone. The result array
  // is ordered by task id either way, so the score never depends on the timing.
  const order = seededOrder(tasks.length, input.seed);
  const lanes = Math.max(1, Math.min(taskConcurrency(), order.length));
  let next = 0;
  let failure: unknown = null;

  const lane = async (): Promise<void> => {
    for (;;) {
      if (failure !== null) return;
      const index = order[next];
      next += 1;
      if (index === undefined) return;
      const task = tasks[index];
      if (task === undefined) continue;
      try {
        outcomes.set(task.id, await runTask(task, input));
      } catch (err) {
        // The first failure wins. A Class B failure makes the median layer
        // discard the whole attempt, so the other lanes stop as well.
        failure ??= err;
        return;
      }
    }
  };
  await Promise.all(Array.from({ length: lanes }, () => lane()));
  if (failure !== null) throw failure;

  const taskOutcomes = tasks.map((task) => {
    const outcome = outcomes.get(task.id);
    if (outcome === undefined) {
      throw new BenchError(`petri bench: task ${task.id} produced no outcome`, 5);
    }
    return outcome;
  });
  const passed = taskOutcomes.filter((t) => t.passed).length;
  const total = taskOutcomes.length;

  return {
    protocol: RUN_PROTOCOL,
    runId: randomUUID(),
    node: input.node,
    harness: input.harness,
    bench: input.bench,
    mode: input.mode,
    attemptIndex: input.attemptIndex,
    seed: input.seed,
    startedAt,
    passed,
    total,
    scoreBp: scoreBp(passed, total),
    tasks: taskOutcomes,
    tokens: taskOutcomes.reduce((sum, t) => sum + t.tokens, 0),
    wallMs: Date.now() - startedAt,
    tampered: taskOutcomes.some((t) => t.outcome === 'tampered'),
    env: input.env,
  };
}

/**
 * How many tasks run at once. PETRI_TASK_CONCURRENCY overrides it, and 1 gives
 * the old one-at-a-time behaviour. It changes the wall clock only: every task
 * runs in its own child process, and the tests decide the outcome.
 */
export function taskConcurrency(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env['PETRI_TASK_CONCURRENCY'] ?? '');
  if (Number.isInteger(raw) && raw >= 1 && raw <= 32) return raw;
  return 6;
}

function loadTasks(input: RunOnceInput): LoadedTask[] {
  const dir = input.tasksDir ?? DEFAULT_TASKS_DIR;
  const ids = [...(input.taskIds ?? listTaskIds(dir))];
  return ids.map((id) => loadTask(id, dir));
}

/** One task: ask the harness, then sandbox what it wrote. */
async function runTask(task: LoadedTask, input: RunOnceInput): Promise<TaskOutcome> {
  const ctx = input.makeContext(task.view, input.attemptIndex, input.seed);
  const tokensBefore = tokensUsed(ctx);
  const harnessStart = Date.now();

  let solution: Solution | null = null;
  let harnessError: string | null = null;
  try {
    solution = await input.solve(task.view, ctx);
  } catch (err) {
    if (isFatal(err)) throw err;
    if (isInfrastructure(err)) throw new InfrastructureError(task.id, err);
    harnessError = describe(err);
  }

  const harnessMs = Date.now() - harnessStart;
  const tokens = Math.max(0, tokensUsed(ctx) - tokensBefore);

  if (solution === null) {
    return classA(task.id, harnessMs, tokens, ctx, `the harness threw: ${harnessError ?? 'unknown'}`);
  }

  const source = entrySourceOf(solution, task.meta.entry);
  if (source === null) {
    return classA(task.id, harnessMs, tokens, ctx, `the harness wrote no ${task.meta.entry}`);
  }
  if (source.trim().length === 0) {
    return classA(task.id, harnessMs, tokens, ctx, `the harness returned an empty ${task.meta.entry}`);
  }

  let sandbox;
  try {
    sandbox = await runInSandbox({
      solutionSource: source,
      entry: task.meta.entry,
      specSource: task.specSource,
      timeoutMs: task.meta.timeoutMs,
    });
  } catch (err) {
    // A spawn failure is the machine, not the harness. EMFILE and ENOSPC are Class B.
    if (isInfrastructure(err)) throw new InfrastructureError(task.id, err);
    throw err;
  }

  return {
    taskId: task.id,
    outcome: sandbox.outcome,
    passed: sandbox.passed,
    exitCode: sandbox.exitCode,
    signal: sandbox.signal,
    assertions: sandbox.assertions,
    wallMs: sandbox.wallMs,
    harnessMs,
    tokens,
  };
}

/** Class A. The task scores zero and the run continues. The trace records why. */
function classA(
  taskId: string,
  harnessMs: number,
  tokens: number,
  ctx: HarnessContext,
  reason: string,
): TaskOutcome {
  logEvent(ctx, 'harness-failure', { taskId, reason });
  return {
    taskId,
    outcome: 'fail',
    passed: false,
    exitCode: null,
    signal: null,
    assertions: null,
    wallMs: 0,
    harnessMs,
    tokens,
  };
}

/**
 * The file the tests will import, or null when the harness never wrote it.
 * The name must match. PROMPT.md names the file, and the benchmark measures whether
 * a harness reads carefully. A misnamed file is Class A and scores zero.
 */
function entrySourceOf(solution: Solution, entry: string): string | null {
  for (const file of solution.files) {
    if (file.path === entry) return file.contents;
  }
  return null;
}

/**
 * Materialise a harness snapshot on disk, under `dir`.
 *
 * The snapshot keys already carry the `harness/` prefix of SPEC.md section 3.2, so
 * `dir/harness/index.ts` is the entry point the jail then loads. Content is
 * written verbatim: the bytes on disk are the bytes the harness id names.
 *
 * The COMPLETE snapshot is scanned first, every time. A file inherited unchanged
 * from a parent is scanned here exactly like a file the proposal touched.
 */
export function materialiseHarness(snapshot: HarnessSnapshot, dir: string): string {
  assertHarnessMayRun(snapshot, dir);
  for (const [path, contents] of Object.entries(snapshot)) {
    if (path.startsWith('/') || path.includes('..') || path.includes('\\')) {
      throw new BenchError(`petri bench: refusing to write the harness path ${path}`, 3);
    }
    const file = join(dir, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, contents, 'utf8');
  }
  return join(dir, 'harness');
}

/** The complete-snapshot scan, as a hard gate. It is defence in depth, not the boundary. */
function assertHarnessMayRun(snapshot: HarnessSnapshot, where: string): void {
  const bad = scanHarnessSnapshot(snapshot);
  if (bad !== null) {
    throw new BenchError(
      `petri bench: the harness at ${where} may not run: ${bad.message}`,
      3,
    );
  }
}

/**
 * Prepare the frozen `solve` of a materialised harness directory. SPEC.md §11.2.
 *
 * The returned function does NOT run the harness in this process. Every call
 * spawns a jailed child: see `harnessJail.ts` for what that child can and cannot
 * reach. This function reads the harness sources, scans the complete snapshot, and
 * loads the harness once in a jailed probe to prove it exports `solve`.
 *
 * It used to `import()` the harness into the runner's own process, where a harness
 * had full Node privileges and could read `bench/tasks/<id>/test.mjs` directly.
 */
export async function loadSolve(harnessDir: string): Promise<SolveFn> {
  const files = readHarnessDir(harnessDir);

  // §6.9: the parent side of a root node is the EMPTY harness. It exports no
  // solve, so every task scores zero by construction and the report doubles as a
  // sandbox canary. An empty directory is that harness, not a broken tool.
  if (Object.keys(files).length === 0) {
    return () => Promise.reject(new Error('the empty harness exports no solve function'));
  }

  assertHarnessMayRun(files, harnessDir);
  if (files[ENTRY_FILE] === undefined) {
    throw new BenchError(`petri bench: no harness entry point at ${join(harnessDir, 'index.ts')}`, 2);
  }

  // The types are stripped once, here, and the JavaScript is what every jail runs.
  // The child therefore needs no loader, no worker thread and no read grant over
  // `node_modules`: the jail holds the harness and the prompt, and nothing else.
  const compiled = compileHarness(files);

  const probe = await probeHarness(compiled);
  if (!probe.ok) {
    throw new BenchError(`petri bench: the harness at ${harnessDir} did not load: ${probe.reason}`, 5);
  }

  return (task: TaskView, ctx: HarnessContext): Promise<Solution> =>
    solveInJail({ files: compiled, task, ctx });
}

/**
 * Read a materialised harness directory back into a snapshot.
 *
 * Keys carry the `harness/` prefix of SPEC.md §3.2, so the snapshot read here and
 * the snapshot the harness id names are the same shape and scan the same way.
 * A missing directory is the empty harness, not an error.
 */
export function readHarnessDir(harnessDir: string): HarnessSnapshot {
  if (!existsSync(harnessDir) || !statSync(harnessDir).isDirectory()) return {};
  const out: Record<string, string> = {};
  const walk = (abs: string, rel: string): void => {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const childAbs = join(abs, entry.name);
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(childAbs, childRel);
        continue;
      }
      // A symlink, a socket or a device is not a source file. The scan below
      // refuses anything that is not a flat `harness/<name>.ts` in any case.
      if (!entry.isFile()) continue;
      out[`${HARNESS_PREFIX}${childRel}`] = readFileSync(childAbs, 'utf8');
    }
  };
  walk(harnessDir, '');
  return out;
}

/**
 * A deterministic task order, derived from the run seed.
 * Fisher-Yates, with each swap index taken from sha256. Every honest verifier walks
 * the tasks in the same order, on every machine and in every language.
 */
export function seededOrder(count: number, seed: string): number[] {
  const order = Array.from({ length: count }, (_, i) => i);
  for (let i = count - 1; i > 0; i -= 1) {
    const digest = sha256Hex(`petri/bench/order/1|${seed}|${i}`);
    const j = Number(BigInt(`0x${digest.slice(0, 13)}`) % BigInt(i + 1));
    const swap = order[i]!;
    order[i] = order[j]!;
    order[j] = swap;
  }
  return order;
}

/** The runner's own budget accounting. More trustworthy than a self-reported number. */
function tokensUsed(ctx: HarnessContext): number {
  try {
    const used = ctx.budget.state().tokensUsed;
    return Number.isFinite(used) && used > 0 ? Math.trunc(used) : 0;
  } catch {
    return 0;
  }
}

function logEvent(ctx: HarnessContext, kind: string, data: Record<string, unknown>): void {
  try {
    ctx.log.event(kind, data);
  } catch {
    // A broken logger must never change a score.
  }
}

function describe(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  if (typeof e === 'string') return e;
  try {
    return JSON.stringify(e) ?? String(e);
  } catch {
    return String(e);
  }
}
