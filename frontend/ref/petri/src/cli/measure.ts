/**
 * One measured batch: N runs of one harness, medianed.
 *
 * `petri verify` calls this twice, once per side, with the SAME seeds. §6.5: only
 * a delta measured on one machine, in one session, with one seed set, is
 * comparable. An absolute score is not comparable to anything.
 */
import type { BenchSpec, HarnessSnapshot, Mode } from '../core/schema.js';
import { scoreBp } from '../core/schema.js';
import { benchIdOf } from '../core/ids.js';
import type { RunRecord } from '../trust/report.js';
import { seedFor } from '../trust/report.js';
import { buildBenchSpec, tasksDirOf } from '../../bench/src/benchSpec.js';
import { medianOf, type MedianResult } from '../../bench/src/median.js';
import { loadSolve, materialiseHarness, runOnce } from '../../bench/src/runner.js';
import { runResultToCanon, type RunResult } from '../../bench/src/schema.js';
import { ModelPool } from '../model/client.js';
import { scratchHarnessRoot } from '../store/paths.js';
import { buildEnv, note, type Ctx } from './context.js';
import { EXIT, fail } from './exit.js';

/**
 * Load the benchmark and prove it is still the one this tree was pinned to.
 * §10.3: editing one test changes the bench id, and every older node then names
 * a benchmark that no longer exists.
 */
export function loadBench(ctx: Ctx): BenchSpec {
  let spec: BenchSpec;
  try {
    spec = buildBenchSpec(tasksDirOf(ctx.benchDir));
  } catch (err) {
    fail(EXIT.ENVIRONMENT, `the benchmark did not load: ${(err as Error).message}`);
  }
  const id = benchIdOf(spec);
  if (id !== ctx.config.bench.id) {
    fail(
      EXIT.INTEGRITY,
      `the benchmark changed since this tree was created.\n` +
        `       config  ${ctx.config.bench.id}\n` +
        `       on disk ${id}\n` +
        '       Every existing node was measured against the old tasks. Treat tasks as\n' +
        '       append-only, or start a new tree.',
    );
  }
  return spec;
}

export interface MeasureInput {
  ctx: Ctx;
  /** The node under measurement, or 'root' for the empty-harness baseline. */
  node: string;
  harness: HarnessSnapshot;
  harnessId: string;
  bench: BenchSpec;
  mode: Mode;
  runs: number;
  /** seeds[i] is the seed for attempt i. Both sides of a pair share them. */
  seeds: string[];
  allowGraded: boolean;
  taskIds?: string[] | undefined;
  /** A short label for progress output, such as "parent" or "candidate". */
  label: string;
}

export interface MeasureOutput {
  median: MedianResult;
  results: RunResult[];
  records: RunRecord[];
  total: number;
  clean: boolean;
}

export async function measure(input: MeasureInput): Promise<MeasureOutput> {
  const { ctx } = input;
  const env = buildEnv(ctx, input.mode, input.allowGraded);
  // `loadBench` already proved this equals ctx.config.bench.id. Taking it from the
  // spec the caller measured against keeps the two from drifting apart here.
  const benchId = benchIdOf(input.bench);

  note(ctx, `  ${input.label}: ${input.runs} runs of ${input.harnessId.slice(0, 8)} …`);

  // The harness snapshot is content addressed, so one directory per harness id is
  // enough and two measurements of the same harness share it.
  const harnessDir = materialiseHarness(
    input.harness,
    scratchHarnessRoot(input.harnessId, ctx.root),
  );
  const solve = await loadSolve(harnessDir);

  // One pool per batch. It hands `runOnce` the exact ContextFactory it wants, and
  // it remembers whether any task fell back to a graded answer.
  const pool = new ModelPool({
    mode: input.mode,
    benchDir: ctx.benchDir,
    harnessId: input.harnessId,
    allowGraded: input.allowGraded,
  });

  const outcome = await medianOf(
    async (attemptIndex) => {
      const seed = input.seeds[attemptIndex];
      if (seed === undefined) {
        fail(
          EXIT.INTEGRITY,
          `${input.label}: attempt ${attemptIndex} has no derived seed. ` +
            `${input.seeds.length} seeds were supplied for ${input.runs} runs.`,
        );
      }
      const result = await runOnce({
        solve,
        makeContext: pool.makeContext,
        node: input.node,
        harness: input.harnessId,
        bench: benchId,
        mode: input.mode,
        attemptIndex,
        seed,
        env,
        tasksDir: `${ctx.benchDir}/tasks`,
        ...(input.taskIds === undefined ? {} : { taskIds: input.taskIds }),
      });
      note(
        ctx,
        `    ${input.label} run ${attemptIndex}: ${result.passed}/${result.total} = ` +
          `${result.scoreBp}bp${result.tampered ? '  TAMPERED' : ''}`,
      );
      return result;
    },
    {
      node: input.node,
      harness: input.harnessId,
      bench: benchId,
      mode: input.mode,
      repeats: input.runs,
    },
  );

  const records: RunRecord[] = [];
  let total = 0;
  for (let i = 0; i < outcome.runs.length; i++) {
    const result = outcome.runs[i]!;
    // `bench/src/schema.ts` owns this projection. A `RunResult` carries `null`
    // in `exitCode`, `signal` and `assertions` when a task ran cleanly, and
    // canonical JSON forbids `null`. Never hand the raw object to `contentId`.
    const resultId = ctx.store.objects.put(runResultToCanon(result));
    total = result.total;
    if (scoreBp(result.passed, result.total) !== result.scoreBp) {
      fail(
        EXIT.INTEGRITY,
        `${input.label} run ${i}: scoreBp ${result.scoreBp} does not match ` +
          `${result.passed}/${result.total}`,
      );
    }
    records.push({
      passed: result.passed,
      resultId,
      scoreBp: result.scoreBp,
      seed: input.seeds[i]!,
      tokens: result.tokens,
      wallMs: result.wallMs,
    });
  }

  if (records.length !== input.runs) {
    fail(
      EXIT.INTEGRITY,
      `${input.label}: ${records.length} clean runs of ${input.runs}. ` +
        'A short batch cannot support a node.',
    );
  }

  return {
    median: outcome.median,
    results: [...outcome.runs],
    records,
    total,
    clean: !outcome.median.incomplete && !outcome.median.tampered,
  };
}

/** The paired seeds of §6.8. Every honest verifier derives the same list. */
export const seedsFor = (candidateNodeId: string, runs: number): string[] =>
  Array.from({ length: runs }, (_v, i) => seedFor(candidateNodeId, i));
