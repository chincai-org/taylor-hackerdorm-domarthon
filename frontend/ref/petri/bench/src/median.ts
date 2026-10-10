/**
 * Repeats and the median. SPEC.md §10.9.
 *
 * Score, tokens and wall time are each medianed on their own. Nothing is summed.
 * Summing tokens would reward a harness for crashing early. The median describes one
 * typical run.
 *
 * Class B failures are discarded and retried, up to MAX_RETRIES extra attempts per
 * batch. Every discard is recorded permanently in `MedianResult.discarded`, with its
 * reason. Scoring an HTTP 500 as zero would measure a provider's uptime rather than
 * harness design, but silently dropping failures would hide real instability. A
 * harness that trips rate limits because it fans out to forty sub-agents IS worse,
 * and the discard list keeps that visible.
 */
import { byteCompare } from '../../src/core/canonical.js';
import { medianInt } from '../../src/core/schema.js';
import type { Mode } from '../../src/core/schema.js';
import { InfrastructureError } from './runner.js';
import { BenchError, type Outcome, type RunResult } from './schema.js';

export const MEDIAN_PROTOCOL = 'petri/median/1';

/** Default repeats. It must be odd, so the median is the middle element. */
export const DEFAULT_REPEATS = 5;

/** Extra attempts a Class B failure may buy, per batch. */
export const MAX_RETRIES = 3;

export interface Discard {
  attemptIndex: number;
  reason: string;
  runId: string | null;
}

export interface MedianResult {
  protocol: 'petri/median/1';
  node: string;
  harness: string;
  bench: string;
  mode: Mode;
  repeats: number; // Clean runs used. Odd.
  attempted: number; // Runs launched, retries included.
  runIds: string[]; // The clean runs, in attempt order.
  discarded: Discard[];
  incomplete: boolean;
  tampered: boolean;
  medianBp: number; // medianInt over the per-run scoreBp.
  spreadBp: number; // max minus min of the per-run scoreBp.
  perTask: Record<string, { passed: number; of: number }>;
  medianTokens: number;
  medianWallMs: number;
  unstableTasks: string[]; // Tasks that did not give the same outcome in every repeat.
}

export interface MedianInput {
  readonly node: string;
  readonly harness: string;
  readonly bench: string;
  readonly mode: Mode;
  /** Odd, at least 1. Default DEFAULT_REPEATS. */
  readonly repeats?: number | undefined;
  /** Default MAX_RETRIES. */
  readonly maxRetries?: number | undefined;
}

export interface MedianBatch {
  readonly median: MedianResult;
  /** The clean runs the median used, in attempt order. The caller stores them. */
  readonly runs: readonly RunResult[];
}

/** One attempt. It throws `InfrastructureError` for a Class B failure. */
export type Attempt = (attemptIndex: number) => Promise<RunResult>;

/**
 * Run the benchmark `repeats` times and take the median of each measure.
 *
 * The caller supplies the attempt, so this function is the same in live mode and in
 * replay mode, and a test can drive it with no child process at all.
 */
export async function medianOf(attempt: Attempt, input: MedianInput): Promise<MedianBatch> {
  const repeats = input.repeats ?? DEFAULT_REPEATS;
  const maxRetries = input.maxRetries ?? MAX_RETRIES;
  if (!Number.isInteger(repeats) || repeats < 1) {
    throw new BenchError(`petri bench: the run count must be a positive integer, got ${String(repeats)}`, 1);
  }
  if (repeats % 2 === 0) {
    throw new BenchError(`petri bench: the run count must be odd, got ${repeats}. An even count has no unique median.`, 1);
  }
  if (!Number.isInteger(maxRetries) || maxRetries < 0) {
    throw new BenchError(`petri bench: maxRetries must be a non-negative integer`, 1);
  }

  const clean: RunResult[] = [];
  const discarded: Discard[] = [];
  let attempted = 0;

  while (clean.length < repeats && attempted < repeats + maxRetries) {
    const attemptIndex = attempted;
    attempted += 1;
    try {
      clean.push(await attempt(attemptIndex));
    } catch (err) {
      if (!(err instanceof InfrastructureError)) throw err;
      discarded.push({ attemptIndex, reason: err.message, runId: null });
    }
  }

  // An even count has no unique median, so the last clean run is dropped and the
  // drop is recorded. SPEC.md §8.3 calls this "discarded short", and it publishes
  // `clean: false`.
  const used = [...clean];
  while (used.length % 2 === 0 && used.length > 0) {
    const dropped = used.pop()!;
    discarded.push({
      attemptIndex: dropped.attemptIndex,
      reason: 'discarded short: an even clean-run count has no unique median',
      runId: dropped.runId,
    });
  }

  return {
    median: summarise(used, clean, discarded, attempted, repeats, input),
    runs: used,
  };
}

function summarise(
  used: readonly RunResult[],
  collected: readonly RunResult[],
  discarded: Discard[],
  attempted: number,
  wanted: number,
  input: MedianInput,
): MedianResult {
  const scores = used.map((r) => r.scoreBp);
  return {
    protocol: MEDIAN_PROTOCOL,
    node: input.node,
    harness: input.harness,
    bench: input.bench,
    mode: input.mode,
    repeats: used.length,
    attempted,
    runIds: used.map((r) => r.runId),
    discarded,
    incomplete: used.length < wanted,
    // Tampering is evidence. Dropping a run must never hide it.
    tampered: collected.some((r) => r.tampered),
    medianBp: scores.length === 0 ? 0 : medianInt(scores),
    spreadBp: scores.length === 0 ? 0 : Math.max(...scores) - Math.min(...scores),
    perTask: perTaskOf(used),
    medianTokens: used.length === 0 ? 0 : medianInt(used.map((r) => r.tokens)),
    medianWallMs: used.length === 0 ? 0 : medianInt(used.map((r) => r.wallMs)),
    unstableTasks: unstableTasksOf(used),
  };
}

function perTaskOf(runs: readonly RunResult[]): Record<string, { passed: number; of: number }> {
  const perTask: Record<string, { passed: number; of: number }> = {};
  for (const run of runs) {
    for (const task of run.tasks) {
      const cell = perTask[task.taskId] ?? { passed: 0, of: 0 };
      cell.of += 1;
      if (task.passed) cell.passed += 1;
      perTask[task.taskId] = cell;
    }
  }
  return perTask;
}

/**
 * Tasks that did not give the same outcome in every repeat.
 * A node whose score rests on an unstable task is visibly weaker than one whose
 * tasks are all stable. This is the honest noise report.
 */
function unstableTasksOf(runs: readonly RunResult[]): string[] {
  if (runs.length < 2) return [];
  const seen = new Map<string, Set<Outcome>>();
  for (const run of runs) {
    for (const task of run.tasks) {
      const set = seen.get(task.taskId) ?? new Set<Outcome>();
      set.add(task.outcome);
      seen.set(task.taskId, set);
    }
  }
  const unstable: string[] = [];
  for (const [taskId, outcomes] of seen) {
    if (outcomes.size > 1) unstable.push(taskId);
  }
  unstable.sort(byteCompare);
  return unstable;
}

/**
 * The `clean` flag of `VerificationSigned`. SPEC.md §8.3.
 * No run was tampered, timed out as infrastructure, or discarded short.
 * SPEC.md §9.3 turns a false here into `NOT_CLEAN`, which rejects the node.
 */
export function batchIsClean(median: MedianResult): boolean {
  return !median.tampered && !median.incomplete && median.discarded.length === 0;
}
