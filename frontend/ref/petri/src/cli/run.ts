/**
 * `petri run <nodeId>` and `petri evals <nodeId>`.
 *
 * `run` asks the harness for an answer and prints it. The tests do NOT run, so
 * there is no score. It shows the work: the task in, the code out.
 *
 * `evals` runs the whole benchmark 5 times: the harness answers, the tests run
 * in the sandbox, and every task result is printed with the median score.
 *
 * Neither command signs anything, writes to the log, or sends anything to
 * Hedera. `petri verify` does that, and only another key's verify makes a
 * version count.
 */
import type { Command } from 'commander';

import { loadSolve, materialiseHarness } from '../../bench/src/runner.js';
import { loadTask } from '../../bench/src/taskLoader.js';
import { harnessId } from '../core/ids.js';
import type { Mode, PetriNode } from '../core/schema.js';
import { ModelPool } from '../model/client.js';
import { FixtureMissingError } from '../model/replay.js';
import { scratchHarnessRoot } from '../store/paths.js';
import { shortId } from './banner.js';
import { globalOptions, openCtx, out, parseMode, resolveNodeId, type Ctx } from './context.js';
import { EXIT, fail } from './exit.js';
import { loadBench, measure, seedsFor } from './measure.js';
import { box, clip, heading } from './trace.js';
import { loadTree } from './tree.js';
import { verifyBlocker } from './verify.js';

const RUN_TASKS = 3;
const EVAL_RUNS = 5;

interface Shared {
  ctx: Ctx;
  node: PetriNode;
  id: string;
  mode: Mode;
  allowGraded: boolean;
  taskIds: string[];
  taskCount: number;
}

interface Opts { tasks?: string; runs?: string; mode?: string; allowGraded?: boolean }

export function registerRun(program: Command): void {
  program
    .command('run')
    .argument('<nodeId>')
    .option('--tasks <n>', `how many tasks. Default ${RUN_TASKS}. "all" asks for every task.`)
    .option('--mode <mode>', 'live or replay')
    .option('--allow-graded', 'let a missing recorded answer fall back to the graded answers', false)
    .description('ask a version\'s harness for its answers and print them. No tests, no score.')
    .action(async (nodeId: string, opts: Opts, cmd: Command) => {
      await runHarness(await open(nodeId, opts, cmd, String(RUN_TASKS)));
    });

  program
    .command('evals')
    .argument('<nodeId>')
    .option('--tasks <n>', 'how many tasks. Default "all".')
    .option('--runs <odd>', `runs over the benchmark. Default ${EVAL_RUNS}.`)
    .option('--mode <mode>', 'live or replay')
    .option('--allow-graded', 'let a missing recorded answer fall back to the graded answers', false)
    .description('score a version: the tests run on every task, and the median is printed')
    .action(async (nodeId: string, opts: Opts, cmd: Command) => {
      await runEvals(await open(nodeId, opts, cmd, 'all'), parseRunCount(opts.runs ?? String(EVAL_RUNS)));
    });
}

/** Everything both commands need: the node, its harness and the tasks to use. */
async function open(nodeId: string, opts: Opts, cmd: Command, defaultTasks: string): Promise<Shared> {
  const ctx = openCtx(cmd);
  const view = await loadTree(ctx);
  const id = resolveNodeId(ctx.store, nodeId);
  const node = view.nodes.get(id);
  if (node === undefined) fail(EXIT.NOT_FOUND, `no node ${id}`);
  await ctx.closeLog();

  // A guard or the typecheck stopped this change, so its harness never ran.
  const blocked = verifyBlocker(node);
  if (blocked !== null) fail(EXIT.REFUSED, blocked.replace('to verify', 'to run'));

  const stored = harnessId(ctx.store.getHarness(node.manifest.harness));
  if (stored !== node.manifest.harness) {
    fail(EXIT.INTEGRITY, `the stored harness for ${shortId(id)} rehashes to ${stored.slice(0, 12)}`);
  }

  const bench = loadBench(ctx);
  const every = bench.tasks.map((t) => t.id).sort();
  const asked = opts.tasks ?? defaultTasks;
  const wanted = asked === 'all' ? every.length : Number(asked);
  if (!Number.isInteger(wanted) || wanted < 1) {
    fail(EXIT.USAGE, `--tasks must be a whole number or "all", got ${asked}`);
  }
  return {
    ctx,
    node,
    id,
    mode: parseMode(opts.mode, ctx.config.mode),
    allowGraded: opts.allowGraded === true,
    taskIds: every.slice(0, Math.min(every.length, wanted)),
    taskCount: every.length,
  };
}

/** Ask the harness for its answer to each task. The tests never run here. */
async function runHarness(s: Shared): Promise<void> {
  const { ctx, node, id } = s;
  heading(`RUN  ${shortId(id)}  harness ${node.manifest.harness.slice(0, 8)}  mode ${s.mode}`);
  out(`  ${node.manifest.hypothesis}`);
  out('');
  out(`  ${s.taskIds.length} of ${s.taskCount} tasks. The tests do not run here, so there is no score.`);

  const harnessDir = materialiseHarness(
    ctx.store.getHarness(node.manifest.harness),
    scratchHarnessRoot(node.manifest.harness, ctx.root),
  );
  const solve = await loadSolve(harnessDir);
  const pool = new ModelPool({
    mode: s.mode,
    benchDir: ctx.benchDir,
    harnessId: node.manifest.harness,
    allowGraded: s.allowGraded,
  });
  const seed = seedsFor(id, 1)[0]!;

  for (const taskId of s.taskIds) {
    const task = loadTask(taskId, `${ctx.benchDir}/tasks`);
    heading(`TASK  ${taskId}`);
    box('what the harness reads', clip(task.view.prompt, 12));

    let answer: string;
    try {
      const solution = await solve(task.view, pool.makeContext(task.view, 0, seed));
      answer = solution.files.find((f) => f.path === task.meta.entry)?.contents
        ?? `(the harness wrote no ${task.meta.entry})`;
    } catch (err) {
      if (err instanceof FixtureMissingError) {
        fail(
          EXIT.REFUSED,
          `replay has no recorded answers for the harness of ${shortId(id)}, so it cannot run here.\n` +
          '       Ask a real model instead:\n' +
          `         ANTHROPIC_API_KEY=... petri run ${shortId(id)} --mode live`,
        );
      }
      answer = `(the harness failed: ${(err as Error).message})`;
    }
    box(`what the model wrote for ${task.meta.entry}`, clip(answer, 18));
  }

  heading('NEXT');
  out('  Nothing was tested, scored or signed. To score it:');
  out(`    petri evals ${shortId(id)}`);
}

/** The whole benchmark, with the tests, several times. */
async function runEvals(s: Shared, runs: number): Promise<void> {
  const { ctx, node, id } = s;
  heading(`EVALS  ${shortId(id)}  harness ${node.manifest.harness.slice(0, 8)}  mode ${s.mode}`);
  out(`  ${node.manifest.hypothesis}`);
  out('');
  out(`  ${s.taskIds.length} of ${s.taskCount} tasks, ${runs} run${runs === 1 ? '' : 's'}. Nothing is signed or recorded.`);

  let side;
  try {
    side = await measure({
      ctx,
      node: id,
      harness: ctx.store.getHarness(node.manifest.harness),
      harnessId: node.manifest.harness,
      bench: loadBench(ctx),
      mode: s.mode,
      runs,
      seeds: seedsFor(id, runs),
      allowGraded: s.allowGraded,
      taskIds: s.taskIds,
      label: 'evals',
    });
  } catch (err) {
    if (!(err instanceof FixtureMissingError)) throw err;
    fail(
      EXIT.REFUSED,
      `replay has no recorded answers for the harness of ${shortId(id)}, so it cannot be scored here.\n` +
      '       Score it against a real model instead:\n' +
      `         ANTHROPIC_API_KEY=... petri evals ${shortId(id)} --mode live`,
    );
  }

  const first = side.results[0];
  if (first === undefined) fail(EXIT.INTEGRITY, 'the run produced no result');

  heading(`TASKS  ${first.tasks.length} tasks × ${runs} run${runs === 1 ? '' : 's'}`);
  const width = Math.max(...first.tasks.map((t) => t.taskId.length), 4);
  for (const t of first.tasks) {
    const marks = side.results
      .map((r) => (r.tasks.find((x) => x.taskId === t.taskId)?.passed ? '✓' : '✗'))
      .join(' ');
    const a = t.assertions;
    out(`  ${t.taskId.padEnd(width)}   ${marks}   ${a ? `${a.pass} of ${a.pass + a.fail} assertions` : ''}`);
  }

  heading('RESULT');
  for (let i = 0; i < side.records.length; i++) {
    const r = side.records[i]!;
    out(`  run ${i + 1}   ${r.passed} of ${side.total} tasks   ${r.scoreBp}bp   ${r.tokens} tokens`);
  }
  out(`  median  ${side.median.medianBp}bp   (10000bp = every task)`);
  out('');
  out('  Nothing was signed. Another key signs a measurement with:');
  out(`    petri verify ${shortId(id)}`);
}

/**
 * Runs for `evals`. Nothing here is signed, so a single run is allowed. More
 * than one run needs an odd count, because a median needs a middle value.
 */
function parseRunCount(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 99) {
    fail(EXIT.USAGE, `--runs must be a whole number between 1 and 99, got ${value}`);
  }
  if (n > 1 && n % 2 === 0) {
    fail(EXIT.USAGE, `--runs must be 1 or an odd number, got ${n}. An even count has no unique median.`);
  }
  return n;
}
