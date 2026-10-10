/**
 * `petri verify --show`: what the benchmark actually ran, in the terminal.
 *
 * Everything printed here is read from real files. Nothing is invented:
 *   input   the harness prompt file (from the stored harness snapshot) and the
 *           task's PROMPT.md, which is what the harness reads;
 *   output  the recorded model answer in bench/fixtures/, which is the exact code
 *           replay hands to the sandbox. Live mode does not store replies;
 *   evals   the per-task results of every run, from the RunResults just measured.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { RunResult } from '../../bench/src/schema.js';
import type { HarnessSnapshot, Mode } from '../core/schema.js';
import { loadFixture } from '../model/replay.js';
import { shortId } from './banner.js';
import { out } from './context.js';

const PASS = '✓';
const FAIL = '✗';

export function clip(text: string, max: number): string[] {
  const lines = text.replace(/\s+$/, '').split('\n');
  return lines.length <= max ? lines : [...lines.slice(0, max), `… ${lines.length - max} more lines`];
}

export function box(title: string, lines: readonly string[]): void {
  out(`  ┌─ ${title}`);
  for (const line of lines) out(`  │ ${line}`);
  out('  └─');
}

export function heading(text: string): void {
  out('');
  out(`━━ ${text}`);
  out('');
}

/** The model answer replay feeds the sandbox for this harness, task and run. */
export function recordedAnswer(benchDir: string, harnessId: string, taskId: string, attempt: number): string | null {
  try {
    return loadFixture(join(benchDir, 'fixtures'), harnessId, taskId, attempt).source;
  } catch {
    return null;
  }
}

/** Passes per task over all runs. */
function passCounts(results: readonly RunResult[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const run of results) {
    for (const t of run.tasks) counts.set(t.taskId, (counts.get(t.taskId) ?? 0) + (t.passed ? 1 : 0));
  }
  return counts;
}

export interface TraceInput {
  benchDir: string;
  mode: Mode;
  parentId: string;
  candidateId: string;
  parentHarnessId: string;
  candidateHarnessId: string;
  candidateHarness: HarnessSnapshot;
  parent: readonly RunResult[];
  candidate: readonly RunResult[];
}

export function printVerifyTrace(input: TraceInput): void {
  const first = input.candidate[0];
  if (first === undefined) return;
  const taskIds = first.tasks.map((t) => t.taskId);
  const parentPasses = passCounts(input.parent);
  const candidatePasses = passCounts(input.candidate);

  // Show the task where this version gained most over its parent.
  let task = taskIds[0]!;
  let best = -Infinity;
  for (const id of taskIds) {
    const gain = (candidatePasses.get(id) ?? 0) - (parentPasses.get(id) ?? 0);
    if (gain > best) { best = gain; task = id; }
  }

  const parentName = input.parentId === 'root' ? 'the empty harness' : shortId(input.parentId);
  const thisName = shortId(input.candidateId);

  heading(`INPUT  task ${task}`);
  const promptFile = input.candidateHarness['harness/prompt.ts'];
  if (promptFile !== undefined) {
    // Skip the file's header comment, so the prompt text itself shows first.
    const code = promptFile.replace(/^\s*\/\*\*[\s\S]*?\*\/\s*/, '').replace(/^import[^\n]*\n/gm, '').trimStart();
    box(`harness/prompt.ts of ${thisName}  (what the harness tells the model)`, clip(code, 26));
  }
  const promptMd = join(input.benchDir, 'tasks', task, 'PROMPT.md');
  if (existsSync(promptMd)) box(`bench/tasks/${task}/PROMPT.md  (the task the harness reads)`, clip(readFileSync(promptMd, 'utf8'), 18));

  heading(`OUTPUT  what the model wrote for ${task}, run 1`);
  if (input.mode === 'live') {
    out('  Live mode does not store model replies. The test results below come from them.');
  } else {
    const parentAnswer = input.parentId === 'root'
      ? null
      : recordedAnswer(input.benchDir, input.parentHarnessId, task, 0);
    box(`parent ${parentName}`, parentAnswer === null
      ? ['(no answer: the parent writes nothing for this task)']
      : clip(parentAnswer, 16));
    const answer = recordedAnswer(input.benchDir, input.candidateHarnessId, task, 0);
    box(`this version ${thisName}`, answer === null ? ['(no recorded answer)'] : clip(answer, 22));
    out('  These are the recorded answers replay sends to the sandbox. Replay never calls a model.');
  }

  heading(`TESTS  ${task}, every run`);
  const line = (label: string, results: readonly RunResult[]): void => {
    const cells = results.map((run, i) => {
      const t = run.tasks.find((x) => x.taskId === task);
      const a = t?.assertions;
      return `run ${i + 1} ${t?.passed ? PASS : FAIL}${a ? ` ${a.pass}/${a.pass + a.fail}` : ''}`;
    });
    out(`  ${label.padEnd(24)} ${cells.join('   ')}`);
  };
  line(`parent ${parentName}`, input.parent);
  line(`this version ${thisName}`, input.candidate);
  out('  The number after each mark is assertions passed, out of the assertions that ran.');

  heading(`EVALS  ${taskIds.length} tasks × ${input.candidate.length} runs, each side`);
  const width = Math.max(...taskIds.map((id) => id.length), 4);
  const runs = input.candidate.length;
  out(`  ${'task'.padEnd(width)}   ${'parent'.padEnd(runs * 2 + 1)}  this version`);
  for (const id of taskIds) {
    const row = (results: readonly RunResult[]): string =>
      results.map((run) => (run.tasks.find((t) => t.taskId === id)?.passed ? PASS : FAIL)).join(' ');
    const moved = (candidatePasses.get(id) ?? 0) > (parentPasses.get(id) ?? 0) ? '  ← fixed' : '';
    out(`  ${id.padEnd(width)}   ${row(input.parent).padEnd(runs * 2 + 1)}  ${row(input.candidate)}${moved}`);
  }
  const totals = (results: readonly RunResult[]): string => results.map((r) => `${r.passed}`).join(' ');
  out(`  ${'passed per run'.padEnd(width)}   ${totals(input.parent).padEnd(runs * 2 + 1)}  ${totals(input.candidate)}`);
  out('');
}
