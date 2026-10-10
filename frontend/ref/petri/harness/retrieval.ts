/**
 * LEVER: `retrieval` — what task material enters the prompt, and in what order.
 *
 * V1 is the honest baseline. It takes the starter files in their declared order
 * until the character budget is full, and drops the rest. It ranks nothing, it
 * summarises nothing and it truncates no single file.
 *
 * Things a later node might try here:
 *   - rank the starter files by name or size instead of keeping declared order
 *   - truncate one large file instead of dropping it whole
 *   - summarise a dropped file down to its exported symbols
 *   - raise or lower DEFAULT_CHAR_BUDGET
 *   - report the dropped names to the model so it knows what it cannot see
 *
 * Measured limit: the 20 bench tasks carry 0 to 2 starter files, so this lever
 * has very little material to rank. Read the digest before you spend a node here.
 */
import type { TaskView, SourceFile } from './contract.js';

export interface RetrievedContext {
  readonly files: readonly SourceFile[];
  readonly droppedFiles: readonly string[];
  readonly charBudget: number;
}

export const DEFAULT_CHAR_BUDGET = 40_000;

/** V1 takes the starter files in declared order until the budget is full. */
export function selectContext(
  task: TaskView,
  charBudget: number = DEFAULT_CHAR_BUDGET,
): RetrievedContext {
  const files: SourceFile[] = [];
  const droppedFiles: string[] = [];
  let used = 0;
  for (const f of task.starterFiles) {
    const cost = f.path.length + f.contents.length + 16;
    if (used + cost > charBudget) { droppedFiles.push(f.path); continue; }
    files.push(f);
    used += cost;
  }
  return { files, droppedFiles, charBudget };
}
