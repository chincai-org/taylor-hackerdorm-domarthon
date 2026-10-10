/**
 * LEVER: `loop` — this file is the frozen entry point, not a place to think.
 *
 * `solve` keeps its signature forever. The evolve guard checks the exact text of
 * the declaration, so a patch that widens it is rejected as a contract violation.
 * Everything behind `solve` is mutable: files may be added, split, merged or
 * deleted, as long as each one imports only its relative siblings inside harness/.
 *
 * Things a later node might try here:
 *   - move the two log events, so a trace reader can see where time went
 *   - call a new top-level stage before runLoop, for example a plan step
 * Prefer changing ./loop.ts. Keeping this file thin keeps every diff readable.
 */
import type { TaskView, HarnessContext, Solution } from './contract.js';
import { runLoop } from './loop.js';

export { HARNESS_ENTRY_VERSION } from './contract.js';
export type { TaskView, HarnessContext, Solution } from './contract.js';

/** FROZEN ENTRY POINT. The signature never changes. Everything behind it is mutable. */
export async function solve(task: TaskView, ctx: HarnessContext): Promise<Solution> {
  ctx.log.event('solve:start', { taskId: task.taskId });
  const solution = await runLoop(task, ctx);
  ctx.log.event('solve:end', { files: solution.files.length });
  return solution;
}
