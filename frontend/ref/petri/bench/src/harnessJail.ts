/**
 * The harness jail. SPEC.md §10.1 property 1.
 *
 * THIS FILE IS THE BOUNDARY. Everything else about "the harness never sees the
 * tests" is documentation.
 *
 * What was wrong before. The runner imported the harness into its own process.
 * A harness is ordinary TypeScript with full Node privileges, so `solve()` could
 * call `readFileSync` on the task's own `test.mjs` and drive the answer straight
 * out of the assertions. An audit did exactly that and read 1196 bytes. No error,
 * no warning, nothing recorded. The only obstacle was a regex over the changed
 * files of a proposal, and a regex over source text cannot stop code that builds
 * its own strings.
 *
 * What is here now. The harness runs in a child process with:
 *
 *   1. `cwd` set to a fresh jail directory that holds the harness sources and one
 *      `task/` folder: PROMPT.md, the entry file NAME, the exported symbol names,
 *      the constraints and the starter files. The tests are not in it.
 *   2. `--permission` with a single `--allow-fs-read` grant over that directory.
 *      Every other path on the machine, `bench/tasks/**` included, answers
 *      ERR_ACCESS_DENIED. The grant covers the whole process, so a prototype-chain
 *      Function constructor, a dynamic import, `process.binding`, a worker thread
 *      and a second process are all denied the same way.
 *   3. No write grant at all. The solution comes back over the IPC channel, so the
 *      test file does not exist anywhere this process can reach, at any point in
 *      its life.
 *   4. The program itself piped over stdin, never written to disk, so nothing in
 *      the jail can rewrite the bootstrap before it runs.
 *
 * The harness still reaches the model, the budget and the trace, because those are
 * the runner's to lend. They travel over the IPC channel and are served by the real
 * objects in the parent, which is where the budget has always been enforced. The
 * child keeps no privilege of its own: `process.send` is captured and deleted
 * before the harness loads, so the harness cannot answer its own model calls or
 * forge a result.
 *
 * Layer L3. It imports L0 and `harness/contract.ts`. Nothing else.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { HarnessSnapshot } from '../../src/core/schema.js';
import type {
  HarnessContext, ModelRequest, ModelResponse, Solution, TaskView,
} from '../../harness/contract.js';
import { BenchError } from './schema.js';

/** Extra time the parent gives the child beyond the wall budget, before SIGKILL. */
export const JAIL_GRACE_MS = 5000;

/** Extra grace after the hard timeout before the parent force-settles. */
const WATCHDOG_GRACE_MS = 2000;

/** How long a load probe may take. Module-level harness code should be instant. */
export const PROBE_TIMEOUT_MS = 30_000;

/**
 * How many random numbers the parent draws for one task, out of the real
 * `ctx.rng`, and hands to the child up front.
 *
 * `Budget.state()` and `rng()` are synchronous, so neither can cross a process
 * boundary on demand. The budget is mirrored (below). The random stream is drawn
 * ahead instead, from the ONE seeded generator in `src/model/client.ts`, so the
 * harness sees exactly the stream it would have seen in process and this file adds
 * no second generator. A harness that draws more than this throws, loudly, and the
 * task scores zero the way any harness fault does.
 */
export const RNG_DRAWS = 4096;

/** Caps on what a child may hand back. A harness cannot exhaust the parent. */
export const MAX_SOLUTION_FILES = 64;
export const MAX_SOLUTION_BYTES = 1_000_000;
/** How much of the child's stderr survives into an error message. */
export const STDERR_TAIL_CHARS = 2000;

/** A starter file path, as `taskLoader.readStarterFiles` builds it. */
const STARTER_PATH_RE = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

/* -------------------------------------------------------------------------- */
/* TypeScript, stripped in the parent                                          */
/* -------------------------------------------------------------------------- */

/**
 * The slice of the TypeScript compiler this file uses.
 *
 * A harness snapshot is TypeScript, and the child runs with NO loader: no tsx, no
 * worker thread, no read grant over `node_modules`. So the parent strips the types
 * and writes plain JavaScript into the jail. Node's own type stripping cannot do
 * this job, because `harness/contract.ts` is frozen and declares a parameter
 * property, which is a transform and not an erasure.
 *
 * Stripping does not change what the harness does. It changes the bytes that run,
 * not the bytes the harness id names: the snapshot is still hashed, stored and
 * diffed as the TypeScript the author wrote.
 */
interface TypeScriptApi {
  transpileModule(
    input: string,
    options: {
      compilerOptions: Record<string, unknown>;
      fileName?: string;
      reportDiagnostics?: boolean;
    },
  ): { outputText: string };
  readonly ModuleKind: { readonly ESNext: number };
  readonly ScriptTarget: { readonly ES2022: number };
}

let compiler: TypeScriptApi | null = null;

function typescript(): TypeScriptApi {
  if (compiler === null) {
    compiler = createRequire(import.meta.url)('typescript') as TypeScriptApi;
  }
  return compiler;
}

/**
 * Strip the types off a harness snapshot.
 *
 * `harness/loop.ts` becomes `harness/loop.js`, and SPEC.md §11.1 rule 3 already
 * makes every harness import read `./loop.js`, so no specifier is rewritten and no
 * loader hook is needed inside the jail.
 */
export function compileHarness(files: HarnessSnapshot): HarnessSnapshot {
  const ts = typescript();
  const out: Record<string, string> = {};
  for (const [path, contents] of Object.entries(files)) {
    const compiled = ts.transpileModule(contents, {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
        isolatedModules: true,
      },
      fileName: path,
    });
    out[path.endsWith('.ts') ? `${path.slice(0, -3)}.js` : path] = compiled.outputText;
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* The wire                                                                    */
/* -------------------------------------------------------------------------- */

interface WireError {
  readonly name: string;
  readonly message: string;
  /** `BudgetExceededError.kind`, when the parent's model client threw one. */
  readonly kind?: string;
  readonly what?: string;
}

interface WireBudget {
  readonly callsUsed: number;
  readonly callsLeft: number;
  readonly tokensUsed: number;
  readonly tokensLeft: number;
  /** Unix ms. The child turns this into `msLeft` against its own clock. */
  readonly deadlineAt: number;
}

interface StartMessage {
  readonly t: 'start';
  readonly probe: boolean;
  readonly now: number;
  readonly rng: readonly number[];
  readonly limits: { maxCalls: number; maxTokens: number; maxWallMs: number };
  readonly budget: WireBudget;
}

type ToChild =
  | StartMessage
  | { readonly t: 'model-ok'; readonly id: number; readonly response: ModelResponse; readonly budget: WireBudget }
  | { readonly t: 'model-err'; readonly id: number; readonly error: WireError; readonly budget: WireBudget };

type FromChild =
  | { readonly t: 'model'; readonly id: number; readonly request: ModelRequest }
  | { readonly t: 'log'; readonly kind: string; readonly data: Record<string, unknown> }
  | { readonly t: 'done'; readonly solution: unknown }
  | { readonly t: 'failed'; readonly error: WireError }
  | { readonly t: 'probe'; readonly ok: boolean; readonly reason: string };

/* -------------------------------------------------------------------------- */
/* The bootstrap                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The program the child runs. It is a CONSTANT: nothing from the task, the
 * harness or the model is interpolated into it, so there is no injection surface
 * to reason about. Everything variable arrives over IPC or is read out of the
 * jail directory.
 *
 * Order matters. The channel is captured and removed, then the harness is
 * imported. A harness therefore never has a handle on the parent.
 *
 * It is plain ASCII JavaScript, built by string concatenation, with no template
 * literal and no escape sequence, so nothing here can be mangled twice.
 */
export function buildJailBootstrap(): string {
  return [
    "import { readFileSync } from 'node:fs';",
    '',
    '// 1. Take the channel, then take it away. The harness loads after this line,',
    '//    so it can neither answer its own model calls nor forge a result.',
    'const send = process.send.bind(process);',
    'const leave = process.disconnect.bind(process);',
    'delete process.send;',
    'delete process.disconnect;',
    'delete process.exit;',
    'delete process.reallyExit;',
    'delete process.abort;',
    'delete process.kill;',
    'delete process._kill;',
    '',
    'const fail = (err) => {',
    '  const e = err instanceof Error ? err : new Error(String(err));',
    '  try {',
    "    send({ t: 'failed', error: { name: e.name, message: e.message } });",
    '  } catch {',
    '    // The channel is gone. The parent settles on close instead.',
    '  }',
    '  try { leave(); } catch {}',
    '};',
    '',
    '// 2. Read the task out of the jail. This is everything the harness may see:',
    '//    the prompt, the entry file NAME, the symbol names, the constraints and',
    '//    the starter files. The tests are not here and are not reachable.',
    'function readTask() {',
    "  const meta = JSON.parse(readFileSync('task/view.json', 'utf8'));",
    '  const starterFiles = [];',
    '  for (const path of meta.starterPaths) {',
    "    starterFiles.push({ path, contents: readFileSync('task/starter/' + path, 'utf8') });",
    '  }',
    '  return {',
    '    taskId: meta.taskId,',
    "    prompt: readFileSync('task/PROMPT.md', 'utf8'),",
    '    entryFile: meta.entryFile,',
    '    exportedSymbols: meta.exportedSymbols,',
    '    starterFiles,',
    '    constraints: meta.constraints,',
    '    language: meta.language,',
    '  };',
    '}',
    '',
    '// 3. A Solution, reduced to data that survives the channel. A getter that',
    '//    throws, a proxy or a cycle fails here and scores the task zero.',
    'function plainSolution(value) {',
    "  if (value === null || typeof value !== 'object') {",
    "    throw new Error('solve did not return a Solution object');",
    '  }',
    '  if (!Array.isArray(value.files)) {',
    "    throw new Error('solve returned a Solution with no files array');",
    '  }',
    '  const files = [];',
    '  for (const file of value.files) {',
    "    if (file === null || typeof file !== 'object') {",
    "      throw new Error('a solution file is not an object');",
    '    }',
    '    files.push({ path: String(file.path), contents: String(file.contents) });',
    '  }',
    "  return typeof value.notes === 'string' ? { files, notes: value.notes } : { files };",
    '}',
    '',
    '// 4. The context. The model, the budget and the trace stay in the parent,',
    '//    which is where the budget has always been enforced.',
    'let nextCallId = 0;',
    'const pending = new Map();',
    'let budget = null;',
    'let draws = [];',
    'let drawIndex = 0;',
    '// The frozen contract ships in every snapshot, so the error class a harness',
    '// may catch is rebuilt as itself, so instanceof survives the boundary.',
    'let BudgetError = null;',
    '',
    'function rebuild(wire) {',
    "  if (wire.kind === 'budget-exceeded' && BudgetError !== null) {",
    '    return new BudgetError(wire.what, wire.message);',
    '  }',
    '  const err = new Error(wire.message);',
    '  err.name = wire.name;',
    "  if (typeof wire.kind === 'string') err.kind = wire.kind;",
    "  if (typeof wire.what === 'string') err.what = wire.what;",
    '  return err;',
    '}',
    '',
    "process.on('message', (msg) => {",
    "  if (msg.t === 'model-ok' || msg.t === 'model-err') {",
    '    budget = msg.budget;',
    '    const waiter = pending.get(msg.id);',
    '    if (waiter === undefined) return;',
    '    pending.delete(msg.id);',
    "    if (msg.t === 'model-ok') { waiter.resolve(msg.response); return; }",
    '    waiter.reject(rebuild(msg.error));',
    '    return;',
    '  }',
    "  if (msg.t !== 'start') return;",
    '  budget = msg.budget;',
    '  draws = msg.rng;',
    '  start(msg).catch(fail);',
    '});',
    '',
    'function makeContext(limits, nowMs) {',
    '  return {',
    '    model: {',
    '      complete(request) {',
    '        return new Promise((resolve, reject) => {',
    '          const id = (nextCallId += 1);',
    '          pending.set(id, { resolve, reject });',
    "          send({ t: 'model', id, request });",
    '        });',
    '      },',
    '    },',
    '    budget: {',
    '      maxCalls: limits.maxCalls,',
    '      maxTokens: limits.maxTokens,',
    '      maxWallMs: limits.maxWallMs,',
    '      state() {',
    '        return {',
    '          callsUsed: budget.callsUsed,',
    '          callsLeft: budget.callsLeft,',
    '          tokensUsed: budget.tokensUsed,',
    '          tokensLeft: budget.tokensLeft,',
    '          msLeft: Math.max(0, budget.deadlineAt - Date.now()),',
    '        };',
    '      },',
    '    },',
    '    log: {',
    '      event(kind, data) {',
    "        send({ t: 'log', kind: String(kind), data: data === undefined ? {} : data });",
    '      },',
    '    },',
    '    rng: () => {',
    '      if (drawIndex >= draws.length) {',
    "        throw new Error('the harness drew more than ' + draws.length + ' random numbers');",
    '      }',
    '      const value = draws[drawIndex];',
    '      drawIndex += 1;',
    '      return value;',
    '    },',
    '    now: () => nowMs,',
    '  };',
    '}',
    '',
    'async function start(msg) {',
    '  let mod;',
    '  try {',
    "    mod = await import('./harness/index.js');",
    '  } catch (err) {',
    '    const e = err instanceof Error ? err : new Error(String(err));',
    '    if (msg.probe) {',
    "      send({ t: 'probe', ok: false, reason: 'the harness did not load: ' + e.message });",
    '      try { leave(); } catch {}',
    '      return;',
    '    }',
    '    throw e;',
    '  }',
    "  const hasSolve = typeof mod.solve === 'function';",
    '  if (msg.probe) {',
    "    send({ t: 'probe', ok: hasSolve, reason: hasSolve ? '' : 'it exports no solve function' });",
    '    try { leave(); } catch {}',
    '    return;',
    '  }',
    "  if (!hasSolve) throw new Error('the harness exports no solve function');",
    '  try {',
    "    const contract = await import('./harness/contract.js');",
    "    if (typeof contract.BudgetExceededError === 'function') {",
    '      BudgetError = contract.BudgetExceededError;',
    '    }',
    '  } catch {',
    '    // A snapshot without the frozen contract still runs. The harness then',
    "    // catches a plain Error carrying kind 'budget-exceeded'.",
    '  }',
    '  const solution = plainSolution(await mod.solve(readTask(), makeContext(msg.limits, msg.now)));',
    "  send({ t: 'done', solution });",
    '  try { leave(); } catch {}',
    '}',
    '',
  ].join('\n');
}

/* -------------------------------------------------------------------------- */
/* The jail directory                                                          */
/* -------------------------------------------------------------------------- */

/** What goes into `task/view.json`. The prompt and the starters sit beside it. */
interface TaskViewFile {
  readonly taskId: string;
  readonly entryFile: string;
  readonly exportedSymbols: readonly { name: string; signature: string }[];
  readonly constraints: readonly string[];
  readonly language: string;
  readonly starterPaths: readonly string[];
}

/**
 * Build one jail directory.
 *
 * It holds the harness sources and, unless this is a load probe, one `task/`
 * folder. Nothing else is ever written here, and the child gets no write grant, so
 * what this function writes is the complete list of what the harness can read.
 */
function createJail(files: HarnessSnapshot, task: TaskView | null): string {
  const jail = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'petri-harness-')));
  for (const [path, contents] of Object.entries(files)) {
    if (path.startsWith('/') || path.includes('..') || path.includes('\\')) {
      throw new BenchError(`petri bench: refusing to write the harness path ${path}`, 3);
    }
    const file = join(jail, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, contents, { encoding: 'utf8', mode: 0o444 });
  }
  if (task === null) return jail;

  const taskDir = join(jail, 'task');
  mkdirSync(taskDir, { recursive: true });
  const starterPaths: string[] = [];
  for (const file of task.starterFiles) {
    if (!STARTER_PATH_RE.test(file.path)) {
      throw new BenchError(`petri bench: refusing to write the starter path ${file.path}`, 3);
    }
    starterPaths.push(file.path);
    const abs = join(taskDir, 'starter', file.path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, file.contents, { encoding: 'utf8', mode: 0o444 });
  }
  const view: TaskViewFile = {
    taskId: task.taskId,
    entryFile: task.entryFile,
    exportedSymbols: task.exportedSymbols.map((s) => ({ name: s.name, signature: s.signature })),
    constraints: [...task.constraints],
    language: task.language,
    starterPaths,
  };
  writeFileSync(join(taskDir, 'PROMPT.md'), task.prompt, { encoding: 'utf8', mode: 0o444 });
  writeFileSync(join(taskDir, 'view.json'), JSON.stringify(view, null, 2), {
    encoding: 'utf8', mode: 0o444,
  });
  return jail;
}

/* -------------------------------------------------------------------------- */
/* The parent side                                                             */
/* -------------------------------------------------------------------------- */

export interface JailInput {
  /** The complete harness snapshot. Keys carry the `harness/` prefix. */
  readonly files: HarnessSnapshot;
  readonly task: TaskView;
  readonly ctx: HarnessContext;
  /** The hard deadline for the child. Default: the wall budget plus the grace. */
  readonly timeoutMs?: number | undefined;
}

/**
 * Run one `solve` call inside the jail.
 *
 * It resolves with the Solution the harness produced. It rejects the way an
 * in-process `solve` used to reject, so `runner.ts` classifies the failure
 * exactly as before: a model call that failed underneath the harness rejects with
 * the ORIGINAL error object, so `isInfrastructure` and `isFatal` still see the
 * error they were written to see.
 */
export async function solveInJail(input: JailInput): Promise<Solution> {
  const timeoutMs = input.timeoutMs ?? jailTimeoutOf(input.ctx);
  const jail = createJail(input.files, input.task);
  try {
    return await runChild(jail, input, timeoutMs);
  } finally {
    rmSync(jail, { recursive: true, force: true, maxRetries: 3 });
  }
}

/** The default deadline: the wall budget the runner lends, plus a grace. */
export function jailTimeoutOf(ctx: HarnessContext): number {
  const wall = ctx.budget.maxWallMs;
  const base = Number.isInteger(wall) && wall > 0 ? wall : 120_000;
  return base + JAIL_GRACE_MS;
}

export type ProbeResult = { ok: true } | { ok: false; reason: string };

/**
 * Load the harness once, in the jail, and report whether it exports `solve`.
 *
 * `loadSolve` used to answer this with a dynamic import into the runner's own
 * process, which is the hole this file closes. The answer now costs one child.
 */
export async function probeHarness(files: HarnessSnapshot): Promise<ProbeResult> {
  const jail = createJail(files, null);
  try {
    return await runProbe(jail);
  } finally {
    rmSync(jail, { recursive: true, force: true, maxRetries: 3 });
  }
}

interface ChildHandles {
  readonly send: (message: ToChild) => void;
  readonly kill: () => void;
}

/** Spawn the child. One place builds the argv and the environment. */
function spawnJailed(
  jail: string,
  onMessage: (msg: FromChild) => void,
  onExit: (code: number | null, signal: NodeJS.Signals | null) => void,
  onError: (err: Error) => void,
  onStderr: (text: string) => void,
): ChildHandles {
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '--permission',
      // The ONE read grant. Every other path answers ERR_ACCESS_DENIED, and no
      // write grant is given at all.
      `--allow-fs-read=${jail}/*`,
      '--no-warnings',
      '--disable-proto=throw',
      '--max-old-space-size=1024',
    ],
    {
      cwd: jail,
      env: { PATH: '', HOME: jail, NODE_OPTIONS: '', TZ: 'UTC', LANG: 'C' },
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    },
  );

  child.on('message', (msg) => onMessage(msg as FromChild));
  child.on('error', onError);
  child.on('close', onExit);
  // stdout is drained and NEVER read. A harness cannot talk to the parent this way.
  child.stdout?.resume();
  child.stderr?.on('data', (chunk: Buffer) => onStderr(chunk.toString('utf8')));
  child.stderr?.on('error', () => undefined);
  child.stdin?.on('error', () => undefined);
  child.stdin?.end(buildJailBootstrap(), 'utf8');

  return {
    send: (message: ToChild) => {
      try {
        child.send(message);
      } catch {
        // The child is gone. The close handler settles the promise.
      }
    },
    kill: () => {
      try {
        child.kill('SIGKILL');
      } catch {
        // Already gone.
      }
    },
  };
}

function runProbe(jail: string): Promise<ProbeResult> {
  return new Promise<ProbeResult>((resolve) => {
    let settled = false;
    let stderr = '';
    const finish = (result: ProbeResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      handles.kill();
      resolve(result);
    };

    const handles = spawnJailed(
      jail,
      (msg) => {
        if (msg.t === 'probe') finish(msg.ok ? { ok: true } : { ok: false, reason: msg.reason });
        if (msg.t === 'failed') finish({ ok: false, reason: msg.error.message });
      },
      () => finish({ ok: false, reason: `the harness process exited: ${stderr.trim()}` }),
      (err) => finish({ ok: false, reason: `the harness process failed to start: ${err.message}` }),
      (text) => { stderr = (stderr + text).slice(-STDERR_TAIL_CHARS); },
    );

    const killTimer = setTimeout(() => {
      finish({ ok: false, reason: `the harness did not load inside ${PROBE_TIMEOUT_MS}ms` });
    }, PROBE_TIMEOUT_MS);

    handles.send(probeStart());
  });
}

function probeStart(): StartMessage {
  return {
    t: 'start',
    probe: true,
    now: 0,
    rng: [],
    limits: { maxCalls: 0, maxTokens: 0, maxWallMs: 0 },
    budget: { callsUsed: 0, callsLeft: 0, tokensUsed: 0, tokensLeft: 0, deadlineAt: 0 },
  };
}

function runChild(jail: string, input: JailInput, timeoutMs: number): Promise<Solution> {
  return new Promise<Solution>((resolve, reject) => {
    const { ctx } = input;
    let settled = false;
    let timedOut = false;
    let stderr = '';
    /**
     * The last error a model call threw underneath the harness, when that error
     * was one `runner.ts` classifies specially. If the harness then fails, the
     * ORIGINAL object is rethrown, so a Class B infrastructure failure is still
     * discarded and retried and a fatal fixture miss still stops the command.
     */
    let transportError: unknown = null;

    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      clearTimeout(watchdog);
      handles.kill();
      fn();
    };
    const done = (solution: Solution): void => settle(() => resolve(solution));
    const failed = (message: string, name = 'HarnessError'): void =>
      settle(() => {
        if (transportError !== null) {
          reject(transportError);
          return;
        }
        const err = new Error(message);
        err.name = name;
        reject(err);
      });

    const onMessage = (msg: FromChild): void => {
      if (settled) return;
      switch (msg.t) {
        case 'log':
          try {
            ctx.log.event(msg.kind, msg.data);
          } catch {
            // A broken logger must never change a score.
          }
          return;
        case 'model':
          void serveModelCall(msg.id, msg.request);
          return;
        case 'done':
          try {
            done(checkSolution(msg.solution));
          } catch (err) {
            failed((err as Error).message);
          }
          return;
        case 'failed':
          failed(msg.error.message, msg.error.name);
          return;
        default:
          return;
      }
    };

    const serveModelCall = async (id: number, request: ModelRequest): Promise<void> => {
      let response: ModelResponse;
      try {
        response = await ctx.model.complete(request);
      } catch (err) {
        // The parent decides what this error MEANS. Keeping the original object
        // is what lets `runner.ts` tell Class A from Class B after the fact.
        transportError = err;
        if (!settled) handles.send({ t: 'model-err', id, error: wireError(err), budget: budgetOf(ctx) });
        return;
      }
      if (!settled) handles.send({ t: 'model-ok', id, response, budget: budgetOf(ctx) });
    };

    const handles = spawnJailed(
      jail,
      onMessage,
      () => {
        if (timedOut) {
          failed(`the harness exceeded ${timeoutMs}ms and was killed`, 'HarnessTimeoutError');
          return;
        }
        failed(`the harness process exited before it returned a solution. ${stderr.trim()}`);
      },
      (err) => failed(`the harness process failed to start: ${err.message}`),
      (text) => { stderr = (stderr + text).slice(-STDERR_TAIL_CHARS); },
    );

    // The parent owns the deadline. It never trusts the child to stop.
    const killTimer = setTimeout(() => {
      timedOut = true;
      handles.kill();
    }, timeoutMs);
    // Behind that, a watchdog that settles even if `close` never fires.
    const watchdog = setTimeout(() => {
      timedOut = true;
      failed(`the harness exceeded ${timeoutMs}ms and was killed`, 'HarnessTimeoutError');
    }, timeoutMs + WATCHDOG_GRACE_MS);

    handles.send({
      t: 'start',
      probe: false,
      now: safeNow(ctx),
      rng: drawRandoms(ctx),
      limits: {
        maxCalls: ctx.budget.maxCalls,
        maxTokens: ctx.budget.maxTokens,
        maxWallMs: ctx.budget.maxWallMs,
      },
      budget: budgetOf(ctx),
    });
  });
}

/** The budget, as the child mirrors it. The parent stays the only enforcer. */
function budgetOf(ctx: HarnessContext): WireBudget {
  const state = ctx.budget.state();
  return {
    callsUsed: state.callsUsed,
    callsLeft: state.callsLeft,
    tokensUsed: state.tokensUsed,
    tokensLeft: state.tokensLeft,
    deadlineAt: Date.now() + Math.max(0, state.msLeft),
  };
}

/** Draw the random stream ahead of time, out of the runner's own generator. */
function drawRandoms(ctx: HarnessContext): number[] {
  const draws: number[] = [];
  for (let i = 0; i < RNG_DRAWS; i += 1) {
    const value = ctx.rng();
    draws.push(Number.isFinite(value) ? value : 0);
  }
  return draws;
}

function safeNow(ctx: HarnessContext): number {
  const now = ctx.now();
  return Number.isFinite(now) ? now : 0;
}

/** Keep the shape a `BudgetExceededError` needs, so a harness can still catch it. */
function wireError(err: unknown): WireError {
  const e = err as { name?: unknown; message?: unknown; kind?: unknown; what?: unknown };
  const out: { name: string; message: string; kind?: string; what?: string } = {
    name: typeof e?.name === 'string' ? e.name : 'Error',
    message: typeof e?.message === 'string' ? e.message : String(err),
  };
  if (typeof e?.kind === 'string') out.kind = e.kind;
  if (typeof e?.what === 'string') out.what = e.what;
  return out;
}

/**
 * Check what came back over the channel. The child is not trusted: it ran the
 * harness. A shape that is not a Solution is a harness fault, and `runner.ts`
 * scores the task zero.
 */
export function checkSolution(value: unknown): Solution {
  if (value === null || typeof value !== 'object') {
    throw new Error('the harness returned no Solution');
  }
  const files = (value as { files?: unknown }).files;
  if (!Array.isArray(files)) throw new Error('the harness returned a Solution with no files');
  if (files.length > MAX_SOLUTION_FILES) {
    throw new Error(`the harness returned ${files.length} files. The limit is ${MAX_SOLUTION_FILES}.`);
  }
  let bytes = 0;
  const out: { path: string; contents: string }[] = [];
  for (const file of files) {
    if (file === null || typeof file !== 'object') {
      throw new Error('a solution file is not an object');
    }
    const path = (file as { path?: unknown }).path;
    const contents = (file as { contents?: unknown }).contents;
    if (typeof path !== 'string' || typeof contents !== 'string') {
      throw new Error('a solution file has no path or no contents');
    }
    bytes += Buffer.byteLength(contents, 'utf8');
    if (bytes > MAX_SOLUTION_BYTES) {
      throw new Error(`the harness returned over ${MAX_SOLUTION_BYTES} bytes of solution`);
    }
    out.push({ path, contents });
  }
  const notes = (value as { notes?: unknown }).notes;
  return typeof notes === 'string' ? { files: out, notes } : { files: out };
}
