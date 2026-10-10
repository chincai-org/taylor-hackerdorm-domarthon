/**
 * LEVER: `recovery` — what the harness does after a bad reply.
 *
 * V1 does not recover. `attemptRepair` returns null every time, so a failed
 * draft is thrown away and the task scores 0. The seam exists so that adding a
 * repair turn is a one-file diff that a reader can check in ten seconds.
 *
 * Things a later node might try here:
 *   - one repair turn that quotes the failure detail back to the model
 *   - a repair turn only for `empty-file` and `no-code-block`, never for
 *     `budget-exceeded`, because a second call cannot fit inside a spent budget
 *   - a plain retry with no extra text (motif: blind-retry)
 *   - a local fallback that returns a stub file so the tests at least import
 *
 * Measured warning from the tree: unconditional repair costs tokens on every
 * task and has already lost score once. Make a repair conditional on the kind.
 *
 * A repair turn MUST use a fresh label, for example "repair#1". Labels name the
 * call site and the runner refuses a duplicate.
 */
import type { TaskView, HarnessContext, Solution } from './contract.js';

export interface Failure {
  readonly kind: 'no-code-block' | 'empty-file' | 'model-error' | 'budget-exceeded';
  readonly detail: string;
}

/** V1 does not recover. The seam exists so a repair turn is a one-file diff. */
export async function attemptRepair(
  _task: TaskView, _ctx: HarnessContext, _failure: Failure, _previousReply: string,
): Promise<Solution | null> {
  return null;
}
