/**
 * Task discovery. SPEC.md §10.2, §10.3.
 *
 * This file reads a task directory and returns the prompt and the spec SEPARATELY.
 * `LoadedTask.view` is the only value that ever reaches a harness. It carries no
 * path, no directory handle and no test text, so nothing HANDS the harness a test.
 *
 * That is a type signature, and a type signature is not a boundary: it says what
 * the runner passes, not what the harness can go and take. SPEC.md §10.1 property
 * 1 is enforced in `harnessJail.ts`, which runs the harness in a child process
 * that holds one read grant over a directory the tests are not in.
 *
 * `LoadedTask.specSource` is the test text. Only the runner and the sandbox read
 * it, and neither ever writes it to disk.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { byteCompare, contentId } from '../../src/core/canonical.js';
import { REPO_ROOT } from '../../src/core/root.js';
import type { SourceFile, SymbolSpec, TaskView } from '../../harness/contract.js';
import { BenchError, TaskMetaSchema, type TaskMeta } from './schema.js';

/** The tasks of this checkout. `petri init --bench <dir>` overrides it. */
export const DEFAULT_TASKS_DIR = join(REPO_ROOT, 'bench', 'tasks');

/** A task directory name, and therefore a task id. SPEC.md §10.3. */
export const TASK_ID_RE = /^\d{2}-[a-z0-9-]+$/;

export const TESTS_PROTOCOL = 'petri/tests/1';

/** One task, loaded. The harness sees `view` and nothing else. */
export interface LoadedTask {
  readonly id: string;
  readonly dir: string;
  readonly meta: TaskMeta;
  /** Everything the harness may see. Never the tests. */
  readonly view: TaskView;
  /** `test.mjs`, verbatim. NEVER put this in `view`. NEVER write it to disk at run time. */
  readonly specSource: string;
  /** `contentId({ protocol: 'petri/tests/1', source })`. SPEC.md §10.3. */
  readonly testsId: string;
}

/**
 * Count the top-level `test(…)` calls.
 * Top level means column zero, which is how every task file is written.
 * A nested or indented call belongs to a suite and does not count.
 */
export function countTopLevelTests(source: string): number {
  const re = /^(?:await\s+)?test\s*\(/gm;
  let count = 0;
  while (re.exec(source) !== null) count += 1;
  return count;
}

/**
 * Read the constraint lines out of a `## Rules` section of PROMPT.md.
 * Deterministic, and it needs no extra field in `task.json`.
 */
export function extractConstraints(prompt: string): string[] {
  const out: string[] = [];
  let inRules = false;
  for (const line of prompt.split('\n')) {
    if (/^#{1,6}\s/.test(line)) {
      inRules = /^#{1,6}\s+rules\s*$/i.test(line.trim());
      continue;
    }
    if (!inRules) continue;
    const item = /^\s*(?:\d+[.)]|[-*])\s+(.+)$/.exec(line);
    const text = item?.[1]?.trim();
    if (text !== undefined && text.length > 0) out.push(text);
  }
  return out;
}

/** Every task id under `tasksDir`, ascending. */
export function listTaskIds(tasksDir: string = DEFAULT_TASKS_DIR): string[] {
  if (!existsSync(tasksDir)) {
    throw new BenchError(`petri bench: no task directory at ${tasksDir}`, 2);
  }
  const ids: string[] = [];
  for (const entry of readdirSync(tasksDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (!TASK_ID_RE.test(entry.name)) continue;
    ids.push(entry.name);
  }
  ids.sort(byteCompare);
  return ids;
}

/**
 * Load one task directory and check both invariants of SPEC.md §10.3.
 * It throws on any failure. A silently weakened benchmark is worse than no benchmark.
 */
export function loadTask(taskId: string, tasksDir: string = DEFAULT_TASKS_DIR): LoadedTask {
  const dir = join(tasksDir, taskId);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new BenchError(`petri bench: no task directory at ${dir}`, 2);
  }

  const metaPath = join(dir, 'task.json');
  const promptPath = join(dir, 'PROMPT.md');
  const specPath = join(dir, 'test.mjs');
  for (const required of [metaPath, promptPath, specPath]) {
    if (!existsSync(required)) {
      throw new BenchError(`petri bench: task ${taskId} is missing ${required}`, 2);
    }
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(metaPath, 'utf8'));
  } catch (err) {
    throw new BenchError(
      `petri bench: ${metaPath} is not JSON: ${err instanceof Error ? err.message : String(err)}`,
      5,
    );
  }
  const parsed = TaskMetaSchema.safeParse(raw);
  if (!parsed.success) {
    throw new BenchError(`petri bench: ${metaPath} is invalid: ${parsed.error.message}`, 5);
  }
  const meta = parsed.data;

  if (meta.id !== taskId) {
    throw new BenchError(
      `petri bench: ${metaPath} declares id "${meta.id}" but sits in directory "${taskId}"`,
      5,
    );
  }
  if (meta.exports.length !== meta.signatures.length) {
    throw new BenchError(
      `petri bench: task ${taskId} has ${meta.exports.length} exports and ` +
        `${meta.signatures.length} signatures. They must match, in order.`,
      5,
    );
  }

  const specSource = readFileSync(specPath, 'utf8');
  const found = countTopLevelTests(specSource);
  if (found !== meta.testCount) {
    throw new BenchError(
      `petri bench: task ${taskId} declares testCount ${meta.testCount} but test.mjs has ` +
        `${found} top-level test() calls. Deleting a test weakens the benchmark in silence.`,
      5,
    );
  }

  const prompt = readFileSync(promptPath, 'utf8');
  const exportedSymbols: SymbolSpec[] = meta.exports.map((name, i) => ({
    name,
    signature: meta.signatures[i] ?? name,
  }));

  const view: TaskView = {
    taskId: meta.id,
    prompt,
    entryFile: meta.entry,
    exportedSymbols,
    starterFiles: readStarterFiles(join(dir, 'starter')),
    constraints: extractConstraints(prompt),
    language: 'javascript',
  };

  return {
    id: meta.id,
    dir,
    meta,
    view,
    specSource,
    testsId: contentId({ protocol: TESTS_PROTOCOL, source: specSource }),
  };
}

/** Load every task, or the named subset, ordered by task id. */
export function loadAllTasks(
  tasksDir: string = DEFAULT_TASKS_DIR,
  taskIds?: readonly string[],
): LoadedTask[] {
  const ids = [...(taskIds ?? listTaskIds(tasksDir))].sort(byteCompare);
  if (ids.length === 0) {
    throw new BenchError(`petri bench: no tasks found in ${tasksDir}`, 2);
  }
  return ids.map((id) => loadTask(id, tasksDir));
}

/** Read `starter/` into read-only context files. Never tests. Ordered by UTF-8 bytes. */
function readStarterFiles(starterDir: string): SourceFile[] {
  if (!existsSync(starterDir)) return [];
  const files: SourceFile[] = [];
  const walk = (abs: string, rel: string): void => {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const childAbs = join(abs, entry.name);
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(childAbs, childRel);
      else if (entry.isFile()) files.push({ path: childRel, contents: readFileSync(childAbs, 'utf8') });
    }
  };
  walk(starterDir, '');
  files.sort((a, b) => byteCompare(a.path, b.path));
  return files;
}
