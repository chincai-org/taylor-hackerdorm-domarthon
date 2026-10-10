/**
 * The exit-code table of SPEC.md §14.1. These are the ONLY exit codes.
 *
 * A failed experiment exits 0. A failed tool exits non-zero.
 * Design rule 3 depends on that distinction.
 */
import { EXIT_CODES, PetriError, type ExitCode, type ExitName } from '../core/errors.js';

/**
 * The one table. `src/core/errors.ts` owns the numbers, so a command and a
 * thrown error can never disagree about what code 4 means.
 */
export const EXIT = EXIT_CODES;

export type { ExitCode, ExitName };

/** The human name of every exit code. Printed on failure so the code is readable. */
export const EXIT_NAME: Readonly<Record<ExitCode, ExitName>> = Object.freeze(
  Object.fromEntries(
    (Object.keys(EXIT_CODES) as ExitName[]).map((name) => [EXIT_CODES[name], name]),
  ) as Record<ExitCode, ExitName>,
);

/**
 * Throw a PetriError that carries one of the codes above.
 *
 * The code comes first, because every call site reads `fail(EXIT.NOT_FOUND, …)`
 * and the code is the part the shell sees.
 */
export function fail(code: ExitCode, message: string): never {
  throw new PetriError(EXIT_NAME[code], message);
}

/**
 * Read the exit code off a thrown value.
 * The check is structural, so any error object carrying a numeric `exitCode`
 * maps correctly. An unknown throw is an INTEGRITY failure, not a silent 0.
 */
export function exitCodeOf(err: unknown): number {
  if (err !== null && typeof err === 'object') {
    const code = (err as { exitCode?: unknown }).exitCode;
    if (typeof code === 'number' && Number.isInteger(code) && code >= 0 && code <= 7) {
      return code;
    }
  }
  return EXIT.INTEGRITY;
}

/** The message of a thrown value. Never throws. */
export function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/**
 * Flush both streams, then exit.
 * `process.exit` alone can truncate stdout when it is a pipe.
 */
export function flushAndExit(code: number): void {
  process.exitCode = code;
  let pending = 2;
  const tick = (): void => {
    pending -= 1;
    if (pending === 0) process.exit(code);
  };
  process.stdout.write('', tick);
  process.stderr.write('', tick);
}
