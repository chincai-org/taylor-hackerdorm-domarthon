/**
 * The sandbox. SPEC.md §10.6 and §10.7.
 *
 * Two properties, and each one is enforced by its own child process.
 *
 * 1. The harness must not READ the tests while it writes the solution. That is
 *    `harnessJail.ts`: the harness runs under `--permission` with one read grant
 *    over a jail directory that holds the prompt and the harness, and nothing else.
 *    `taskLoader.ts` keeps the test text out of `TaskView`, which decides what the
 *    runner HANDS over; the jail decides what the harness can TAKE.
 * 2. The solution must not READ the tests when it runs. That is this file.
 *
 * The test source is NEVER written to disk. The parent reads it into memory, embeds
 * it in a bootstrap program, and pipes that program to the child over stdin. A
 * `module.registerHooks` load hook serves the test source at a virtual `file://` URL
 * inside the solution directory, so `./solution.mjs` resolves normally while the spec
 * file does not exist on disk. A solution that opens it gets ENOENT.
 *
 * The verdict needs two channels that agree: the child exit code, and an attestation
 * on file descriptor 3 carrying a fresh nonce. The nonce lives only inside the
 * bootstrap, which arrives over stdin. It is never on disk, never in argv and never in
 * env, so the solution cannot forge it. Any disagreement is `tampered`.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { BenchError, type Outcome } from './schema.js';

export type { Outcome } from './schema.js';

/** The frozen clock every sandboxed solution sees. 2025-01-01T00:00:00.000Z. */
export const FROZEN_NOW_MS = 1735689600000;

/** How much of stderr survives into the result. Enough to read one stack trace. */
export const STDERR_TAIL_CHARS = 2000;

/** Extra grace after the hard timeout before the parent force-settles. */
const WATCHDOG_GRACE_MS = 2000;

/** A solution entry file name. The same shape `TaskMetaSchema.entry` allows. */
const ENTRY_RE = /^[a-z0-9-]+\.mjs$/;

export interface SandboxResult {
  outcome: Outcome;
  passed: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  assertions: { pass: number; fail: number } | null;
  wallMs: number;
  stderrTail: string;
}

export interface SandboxOptions {
  solutionSource: string;
  entry: string;
  specSource: string;
  timeoutMs: number;
}

/**
 * Build the program the child runs. It does five things before the solution loads.
 *
 * 1. It serves `specSource` at `virtPath` through a resolve and load hook.
 * 2. It removes `process.exit`, `reallyExit`, `abort`, `kill` and `_kill`, so the
 *    solution cannot forge the exit code.
 * 3. It freezes `Math.random` to a seeded LCG, and `Date`, `Date.now` and
 *    `performance.now` to FROZEN_NOW_MS. A solution cannot pass by luck.
 * 4. It runs the tests and counts the `test:pass` and `test:fail` events.
 * 5. It writes `<nonce> {"pass":N,"fail":M}` to file descriptor 3, then exits through
 *    a saved `reallyExit`.
 *
 * The program is pure ASCII-safe JavaScript built by string concatenation. It carries
 * no template literal and no escape sequence, so nothing here can be mangled twice.
 */
export function buildBootstrap(specSource: string, virtPath: string, nonce: string): string {
  const specUrl = JSON.stringify(pathToFileURL(virtPath).href);
  const specPath = JSON.stringify(virtPath);
  const source = JSON.stringify(specSource);
  const nonceLit = JSON.stringify(nonce);

  return [
    "import { writeSync } from 'node:fs';",
    "import { registerHooks } from 'node:module';",
    "import { run } from 'node:test';",
    '',
    `const SPEC_URL = ${specUrl};`,
    `const SPEC_PATH = ${specPath};`,
    `const SPEC_SOURCE = ${source};`,
    `const NONCE = ${nonceLit};`,
    `const FIXED = ${String(FROZEN_NOW_MS)};`,
    'const LF = String.fromCharCode(10);',
    '',
    '// Saved before anything else can reach them.',
    'const write = writeSync;',
    'const reallyExit = process.reallyExit.bind(process);',
    '',
    '// 1. Serve the spec from memory, at a path that does not exist on disk.',
    'registerHooks({',
    '  resolve(specifier, context, nextResolve) {',
    '    if (specifier === SPEC_URL || specifier === SPEC_PATH) {',
    "      return { url: SPEC_URL, format: 'module', shortCircuit: true };",
    '    }',
    '    return nextResolve(specifier, context);',
    '  },',
    '  load(url, context, nextLoad) {',
    '    if (url === SPEC_URL) {',
    "      return { format: 'module', source: SPEC_SOURCE, shortCircuit: true };",
    '    }',
    '    return nextLoad(url, context);',
    '  },',
    '});',
    '',
    '// 2. Remove every way to forge the exit code.',
    'delete process.exit;',
    'delete process.reallyExit;',
    'delete process.abort;',
    'delete process.kill;',
    'delete process._kill;',
    '',
    '// 3. Freeze randomness and the clock. Math.imul keeps the LCG exact at 32 bits.',
    'let rngState = 20250101;',
    'Math.random = function random() {',
    '  rngState = (Math.imul(rngState, 1664525) + 1013904223) >>> 0;',
    '  return rngState / 4294967296;',
    '};',
    'const RealDate = Date;',
    'class FrozenDate extends RealDate {',
    '  constructor(...args) {',
    '    if (args.length === 0) { super(FIXED); } else { super(...args); }',
    '  }',
    '  static now() { return FIXED; }',
    '}',
    'FrozenDate.parse = RealDate.parse;',
    'FrozenDate.UTC = RealDate.UTC;',
    'globalThis.Date = FrozenDate;',
    'performance.now = function now() { return FIXED; };',
    '',
    '// 4. Run the tests. The counts come from the event stream, not from any',
    '//    side effect the solution could reach.',
    'let pass = 0;',
    'let fail = 0;',
    'let fileFailed = false;',
    'try {',
    "  const stream = run({ files: [SPEC_PATH], isolation: 'none', concurrency: 1 });",
    '  for await (const event of stream) {',
    "    if (event.type !== 'test:pass' && event.type !== 'test:fail') continue;",
    '    const data = event.data;',
    '    if (data.nesting === 0 && data.name === SPEC_PATH) {',
    "      if (event.type === 'test:fail') fileFailed = true;",
    '      continue;',
    '    }',
    "    if (event.type === 'test:pass') { pass += 1; } else { fail += 1; }",
    '  }',
    '} catch {',
    '  fileFailed = true;',
    '}',
    '// A file that never loaded reports one failure, so an import error scores zero.',
    'if (fileFailed && fail === 0) fail += 1;',
    '',
    '// 5. Attest, then leave through the saved exit.',
    'const line = NONCE + String.fromCharCode(32) + JSON.stringify({ pass: pass, fail: fail }) + LF;',
    'try { write(3, line); } catch { try { write(3, line); } catch {} }',
    'const ok = fail === 0 && pass > 0;',
    'process.exitCode = ok ? 0 : 1;',
    'reallyExit(ok ? 0 : 1);',
    '',
  ].join('\n');
}

/**
 * Run one solution against one test file, in a child process that cannot reach the
 * tests, the network, the repo or the clock.
 *
 * The parent owns the timeout. It arms its own SIGKILL timer beside the spawn
 * timeout, and a watchdog behind both, so a hung child can never hang the command.
 */
export async function runInSandbox(opts: SandboxOptions): Promise<SandboxResult> {
  if (!ENTRY_RE.test(opts.entry)) {
    throw new BenchError(`petri bench: illegal entry file name "${opts.entry}"`, 5);
  }
  if (!Number.isInteger(opts.timeoutMs) || opts.timeoutMs <= 0) {
    throw new BenchError(`petri bench: illegal timeoutMs ${String(opts.timeoutMs)}`, 5);
  }

  // macOS returns /var/…, which resolves to /private/var/…. Node matches the
  // permission scope against the RESOLVED path. Without realpath every task fails
  // with ERR_ACCESS_DENIED, which reads like a bad harness rather than a broken box.
  const workdir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'petri-bench-')));
  const solDir = join(workdir, 'sol');
  mkdirSync(solDir, { recursive: true });
  writeFileSync(join(solDir, opts.entry), opts.solutionSource, { encoding: 'utf8', mode: 0o644 });

  const nonce = randomUUID();
  const virtPath = join(solDir, `__petri_spec_${nonce.replace(/-/g, '')}.mjs`);
  const bootstrap = buildBootstrap(opts.specSource, virtPath, nonce);

  const startedAt = Date.now();
  try {
    return await spawnChild(bootstrap, solDir, nonce, opts.timeoutMs, startedAt);
  } finally {
    rmSync(workdir, { recursive: true, force: true, maxRetries: 3 });
  }
}

function spawnChild(
  bootstrap: string,
  solDir: string,
  nonce: string,
  timeoutMs: number,
  startedAt: number,
): Promise<SandboxResult> {
  return new Promise<SandboxResult>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '--permission',
        `--allow-fs-read=${solDir}/*`,
        '--no-warnings',
        '--disable-proto=throw',
        '--max-old-space-size=512',
      ],
      {
        // A program read from stdin gets an implicit read grant over the cwd subtree.
        // Setting cwd to the solution directory makes that grant equal the intended scope.
        cwd: solDir,
        env: { PATH: '', HOME: solDir, NODE_OPTIONS: '', TZ: 'UTC', LANG: 'C' },
        stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
      },
    );

    let settled = false;
    let timedOut = false;
    let stderr = '';
    let attestation = '';

    const kill = (): void => {
      try {
        child.kill('SIGKILL');
      } catch {
        // The child is already gone. Nothing to do.
      }
    };

    // The parent enforces the deadline itself. It never trusts the child to stop.
    const killTimer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    // Behind that, a watchdog that settles the promise even if `close` never fires.
    const watchdog = setTimeout(() => {
      timedOut = true;
      kill();
      finish(null, 'SIGKILL');
    }, timeoutMs + WATCHDOG_GRACE_MS);

    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      clearTimeout(watchdog);
      resolve(
        classify({
          code,
          signal,
          timedOut,
          attestation,
          nonce,
          wallMs: Date.now() - startedAt,
          stderrTail: stderr.slice(-STDERR_TAIL_CHARS),
        }),
      );
    };

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      clearTimeout(watchdog);
      reject(err);
    });
    child.on('close', (code, signal) => finish(code, signal));

    // stdout is drained and NEVER parsed. Dropping it keeps memory flat.
    child.stdout?.resume();
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-STDERR_TAIL_CHARS * 4);
    });
    child.stderr?.on('error', () => undefined);

    const fd3 = child.stdio[3] as Readable | null | undefined;
    if (fd3 !== null && fd3 !== undefined && typeof fd3.on === 'function') {
      fd3.on('data', (chunk: Buffer) => {
        if (attestation.length < 4096) attestation += chunk.toString('utf8');
      });
      fd3.on('error', () => undefined);
    }

    // The program itself goes over stdin. It is never a file and never in argv.
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(bootstrap, 'utf8');
  });
}

interface ClassifyInput {
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  attestation: string;
  nonce: string;
  wallMs: number;
  stderrTail: string;
}

/**
 * Read the verdict off the two channels. SPEC.md §10.7.
 *
 * A run counts as `pass` only when the exit code is 0, the attestation is present,
 * `fail === 0` and `pass > 0`. Any disagreement between the channels is `tampered`.
 */
function classify(input: ClassifyInput): SandboxResult {
  const assertions = parseAttestation(input.attestation, input.nonce);
  const base = {
    exitCode: input.code,
    signal: input.signal,
    assertions,
    wallMs: input.wallMs,
    stderrTail: input.stderrTail,
  };
  const done = (outcome: Outcome): SandboxResult => ({
    ...base,
    outcome,
    passed: outcome === 'pass',
  });

  if (input.signal !== null) return done(input.timedOut ? 'timeout' : 'crash');
  if (input.code === null) return done(input.timedOut ? 'timeout' : 'crash');
  if (assertions === null) return done('no_attestation');

  const attestationPassed = assertions.fail === 0 && assertions.pass > 0;
  const exitPassed = input.code === 0;
  if (attestationPassed !== exitPassed) return done('tampered');
  return done(attestationPassed ? 'pass' : 'fail');
}

/** Find the attestation line for this nonce. Anything else on fd 3 is ignored. */
function parseAttestation(
  text: string,
  nonce: string,
): { pass: number; fail: number } | null {
  const prefix = `${nonce} `;
  for (const line of text.split('\n')) {
    if (!line.startsWith(prefix)) continue;
    let value: unknown;
    try {
      value = JSON.parse(line.slice(prefix.length));
    } catch {
      return null;
    }
    if (value === null || typeof value !== 'object') return null;
    const counts = value as { pass?: unknown; fail?: unknown };
    if (!isCount(counts.pass) || !isCount(counts.fail)) return null;
    return { pass: counts.pass, fail: counts.fail };
  }
  return null;
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
