/**
 * LEVER: `prompt` — what the harness says to the model.
 *
 * V3 keeps V2's signatures and worked example, and changes HOW the rules are said.
 * Every instruction is a positive directive: what the model must do. V2 closed its
 * format rule with a prohibition ("and nothing else"). A prohibition makes the model
 * reason about what to avoid; a directive tells it exactly what to produce.
 *
 * Hypothesis under test: positive directives raise the pass rate, make the code
 * safer (inputs are validated), and cut reply tokens.
 */
import type { TaskView } from './contract.js';
import type { RetrievedContext } from './retrieval.js';

export function buildSystemPrompt(): string {
  return [
    'You are a JavaScript programmer.',
    'Write complete, runnable ESM code.',
    'Put your whole answer inside one fenced js code block.',
    'Export every symbol the task names, with exactly the signature it gives.',
    'Validate each input, and throw a TypeError with a clear message when an input is wrong.',
    'Use this exact reply shape:',
    '```js',
    'export function example(input, size) {',
    "  if (!Array.isArray(input)) throw new TypeError('input must be an array');",
    '  return [];',
    '}',
    '```',
  ].join('\n');
}

export function buildUserPrompt(task: TaskView, context: RetrievedContext): string {
  const parts: string[] = [];
  parts.push(`Task: ${task.prompt}`);
  parts.push(`Write the file ${task.entryFile}.`);
  parts.push(
    'Export exactly these symbols, with exactly these signatures:\n'
    + task.exportedSymbols.map((s) => `- ${s.signature}`).join('\n'),
  );
  if (task.constraints.length > 0) {
    parts.push(`Follow these constraints:\n${task.constraints.map((c) => `- ${c}`).join('\n')}`);
  }
  for (const f of context.files) parts.push(`--- ${f.path} ---\n${f.contents}`);
  return parts.join('\n\n');
}
