/**
 * LEVER: `prompt` — what the harness says to the model.
 *
 * V1 is the honest baseline, and it carries a real defect on purpose.
 * `buildUserPrompt` sends the exported symbol NAMES only. It never sends the
 * full signatures, so the model has to guess the argument order and the argument
 * types. That headroom is deliberate. It is the first thing a reader should see.
 *
 * Things a later node might try here:
 *   - send `s.signature` as well as `s.name` (motif: include-signatures)
 *   - add one worked example of the exact reply shape (motif: one-worked-example)
 *   - state the output format as a hard rule instead of a sentence
 *   - name the file extension and the module system in the system text
 *   - reorder the parts, so the task text is last and stays closest to the answer
 *
 * Keep the system text short. It is sent on every call of every task, so each
 * added line is paid for 20 times per run and 100 times per 5-run median.
 */
import type { TaskView } from './contract.js';
import type { RetrievedContext } from './retrieval.js';

export function buildSystemPrompt(): string {
  return [
    'You are a JavaScript programmer.',
    'Write complete, runnable ESM code.',
    'Reply with one fenced code block and nothing else.',
  ].join('\n');
}

export function buildUserPrompt(task: TaskView, context: RetrievedContext): string {
  const parts: string[] = [];
  parts.push(`Task: ${task.prompt}`);
  parts.push(`Write the file ${task.entryFile}.`);
  // V1 sends symbol NAMES only. The full signatures are deliberately withheld.
  parts.push(`It must export: ${task.exportedSymbols.map((s) => s.name).join(', ')}.`);
  if (task.constraints.length > 0) {
    parts.push(`Constraints:\n${task.constraints.map((c) => `- ${c}`).join('\n')}`);
  }
  for (const f of context.files) parts.push(`--- ${f.path} ---\n${f.contents}`);
  return parts.join('\n\n');
}
