/**
 * `tsc --noEmit` on the scratch copy of the harness. SPEC.md §13.6.
 *
 * A patch that does not compile is DATA. This function never throws on a broken
 * patch. It returns the verbatim compiler output, which the caller stores in
 * `NodeDetail.mechanical.evidence`, and `petri evolve` still exits 0.
 *
 * The compiler runs WITH THE SCRATCH WORKSPACE AS ITS WORKING DIRECTORY, so
 * every path it prints is workspace-relative. The absolute path of the user's
 * home directory and the random workspace UUID therefore never enter the
 * output, and two machines that compile one patch print one text. SPEC.md
 * §6.4a: `command` and `exitCode` are observation, and of the output only the
 * diagnostics reach the node id.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { diagnosticsOf } from '../core/ids.js';

/**
 * The exact tsconfig written beside the scratch harness.
 * `"types": []` works because a harness file imports nothing outside `harness/`,
 * so the check needs no `node_modules` beyond `typescript` itself.
 */
export const SCRATCH_TSCONFIG = {
  compilerOptions: {
    target: 'ES2023',
    lib: ['ES2023'],
    module: 'NodeNext',
    moduleResolution: 'NodeNext',
    strict: true,
    noEmit: true,
    types: [],
    exactOptionalPropertyTypes: true,
    noUncheckedIndexedAccess: true,
    skipLibCheck: true,
  },
  include: ['harness/**/*.ts'],
} as const;

/** Write `<workspace>/tsconfig.json`. Return its path. */
export function writeScratchTsconfig(workspace: string): string {
  mkdirSync(workspace, { recursive: true });
  const path = join(workspace, 'tsconfig.json');
  writeFileSync(path, `${JSON.stringify(SCRATCH_TSCONFIG, null, 2)}\n`, 'utf8');
  return path;
}

export interface TypecheckResult {
  /** True when the compiler exited 0. */
  readonly ok: boolean;
  /** OBSERVATION. The command that ran, for `MechanicalResult.command`. */
  readonly command: string;
  /** OBSERVATION. The compiler exit code. 127 when no compiler could be started. */
  readonly exitCode: number;
  /** stdout and stderr joined, verbatim, with workspace-relative paths. */
  readonly output: string;
  /**
   * The ordered diagnostics of `output`, each as
   * `harness/<file>(<line>,<col>) TS####`. This is the only part of a
   * typecheck that a node id sees. SPEC.md §6.4a.
   */
  readonly diagnostics: readonly string[];
}

export interface TypecheckOptions {
  /** The scratch workspace that holds `harness/` and `tsconfig.json`. */
  readonly workspace: string;
  /** The repo root. It is used to find a compiler, never as a path in the output. */
  readonly repoRoot: string;
  /** Milliseconds before the compiler is killed. */
  readonly timeoutMs?: number;
}

interface Candidate { readonly file: string; readonly args: readonly string[]; }

/**
 * The compilers to try, in order.
 *
 * The repo's own `typescript` comes first, because its path is known and it
 * needs no PATH lookup. `pnpm exec tsc` of SPEC.md §13.6 is the fallback, for a
 * checkout with no `node_modules`. The order no longer changes any id: the
 * command line is observation (§6.4a). It still decides how often the check can
 * run at all, so the certain compiler is tried first.
 *
 * Every argument is workspace-relative, because the working directory IS the
 * workspace.
 */
function candidates(repoRoot: string): Candidate[] {
  const list: Candidate[] = [];
  const localBin = join(repoRoot, 'node_modules', '.bin', 'tsc');
  if (existsSync(localBin)) list.push({ file: localBin, args: ['-p', 'tsconfig.json'] });
  const localJs = join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc');
  if (existsSync(localJs)) list.push({ file: process.execPath, args: [localJs, '-p', 'tsconfig.json'] });
  list.push({ file: 'pnpm', args: ['exec', 'tsc', '-p', 'tsconfig.json'] });
  return list;
}

const show = (c: Candidate): string => [c.file, ...c.args].join(' ');

/**
 * Typecheck the scratch harness.
 * A compiler that cannot start is reported as exit code 127 with the reason as
 * output. That is still a `typecheck-failed` node, never a thrown error.
 */
export function typecheckScratch(options: TypecheckOptions): TypecheckResult {
  writeScratchTsconfig(options.workspace);
  const timeout = options.timeoutMs ?? 120_000;
  const tried: string[] = [];

  for (const c of candidates(options.repoRoot)) {
    const res = spawnSync(c.file, [...c.args], {
      // The workspace, never the repo root. A compiler prints paths relative to
      // its working directory, so this is what keeps the output machine-independent.
      cwd: options.workspace,
      encoding: 'utf8',
      timeout,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
    });

    const err = res.error as NodeJS.ErrnoException | undefined;
    if (err !== undefined && (err.code === 'ENOENT' || err.code === 'EACCES')) {
      tried.push(`${show(c)}  ->  ${err.code}`);
      continue;
    }

    const output = `${res.stdout ?? ''}${res.stderr ?? ''}`.trim();
    if (err !== undefined) {
      return finish(false, show(c), res.status ?? 1, `${output}\n${err.message}`.trim());
    }
    const exitCode = res.status ?? 1;
    return finish(exitCode === 0, show(c), exitCode, output);
  }

  return finish(
    false, '', 127,
    `no TypeScript compiler could be started. Tried:\n${tried.join('\n')}`,
  );
}

/** One exit point, so the diagnostics are always derived from the output shown. */
function finish(ok: boolean, command: string, exitCode: number, output: string): TypecheckResult {
  return { ok, command, exitCode, output, diagnostics: diagnosticsOf(output) };
}
