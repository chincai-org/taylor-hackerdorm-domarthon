/**
 * The bench record types. SPEC.md §10.3 and §10.8.
 *
 * This file owns `TaskMetaSchema`, `Outcome`, `TaskOutcome` and `RunResult`.
 * Every number here is an integer, so every record survives canonicalJson.
 *
 * Layer L3. It may import L0 (`src/core/*`) and `harness/contract.ts`. Nothing else.
 */
import { z } from 'zod';
import type { Canon } from '../../src/core/canonical.js';
import type { Mode } from '../../src/core/schema.js';

/** One task directory, as `bench/tasks/<id>/task.json` declares it. SPEC.md §10.3. */
export const TaskMetaSchema = z.strictObject({
  specVersion: z.literal(1),
  id: z.string().regex(/^\d{2}-[a-z0-9-]+$/),
  title: z.string().min(8).max(90),
  difficulty: z.enum(['easy', 'medium', 'hard']),
  entry: z.string().regex(/^[a-z0-9-]+\.mjs$/),
  exports: z.array(z.string().regex(/^[A-Za-z_$][\w$]*$/)).min(1),
  signatures: z.array(z.string().min(3).max(300)).min(1),
  timeoutMs: z.int().min(1000).max(60000),
  testCount: z.int().min(1),
  tags: z.array(z.string()).default([]),
});
export type TaskMeta = z.infer<typeof TaskMetaSchema>;

/** How one task run ended. SPEC.md §10.6. */
export type Outcome = 'pass' | 'fail' | 'timeout' | 'crash' | 'tampered' | 'no_attestation';

/**
 * The machine the measurement ran on. Descriptive. The accept rule never reads it.
 * SPEC.md §6.5 prints this shape beside `VerificationReport`, in `src/trust/report.ts`.
 * `bench` sits at L3 and may not import `src/trust`, so the shape is restated here.
 * TypeScript is structural, so the two are the same type.
 */
export interface EnvDescriptor {
  arch: string;
  benchId: string;
  ledger: string;
  mode: string;
  model: string;
  nodeVersion: string;
  petriCommit: string;
  platform: string;
}

/** The result of one task inside one run. SPEC.md §10.8. */
export interface TaskOutcome {
  taskId: string;
  outcome: Outcome;
  passed: boolean;
  exitCode: number | null;
  signal: string | null;
  assertions: { pass: number; fail: number } | null;
  wallMs: number; // The sandbox child only.
  harnessMs: number; // The time the harness took to write the file.
  tokens: number; // Model tokens the harness spent on this task. 0 in replay.
}

/** One whole pass over the benchmark. Stored in the object store. SPEC.md §10.8. */
export interface RunResult {
  protocol: 'petri/run/1';
  runId: string; // uuid v4
  node: string; // The node under measurement, or "root".
  harness: string; // Hex64. The harness id.
  bench: string; // Hex64. The bench id.
  mode: Mode; // Required. No default.
  attemptIndex: number; // 0-based, inside one median batch.
  seed: string; // Hex64. seedFor(candidateNodeId, attemptIndex).
  startedAt: number; // Unix milliseconds.
  passed: number; // Tasks whose tests all passed.
  total: number; // The task count.
  scoreBp: number; // scoreBp(passed, total)
  tasks: TaskOutcome[]; // Length equals total. Ordered by taskId.
  tokens: number; // The sum over tasks.
  wallMs: number; // The whole run, harness time included.
  tampered: boolean; // True when any task outcome was `tampered`.
  env: EnvDescriptor;
}

/**
 * A bench failure that carries a SPEC.md §14.1 exit code.
 * `src/cli/exit.ts` reads `exitCode` structurally, so this needs no import from
 * `src/core/errors.ts`, which sits outside the bench import list.
 */
export class BenchError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode: number) {
    super(message);
    this.name = 'BenchError';
    this.exitCode = exitCode;
  }
}

/**
 * Drop the null-valued keys, so a `RunResult` can be hashed.
 *
 * SPEC.md §2 bans `null` from every canonical payload, and §10.8 declares three
 * nullable fields. §13.2 already fixes the rule for that case: the writer drops the
 * key and the reader applies the default. Absent means absent.
 * `RunRecord.resultId` of §6.5 is `contentId(runResultToCanon(result))`.
 */
export function runResultToCanon(result: RunResult): Canon {
  return {
    attemptIndex: result.attemptIndex,
    bench: result.bench,
    env: {
      arch: result.env.arch,
      benchId: result.env.benchId,
      ledger: result.env.ledger,
      mode: result.env.mode,
      model: result.env.model,
      nodeVersion: result.env.nodeVersion,
      petriCommit: result.env.petriCommit,
      platform: result.env.platform,
    },
    harness: result.harness,
    mode: result.mode,
    node: result.node,
    passed: result.passed,
    protocol: result.protocol,
    runId: result.runId,
    scoreBp: result.scoreBp,
    seed: result.seed,
    startedAt: result.startedAt,
    tampered: result.tampered,
    tasks: result.tasks.map(taskOutcomeToCanon),
    tokens: result.tokens,
    total: result.total,
    wallMs: result.wallMs,
  };
}

/**
 * The deterministic part of a run: what it measured, with nothing about the machine
 * or the moment it ran.
 *
 * SPEC.md §18.1 asks two honest verifiers in replay mode to produce the same value
 * for each run, so a verifier who invented numbers can be caught. `contentId` of the
 * whole `RunResult` cannot serve, because §10.8 puts a uuid, two wall clocks and an
 * `EnvDescriptor` inside it, and those differ on every machine by design. This
 * projection drops exactly those fields.
 */
export function runDigestInput(result: RunResult): Canon {
  return {
    attemptIndex: result.attemptIndex,
    bench: result.bench,
    harness: result.harness,
    mode: result.mode,
    node: result.node,
    passed: result.passed,
    protocol: result.protocol,
    scoreBp: result.scoreBp,
    seed: result.seed,
    tampered: result.tampered,
    tasks: result.tasks.map((task) => {
      const one: Record<string, Canon> = {
        outcome: task.outcome,
        passed: task.passed,
        taskId: task.taskId,
      };
      if (task.assertions !== null) {
        one['assertions'] = { fail: task.assertions.fail, pass: task.assertions.pass };
      }
      return one;
    }),
    total: result.total,
  };
}

function taskOutcomeToCanon(task: TaskOutcome): Canon {
  const out: Record<string, Canon> = {
    harnessMs: task.harnessMs,
    outcome: task.outcome,
    passed: task.passed,
    taskId: task.taskId,
    tokens: task.tokens,
    wallMs: task.wallMs,
  };
  if (task.exitCode !== null) out['exitCode'] = task.exitCode;
  if (task.signal !== null) out['signal'] = task.signal;
  if (task.assertions !== null) {
    out['assertions'] = { fail: task.assertions.fail, pass: task.assertions.pass };
  }
  return out;
}
