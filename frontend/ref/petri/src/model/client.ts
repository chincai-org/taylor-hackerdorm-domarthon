/**
 * ONE model interface, two implementations, and the runner-side machinery that
 * the harness may read but may never raise. See SPEC.md sections 11.2 to 11.5.
 *
 * The interface is `ModelClient` in harness/contract.ts. It is frozen.
 *   live    src/model/anthropic.ts   @anthropic-ai/sdk, model `claude-sonnet-5`
 *   replay  src/model/replay.ts      recorded fixtures, then graded answers
 *
 * SELECTION IS BY ENVIRONMENT. `ANTHROPIC_API_KEY` set means live. Nothing set
 * means replay, and replay is a complete path: design rule 6 says the whole
 * machine must run with no key at all. `createModelClient` RETURNS the chosen
 * mode, because that mode is stamped onto the node, onto every RunResult and
 * into the signed report, where `evaluate` refuses to compare it across modes.
 *
 * This file also owns the two things the runner lends the harness:
 *   Budget  — counted here, never by the harness. Overspending rejects the call
 *             with BudgetExceededError, which the runner scores as a task fault.
 *   Logger  — the trace. The harness writes events into it and cannot forge it.
 */
import { BudgetExceededError } from '../../harness/contract.js';
import type {
  Budget, BudgetState, HarnessContext, Logger,
  ModelClient, ModelRequest, ModelResponse,
} from '../../harness/contract.js';
import { environmentError, usageError } from '../core/errors.js';
import type { Mode } from '../core/schema.js';
import { AnthropicClient, DEFAULT_MAX_OUTPUT_TOKENS, LIVE_MODEL_ID } from './anthropic.js';
import {
  createReplayClient, REPO_ROOT,
  type ReplayClientOptions, type ReplayModelClient,
} from './replay.js';

/** EnvDescriptor.model in replay mode. SPEC.md section 6.5. `null` is banned. */
export const REPLAY_MODEL_LABEL = 'none';
/** EnvDescriptor.model once a graded answer was served. SPEC.md section 11.5. */
export const GRADED_MODEL_LABEL = 'graded';

/* -------------------------------------------------------------------------- */
/* The budget                                                                  */
/* -------------------------------------------------------------------------- */

export interface BudgetLimits {
  readonly maxCalls: number;
  readonly maxTokens: number;
  readonly maxWallMs: number;
}

/** SPEC.md section 11.2. The default budget for one solve call. */
export const DEFAULT_LIMITS: BudgetLimits = {
  maxCalls: 8,
  maxTokens: 120_000,
  maxWallMs: 120_000,
};

/**
 * The runner's budget for one task.
 *
 * The wall clock here is the REAL clock, not the frozen one the harness reads
 * through `ctx.now`. A frozen clock cannot stop a harness that hangs.
 */
export class RunBudget implements Budget {
  readonly maxCalls: number;
  readonly maxTokens: number;
  readonly maxWallMs: number;
  private calls = 0;
  private tokens = 0;
  private readonly clock: () => number;
  private readonly startedAt: number;

  constructor(limits: BudgetLimits = DEFAULT_LIMITS, clock: () => number = Date.now) {
    this.maxCalls = limits.maxCalls;
    this.maxTokens = limits.maxTokens;
    this.maxWallMs = limits.maxWallMs;
    this.clock = clock;
    this.startedAt = clock();
  }

  get callsUsed(): number { return this.calls; }
  get tokensUsed(): number { return this.tokens; }

  msLeft(): number {
    return Math.max(0, this.maxWallMs - (this.clock() - this.startedAt));
  }

  state(): BudgetState {
    return {
      callsUsed: this.calls,
      callsLeft: Math.max(0, this.maxCalls - this.calls),
      tokensUsed: this.tokens,
      tokensLeft: Math.max(0, this.maxTokens - this.tokens),
      msLeft: this.msLeft(),
    };
  }

  /**
   * Admit one more call, or reject it.
   *
   * The call is counted before it runs. A call that starts and then fails has
   * still been spent, and a harness that retries a failing call must not get a
   * free budget.
   */
  admit(label: string): void {
    if (this.calls >= this.maxCalls) {
      throw new BudgetExceededError('calls',
        `petri: call "${label}" refused. The budget of ${this.maxCalls} model calls is spent.`);
    }
    if (this.tokens >= this.maxTokens) {
      throw new BudgetExceededError('tokens',
        `petri: call "${label}" refused. The budget of ${this.maxTokens} tokens is spent `
        + `(${this.tokens} used).`);
    }
    if (this.msLeft() <= 0) {
      throw new BudgetExceededError('wall',
        `petri: call "${label}" refused. The budget of ${this.maxWallMs}ms of wall time is spent.`);
    }
    this.calls += 1;
  }

  /** Charge one completed call. Input and output tokens both count. */
  charge(inputTokens: number, outputTokens: number): void {
    this.tokens += Math.max(0, inputTokens) + Math.max(0, outputTokens);
  }
}

/* -------------------------------------------------------------------------- */
/* The trace                                                                   */
/* -------------------------------------------------------------------------- */

export interface TraceEvent {
  readonly at: number;
  readonly kind: string;
  readonly data: Record<string, unknown>;
}

/** A harness that logs in a loop must not be able to exhaust memory. */
export const MAX_TRACE_EVENTS = 500;

export class TraceLogger implements Logger {
  readonly events: TraceEvent[] = [];
  private truncated = false;
  private readonly clock: () => number;
  private readonly sink: ((event: TraceEvent) => void) | null;

  constructor(clock: () => number = Date.now, sink?: (event: TraceEvent) => void) {
    this.clock = clock;
    this.sink = sink ?? null;
  }

  event(kind: string, data?: Record<string, unknown>): void {
    if (this.events.length >= MAX_TRACE_EVENTS) {
      if (!this.truncated) {
        this.truncated = true;
        this.events.push({
          at: this.clock(), kind: 'trace:truncated',
          data: { limit: MAX_TRACE_EVENTS },
        });
      }
      return;
    }
    const event: TraceEvent = { at: this.clock(), kind, data: data ?? {} };
    this.events.push(event);
    if (this.sink !== null) this.sink(event);
  }
}

/* -------------------------------------------------------------------------- */
/* The budget enforcer                                                         */
/* -------------------------------------------------------------------------- */

const MAX_LABEL_LENGTH = 64;

export interface BudgetedClientOptions {
  /** The hard ceiling on one reply, whatever the harness asks for. */
  readonly maxOutputTokens?: number;
}

/**
 * The client every harness actually receives.
 *
 * It validates the request, enforces the budget, charges the cost and records
 * the call in the trace. It adds nothing to the reply.
 */
export class BudgetedClient implements ModelClient {
  private readonly inner: ModelClient;
  private readonly budget: RunBudget;
  private readonly log: Logger;
  private readonly maxOutputTokens: number;
  private readonly seenLabels = new Set<string>();

  constructor(
    inner: ModelClient, budget: RunBudget, log: Logger, opts: BudgetedClientOptions = {},
  ) {
    this.inner = inner;
    this.budget = budget;
    this.log = log;
    this.maxOutputTokens = opts.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  }

  async complete(req: ModelRequest): Promise<ModelResponse> {
    // The contract says a label is REQUIRED and labels must be distinct. A
    // duplicate makes the trace unreadable, so it is a harness fault, not a
    // silent rename.
    if (typeof req.label !== 'string' || req.label.trim().length === 0) {
      throw usageError('petri: ModelRequest.label is required. Name the call site, e.g. "draft".');
    }
    if (req.label.length > MAX_LABEL_LENGTH) {
      throw usageError(`petri: ModelRequest.label is over ${MAX_LABEL_LENGTH} characters.`);
    }
    if (this.seenLabels.has(req.label)) {
      throw usageError(
        `petri: the label "${req.label}" was already used in this solve call. `
        + 'Labels must be distinct. Number a repeated call site, e.g. "repair#1", "repair#2".',
      );
    }
    if (req.messages.length === 0) {
      throw usageError(`petri: call "${req.label}" carries no messages.`);
    }
    this.seenLabels.add(req.label);

    this.budget.admit(req.label);

    // The harness may ask for less. It may never ask for more than is left.
    const wanted = Math.floor(req.maxTokens ?? this.maxOutputTokens);
    if (wanted <= 0) {
      throw usageError(`petri: call "${req.label}" asks for ${wanted} output tokens.`);
    }
    const cap = Math.max(1, Math.min(wanted, this.maxOutputTokens, this.budget.state().tokensLeft));
    const sent: ModelRequest = cap === req.maxTokens ? req : { ...req, maxTokens: cap };

    this.log.event('model:call', { label: req.label, maxTokens: cap });
    let reply: ModelResponse;
    try {
      reply = await this.inner.complete(sent);
    } catch (e) {
      this.log.event('model:error', {
        label: req.label,
        error: e instanceof Error ? e.message : String(e),
      });
      throw e;
    }
    this.budget.charge(reply.inputTokens, reply.outputTokens);
    this.log.event('model:usage', {
      label: req.label,
      stopReason: reply.stopReason,
      inputTokens: reply.inputTokens,
      outputTokens: reply.outputTokens,
      tokensLeft: this.budget.state().tokensLeft,
    });
    return reply;
  }
}

/* -------------------------------------------------------------------------- */
/* The harness context                                                         */
/* -------------------------------------------------------------------------- */

/** 2025-01-01T00:00:00.000Z. The same instant the sandbox freezes. Section 10.6. */
export const FROZEN_CLOCK_MS = 1735689600000;

/** A 32-bit mulberry32 stream, folded out of the Hex64 run seed. Deterministic. */
export function seededRng(seed: string): () => number {
  let state = 0x9e3779b9;
  for (let i = 0; i + 8 <= seed.length; i += 8) {
    state = (state ^ Number.parseInt(seed.slice(i, i + 8), 16)) >>> 0;
  }
  if (seed.length === 0) state = 1;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface HarnessContextOptions {
  readonly model: ModelClient;
  readonly budget: Budget;
  readonly log: Logger;
  /** Hex64. seedFor(candidateNodeId, attemptIndex). */
  readonly seed: string;
  /** The frozen clock the harness reads. Defaults to FROZEN_CLOCK_MS. */
  readonly nowMs?: number;
}

/**
 * Build the context the frozen `solve` receives.
 *
 * `rng` is seeded from the run seed and `now` is frozen, so two honest machines
 * running the same node in replay mode produce the same bytes. The budget clock
 * is the real one; only the harness-visible clock is frozen.
 */
export function createHarnessContext(opts: HarnessContextOptions): HarnessContext {
  const frozen = opts.nowMs ?? FROZEN_CLOCK_MS;
  return {
    model: opts.model,
    budget: opts.budget,
    log: opts.log,
    rng: seededRng(opts.seed),
    now: () => frozen,
  };
}

/* -------------------------------------------------------------------------- */
/* Selection                                                                   */
/* -------------------------------------------------------------------------- */

/** Live when ANTHROPIC_API_KEY holds something. Replay otherwise. Section 4.3. */
export function detectMode(env: NodeJS.ProcessEnv = process.env): Mode {
  const key = env['ANTHROPIC_API_KEY'];
  return typeof key === 'string' && key.trim().length > 0 ? 'live' : 'replay';
}

export interface ModelRunContext {
  /** Hex64. The harness snapshot under measurement. It keys the fixtures. */
  readonly harnessId: string;
  readonly taskId: string;
  /** 0-based, inside one median batch. It keys the fixtures. */
  readonly attemptIndex: number;
  /** Hex64. seedFor(candidateNodeId, attemptIndex). */
  readonly seed: string;
}

export interface ModelClientOptions {
  readonly run: ModelRunContext;
  /** Force a mode. Default: detectMode(env). */
  readonly mode?: Mode;
  readonly env?: NodeJS.ProcessEnv;
  /** Overrides env.ANTHROPIC_API_KEY in live mode. */
  readonly apiKey?: string;
  readonly liveModel?: string;
  readonly limits?: BudgetLimits;
  readonly maxOutputTokens?: number;
  readonly fixturesDir?: string;
  readonly tasksDir?: string;
  /** Let a fixture miss fall back to the graded answers. Default false. */
  readonly allowGraded?: boolean;
  /** The real clock, for the wall budget and the trace. Injectable for tests. */
  readonly clock?: () => number;
  readonly budget?: RunBudget;
  readonly log?: TraceLogger;
}

export interface ModelSelection {
  /** The client the harness gets. The budget is already enforced on it. */
  readonly client: ModelClient;
  /** The chosen mode. Stamp it on the node, the RunResult and the report. */
  readonly mode: Mode;
  /** 'claude-sonnet-5' in live mode, 'none' in replay mode. */
  readonly model: string;
  readonly budget: RunBudget;
  readonly log: TraceLogger;
  /** 'graded' once a graded answer was served, otherwise `model`. */
  effectiveModel(): string;
  /** The cost the fixtures recorded. Both are 0 in live mode. */
  recorded(): { tokens: number; harnessMs: number };
}

/**
 * Build the model client for one task attempt, and say which mode it is.
 *
 * Live needs a key. Replay needs none. Asking for live with no key is an
 * ENVIRONMENT failure with a message that names the fix, never a silent
 * downgrade to replay: a run labelled live that never called a model would
 * corrupt every comparison in the tree.
 */
export function createModelClient(opts: ModelClientOptions): ModelSelection {
  const env = opts.env ?? process.env;
  const mode: Mode = opts.mode ?? detectMode(env);
  const clock = opts.clock ?? Date.now;
  const budget = opts.budget ?? new RunBudget(opts.limits ?? DEFAULT_LIMITS, clock);
  const log = opts.log ?? new TraceLogger(clock);

  let inner: ModelClient;
  let model: string;
  let replay: ReplayModelClient | null = null;

  if (mode === 'live') {
    const apiKey = (opts.apiKey ?? env['ANTHROPIC_API_KEY'] ?? '').trim();
    if (apiKey.length === 0) {
      throw environmentError(
        'petri: mode is live but ANTHROPIC_API_KEY is not set.\n'
        + '  Set the key, or run with --mode replay. Replay needs no key and the\n'
        + '  sandbox still runs for real. A replay number is never comparable to a\n'
        + '  live one, and Petri refuses to compare them.',
      );
    }
    const live = new AnthropicClient({
      apiKey,
      model: opts.liveModel ?? LIVE_MODEL_ID,
      onNotice: (kind, data) => { log.event(kind, data); },
    });
    inner = live;
    model = live.model;
  } else {
    const replayOpts: ReplayClientOptions = {
      harnessId: opts.run.harnessId,
      taskId: opts.run.taskId,
      attemptIndex: opts.run.attemptIndex,
      seed: opts.run.seed,
      ...(opts.fixturesDir !== undefined ? { dir: opts.fixturesDir } : {}),
      ...(opts.tasksDir !== undefined ? { tasksDir: opts.tasksDir } : {}),
      ...(opts.allowGraded !== undefined ? { allowGraded: opts.allowGraded } : {}),
    };
    replay = createReplayClient(replayOpts);
    inner = replay;
    model = REPLAY_MODEL_LABEL;
  }

  const client = new BudgetedClient(inner, budget, log,
    opts.maxOutputTokens === undefined ? {} : { maxOutputTokens: opts.maxOutputTokens });

  return {
    client,
    mode,
    model,
    budget,
    log,
    effectiveModel: (): string =>
      (replay !== null && replay.usedGraded() ? GRADED_MODEL_LABEL : model),
    recorded: (): { tokens: number; harnessMs: number } =>
      (replay !== null ? replay.recorded() : { tokens: 0, harnessMs: 0 }),
  };
}

/* -------------------------------------------------------------------------- */
/* The ergonomic factory the runner and the CLI use                            */
/* -------------------------------------------------------------------------- */

export const DEFAULT_BENCH_DIR = `${REPO_ROOT}/bench`;

export interface MakeModelClientOptions {
  /** Hex64. The harness snapshot under measurement. */
  readonly harnessId: string;
  readonly taskId: string;
  readonly attemptIndex: number;
  /** Hex64. seedFor(candidateNodeId, attemptIndex). */
  readonly seed: string;
  /** Force a mode. Default: live when ANTHROPIC_API_KEY is set, else replay. */
  readonly mode?: Mode;
  /** The benchmark root. `fixtures/` and `tasks/` hang off it. */
  readonly benchDir?: string;
  readonly allowGraded?: boolean;
  readonly env?: NodeJS.ProcessEnv;
  readonly apiKey?: string;
  readonly liveModel?: string;
  readonly limits?: BudgetLimits;
  readonly maxOutputTokens?: number;
  readonly clock?: () => number;
  readonly budget?: RunBudget;
  readonly log?: TraceLogger;
}

/**
 * One call, one task attempt, one client, and the mode it chose.
 *
 * This is `createModelClient` with the paths a caller actually holds: the bench
 * directory rather than two directories under it.
 */
export function makeModelClient(opts: MakeModelClientOptions): ModelSelection {
  const benchDir = opts.benchDir ?? DEFAULT_BENCH_DIR;
  return createModelClient({
    run: {
      harnessId: opts.harnessId,
      taskId: opts.taskId,
      attemptIndex: opts.attemptIndex,
      seed: opts.seed,
    },
    fixturesDir: `${benchDir}/fixtures`,
    tasksDir: `${benchDir}/tasks`,
    ...(opts.mode !== undefined ? { mode: opts.mode } : {}),
    ...(opts.allowGraded !== undefined ? { allowGraded: opts.allowGraded } : {}),
    ...(opts.env !== undefined ? { env: opts.env } : {}),
    ...(opts.apiKey !== undefined ? { apiKey: opts.apiKey } : {}),
    ...(opts.liveModel !== undefined ? { liveModel: opts.liveModel } : {}),
    ...(opts.limits !== undefined ? { limits: opts.limits } : {}),
    ...(opts.maxOutputTokens !== undefined ? { maxOutputTokens: opts.maxOutputTokens } : {}),
    ...(opts.clock !== undefined ? { clock: opts.clock } : {}),
    ...(opts.budget !== undefined ? { budget: opts.budget } : {}),
    ...(opts.log !== undefined ? { log: opts.log } : {}),
  });
}

export type ModelPoolOptions = Omit<MakeModelClientOptions, 'taskId' | 'attemptIndex' | 'seed'>;

/**
 * One model client per task, for one whole benchmark run.
 *
 * `HarnessContext` is fresh for every task, so the budget and the trace are
 * fresh too and a harness can carry no state between tasks. The pool keeps every
 * selection, so the caller can still ask one question of the whole run: did any
 * task fall back to a graded answer? That answer decides `env.model`.
 *
 * `makeContext` has the exact shape bench/src/runner.ts wants for its
 * `ContextFactory`, so the runner needs no adapter and no import from this layer.
 */
export class ModelPool {
  readonly mode: Mode;
  readonly selections: ModelSelection[] = [];
  private readonly base: ModelPoolOptions;

  constructor(base: ModelPoolOptions) {
    this.base = base;
    this.mode = base.mode ?? detectMode(base.env ?? process.env);
  }

  /** Build the client and the context for one task of one attempt. */
  select(taskId: string, attemptIndex: number, seed: string): ModelSelection {
    const selection = makeModelClient({ ...this.base, taskId, attemptIndex, seed });
    this.selections.push(selection);
    return selection;
  }

  makeContext = (
    task: { readonly taskId: string }, attemptIndex: number, seed: string,
  ): HarnessContext => {
    const selection = this.select(task.taskId, attemptIndex, seed);
    return createHarnessContext({
      model: selection.client,
      budget: selection.budget,
      log: selection.log,
      seed,
    });
  };

  /** 'graded' when any task drew a graded answer. Otherwise the declared model. */
  effectiveModel(): string {
    for (const s of this.selections) {
      if (s.effectiveModel() === GRADED_MODEL_LABEL) return GRADED_MODEL_LABEL;
    }
    return this.mode === 'live' ? (this.base.liveModel ?? LIVE_MODEL_ID) : REPLAY_MODEL_LABEL;
  }

  /** The recorded cost of every fixture this run replayed. Zero in live mode. */
  recorded(): { tokens: number; harnessMs: number } {
    let tokens = 0;
    let harnessMs = 0;
    for (const s of this.selections) {
      const r = s.recorded();
      tokens += r.tokens;
      harnessMs += r.harnessMs;
    }
    return { tokens, harnessMs };
  }
}
