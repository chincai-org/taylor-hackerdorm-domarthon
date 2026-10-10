/**
 * Build the `BenchSpec` and the bench id from `bench/tasks/`. SPEC.md §6.2, §10.3.
 *
 * `BenchSpec.tasks[i].testsId` is `contentId({ protocol: 'petri/tests/1', source })`.
 * Editing one test therefore changes the bench id, and every older node then names a
 * benchmark that no longer exists. Treat tasks as append-only after the first
 * accepted node.
 */
import { join } from 'node:path';
import { byteCompare } from '../../src/core/canonical.js';
import { benchIdOf } from '../../src/core/ids.js';
import type { BenchSpec, BenchTask } from '../../src/core/schema.js';
import { DEFAULT_TASKS_DIR, loadAllTasks } from './taskLoader.js';

export const BENCH_PROTOCOL = 'petri/bench/1';
export const DEFAULT_BENCH_NAME = 'petri-bench-v1';

/**
 * The task directory inside a benchmark root. SPEC.md §10.2 puts the 20 task
 * directories under `<bench>/tasks/`.
 *
 * `petri init --bench <dir>` and `Ctx.benchDir` both name the benchmark ROOT.
 * `buildBenchSpec` takes the TASKS directory. This function is the one place that
 * knows the difference, so no caller joins the path by hand.
 */
export function tasksDirOf(benchRoot: string): string {
  return join(benchRoot, 'tasks');
}

/** Build the spec from the task directories. Tasks are ordered by task id, ascending. */
export function buildBenchSpec(
  tasksDir: string = DEFAULT_TASKS_DIR,
  name: string = DEFAULT_BENCH_NAME,
): BenchSpec {
  const tasks: BenchTask[] = loadAllTasks(tasksDir).map((task) => ({
    id: task.id,
    testCount: task.meta.testCount,
    testsId: task.testsId,
  }));
  tasks.sort((a, b) => byteCompare(a.id, b.id));
  return { protocol: BENCH_PROTOCOL, id: name, tasks, total: tasks.length };
}

/** The spec and its content id together. `petri bench id` prints both. */
export function buildBench(
  tasksDir: string = DEFAULT_TASKS_DIR,
  name: string = DEFAULT_BENCH_NAME,
): { spec: BenchSpec; id: string } {
  const spec = buildBenchSpec(tasksDir, name);
  return { spec, id: benchIdOf(spec) };
}
