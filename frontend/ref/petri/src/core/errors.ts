/**
 * One error type with an exit code. See SPEC.md section 14.1.
 *
 * A failed EXPERIMENT exits 0. A failed TOOL exits non-zero. Design rule 3
 * depends on that distinction, so never throw a PetriError to report a
 * measured rejection.
 */

export const EXIT_CODES = {
  /** The command did what it says. A recorded rejection is a success. */
  OK: 0,
  /** A bad flag, a missing argument, or an even run count. */
  USAGE: 1,
  /** No .petri/, no such node, no such object, no fixture. */
  NOT_FOUND: 2,
  /** A bad signature, a hash mismatch, a broken log chain, a bad id. */
  INTEGRITY: 3,
  /** A policy refusal. Self-verification. A cross-mode comparison. */
  REFUSED: 4,
  /** A doctor check failed. Node too old. The sandbox is broken. */
  ENVIRONMENT: 5,
  /** A mirror node or Hedera failure, after retries. */
  NETWORK: 6,
  /** SIGINT or SIGTERM. */
  INTERRUPTED: 7,
} as const;

export type ExitName = keyof typeof EXIT_CODES;
export type ExitCode = (typeof EXIT_CODES)[ExitName];

/** Every command maps a throw to the table above. */
export class PetriError extends Error {
  readonly kind: ExitName;
  readonly exitCode: ExitCode;

  constructor(kind: ExitName, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PetriError';
    this.kind = kind;
    this.exitCode = EXIT_CODES[kind];
  }
}

export const usageError = (message: string): PetriError => new PetriError('USAGE', message);
export const notFoundError = (message: string): PetriError => new PetriError('NOT_FOUND', message);
export const integrityError = (message: string): PetriError => new PetriError('INTEGRITY', message);
export const refusedError = (message: string): PetriError => new PetriError('REFUSED', message);
export const environmentError = (message: string): PetriError => new PetriError('ENVIRONMENT', message);
export const networkError = (message: string): PetriError => new PetriError('NETWORK', message);
export const interruptedError = (message: string): PetriError => new PetriError('INTERRUPTED', message);

export const isPetriError = (e: unknown): e is PetriError => e instanceof PetriError;

/** The exit code for any thrown value. An unknown throw is a usage failure. */
export function exitCodeOf(e: unknown): ExitCode {
  return isPetriError(e) ? e.exitCode : EXIT_CODES.USAGE;
}

/** A printable one-line message for any thrown value. */
export function messageOf(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  return String(e);
}
