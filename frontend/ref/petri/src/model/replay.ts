/**
 * The REPLAY model clients. See SPEC.md sections 10.10 and 11.5.
 *
 * Two clients live here because replay has two different jobs.
 *
 *   1. FixtureModelClient replays a RECORDED live measurement. It is keyed by
 *      (harnessId, taskId, attemptIndex), and it reads the fixture store that
 *      ships under bench/fixtures/. A miss is a HARD ERROR. It never falls back
 *      to a live call, and it never invents an answer, because a replay batch
 *      that borrowed real numbers would be indistinguishable from a real one.
 *
 *   2. GradedModelClient answers a prompt NO fixture has seen, which is what
 *      `petri submit --mode replay` needs, because every new harness sends a new
 *      prompt. It picks one of the graded answers shipped with each task. It is
 *      reached only when --allow-graded is passed, and the run then records
 *      env.model 'graded'.
 *
 * Neither client calls a model. Neither needs an API key. The SANDBOX still runs
 * for real: replay replaces the harness call and nothing else.
 *
 * ---------------------------------------------------------------------------
 * THE PUBLISHED GRADING RULES. bench/RULES.md must state these, word for word.
 *
 * The five grades, best first:
 *   correct, off_by_one, missing_edge_case, wrong_api, syntax_error
 *
 * R1. A request that carries the FULL SIGNATURES cannot draw `wrong_api`.
 *     "Carries the full signatures" means every string in task.json.signatures
 *     appears somewhere in the system text or the message text.
 * R2. A request that carries a WORKED EXAMPLE cannot draw `syntax_error`.
 *     "Carries a worked example" means the SYSTEM text contains a fenced code
 *     block. The system text is written by the harness, never by PROMPT.md, so
 *     this rule measures the harness and not the task.
 * R3. A REPAIR TURN that quotes an error returns one grade better. A repair turn
 *     is a request that contains an assistant message and whose last user
 *     message contains the text "Error".
 * R4. The draw is `sha256("petri/graded/1|" + seed + "|" + taskId + "|" + label
 *     + "|" + system + "\n" + joined message text)`. The first 8 hex characters,
 *     read as an integer, index the remaining grades uniformly.
 * R5. The reported cost is deterministic: ceil(requestChars / 4) input tokens
 *     and ceil(answerChars / 4) output tokens. No clock and no randomness.
 *
 * The rules are fully deterministic, so two machines draw the same grade. They
 * are also falsifiable: adding the signatures removes a failing grade from the
 * draw, so it must raise the median. That is a real environment, not a mock.
 * ---------------------------------------------------------------------------
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { sha256Hex } from '../core/canonical.js';
import { integrityError, notFoundError, PetriError } from '../core/errors.js';
import { REPO_ROOT } from '../core/root.js';
import { Hex64 } from '../core/schema.js';
import type { ModelClient, ModelRequest, ModelResponse } from '../../harness/contract.js';

export { REPO_ROOT };
export const FIXTURES_DIR = `${REPO_ROOT}/bench/fixtures`;
export const TASKS_DIR = `${REPO_ROOT}/bench/tasks`;
export const FIXTURE_INDEX_FILE = 'index.json';
/** The snapshot sidecar. It is a Petri addition. */
export const FIXTURE_HARNESSES_FILE = 'harnesses.json';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

export const FixtureSchema = z.strictObject({
  protocol: z.literal('petri/fixture/1'),
  harness: Hex64,
  taskId: z.string().min(1).max(64),
  attemptIndex: z.int().min(0).max(98),
  /** The solution source the recorded harness produced. */
  source: z.string(),
  /** The recorded cost. It is used as the cost. It is never zeroed. */
  tokens: z.int().min(0),
  /** The recorded time the harness took to write the file. */
  harnessMs: z.int().min(0),
  recordedAt: z.string().min(1).max(64),
  recordedFrom: z.strictObject({
    runId: z.string().max(64),
    model: z.string().min(1).max(64),
    bench: z.string().max(64),
  }),
  /** sha256Hex(source). Checked on every load. */
  contentHash: Hex64,
  /** Optional split of `tokens`. When both are present they must sum to it. */
  inputTokens: z.int().min(0).optional(),
  outputTokens: z.int().min(0).optional(),
  /**
   * Optional replies for call 1, 2, ... of the SAME attempt. A harness with a
   * repair turn makes more than one call per task, and the fixture key has no
   * room for a call index. `repairs[k]` answers call k + 1.
   */
  repairs: z.array(z.string()).max(16).optional(),
});
export type Fixture = z.infer<typeof FixtureSchema>;

export const FixtureIndexSchema = z.strictObject({
  protocol: z.literal('petri/fixtures.index/1'),
  generatedAt: z.string().min(1).max(64),
  bench: Hex64,
  entries: z.array(z.strictObject({
    harness: Hex64,
    taskId: z.string().min(1).max(64),
    attempts: z.int().min(1).max(99),
    contentHashes: z.array(Hex64).min(1).max(99),
  })).max(4000),
});
export type FixtureIndex = z.infer<typeof FixtureIndexSchema>;

/**
 * The harness snapshots the shipped fixtures were recorded against.
 *
 * SPEC.md keys a fixture by harness id but never says how a reader turns that id
 * back into files. Without this sidecar a fresh clone cannot materialise the
 * harness a fixture belongs to, so the starter fixtures could not be used.
 */
export const FixtureHarnessesSchema = z.strictObject({
  protocol: z.literal('petri/fixtures.harnesses/1'),
  generatedAt: z.string().min(1).max(64),
  /** The snapshot key shape these ids were hashed with, e.g. "harness/<file>". */
  pathShape: z.string().min(1).max(64),
  harnesses: z.array(z.strictObject({
    harness: Hex64,
    label: z.string().min(1).max(64),
    note: z.string().max(400),
    expectedPassed: z.int().min(0).max(1000),
    files: z.record(z.string().min(1).max(512), z.string()),
  })).min(1).max(64),
});
export type FixtureHarnesses = z.infer<typeof FixtureHarnessesSchema>;

export const fixturePath = (
  dir: string, harnessId: string, taskId: string, attemptIndex: number,
): string => `${dir}/${harnessId}/${taskId}/${attemptIndex}.json`;

/** Every harness id that has a fixture directory. Used to write a useful error. */
export function recordedHarnessIds(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^[0-9a-f]{64}$/.test(e.name))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * A fixture the store does not hold.
 *
 * `fatal` stops the whole command instead of scoring one task 0. A missing
 * fixture is not a harness defect, so charging the harness for it would corrupt
 * the measurement. bench/src/runner.ts `isFatal` reads this flag.
 */
export class FixtureMissingError extends PetriError {
  readonly fatal = true;
  constructor(message: string) {
    super('NOT_FOUND', message);
    this.name = 'FixtureMissingError';
  }
}

/** A fixture whose bytes no longer match what was recorded. Never recoverable. */
export class FixtureCorruptError extends PetriError {
  readonly fatal = true;
  constructor(message: string) {
    super('INTEGRITY', message);
    this.name = 'FixtureCorruptError';
  }
}

function missingFixture(
  dir: string, harnessId: string, taskId: string, attemptIndex: number, what: string,
): FixtureMissingError {
  const known = recordedHarnessIds(dir);
  const list = known.length === 0
    ? '    (none: the fixture store is empty)'
    : known.map((h) => `    ${h}`).join('\n');
  return new FixtureMissingError(
    `petri: no fixture for ${what}.\n`
    + `  harness  ${harnessId}\n`
    + `  task     ${taskId}\n`
    + `  attempt  ${attemptIndex}\n`
    + `  path     ${fixturePath(dir, harnessId, taskId, attemptIndex)}\n`
    + '  Replay mode never calls a model, so it cannot invent this answer.\n'
    + '  Fix it in one of three ways:\n'
    + '    1. allow the published graded answers:  add --allow-graded\n'
    + '    2. measure this harness live, which calls the model for real:\n'
    + '       ANTHROPIC_API_KEY=... pnpm petri verify <nodeId> --mode live\n'
    + '    3. measure a harness the fixture store already holds:\n'
    + `${list}`,
  );
}

/** Read one fixture. Throw on a miss, on a bad shape, and on a hash mismatch. */
export function loadFixture(
  dir: string, harnessId: string, taskId: string, attemptIndex: number,
): Fixture {
  const path = fixturePath(dir, harnessId, taskId, attemptIndex);
  if (!existsSync(path)) {
    throw missingFixture(dir, harnessId, taskId, attemptIndex, 'this harness, task and attempt');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new FixtureCorruptError(`petri: ${path} is not valid JSON: ${(e as Error).message}`);
  }
  const parsed = FixtureSchema.safeParse(raw);
  if (!parsed.success) {
    throw new FixtureCorruptError(`petri: ${path} is not a petri/fixture/1: ${parsed.error.message}`);
  }
  const fx = parsed.data;
  if (fx.harness !== harnessId || fx.taskId !== taskId || fx.attemptIndex !== attemptIndex) {
    throw new FixtureCorruptError(
      `petri: ${path} is filed under the wrong key. It names harness ${fx.harness}, `
      + `task ${fx.taskId}, attempt ${fx.attemptIndex}.`,
    );
  }
  // Rule 2 of SPEC.md section 10.10. A mismatch aborts the run.
  const hash = sha256Hex(fx.source);
  if (hash !== fx.contentHash) {
    throw new FixtureCorruptError(
      `petri: ${path} contentHash does not match its source.\n`
      + `  recorded  ${fx.contentHash}\n  computed  ${hash}\n`
      + '  The fixture was edited after it was recorded. Record it again.',
    );
  }
  if (fx.inputTokens !== undefined && fx.outputTokens !== undefined
      && fx.inputTokens + fx.outputTokens !== fx.tokens) {
    throw new FixtureCorruptError(
      `petri: ${path} splits ${fx.inputTokens} + ${fx.outputTokens} tokens, `
      + `but records ${fx.tokens} in total.`,
    );
  }
  return fx;
}

export function loadFixtureIndex(dir: string = FIXTURES_DIR): FixtureIndex {
  const path = `${dir}/${FIXTURE_INDEX_FILE}`;
  if (!existsSync(path)) {
    throw notFoundError(
      `petri: no fixture index at ${path}.\n`
      + '  Replay mode reads its answers from that file. A checkout ships one under\n'
      + '  bench/fixtures/. Restore it, or measure with --mode live and an API key.',
    );
  }
  const parsed = FixtureIndexSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
  if (!parsed.success) {
    throw integrityError(`petri: ${path} is not a petri/fixtures.index/1: ${parsed.error.message}`);
  }
  return parsed.data;
}

/**
 * Rule 5 of SPEC.md section 10.10. Fixtures recorded against other tasks may be
 * displayed. They may never be measured.
 */
export function assertFixtureBench(index: FixtureIndex, benchId: string): void {
  if (index.bench !== benchId) {
    throw integrityError(
      'petri: the fixtures were recorded against a different benchmark.\n'
      + `  fixtures  ${index.bench}\n  current   ${benchId}\n`
      + '  Editing one test changes the bench id. Record the fixtures again.',
    );
  }
}

export function loadFixtureHarnesses(dir: string = FIXTURES_DIR): FixtureHarnesses | null {
  const path = `${dir}/${FIXTURE_HARNESSES_FILE}`;
  if (!existsSync(path)) return null;
  const parsed = FixtureHarnessesSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
  if (!parsed.success) {
    throw integrityError(`petri: ${path} is malformed: ${parsed.error.message}`);
  }
  return parsed.data;
}

/* -------------------------------------------------------------------------- */
/* Reply shaping                                                               */
/* -------------------------------------------------------------------------- */

const FENCE = '```';

/**
 * A recorded answer is stored as bare source, so a human can read it. A real
 * model replies with a fenced block, so the reply is rebuilt in that shape and
 * every harness that looks for a fence still works. A source that already holds
 * a fence is returned bare, because wrapping it would nest two fences.
 */
export function asReplyText(source: string): string {
  if (source.includes(FENCE)) return source;
  return `${FENCE}js\n${source.replace(/\s+$/, '')}\n${FENCE}\n`;
}

/* -------------------------------------------------------------------------- */
/* The fixture client                                                          */
/* -------------------------------------------------------------------------- */

export interface FixtureClientOptions {
  readonly dir?: string;
  readonly harnessId: string;
  readonly taskId: string;
  readonly attemptIndex: number;
}

export class FixtureModelClient implements ModelClient {
  readonly dir: string;
  readonly harnessId: string;
  readonly taskId: string;
  readonly attemptIndex: number;
  private callIndex = 0;
  private tokens = 0;
  private harnessMs = 0;

  constructor(opts: FixtureClientOptions) {
    this.dir = opts.dir ?? FIXTURES_DIR;
    this.harnessId = opts.harnessId;
    this.taskId = opts.taskId;
    this.attemptIndex = opts.attemptIndex;
  }

  /** The recorded cost of every fixture this client served. */
  recorded(): { tokens: number; harnessMs: number } {
    return { tokens: this.tokens, harnessMs: this.harnessMs };
  }

  async complete(_req: ModelRequest): Promise<ModelResponse> {
    const call = this.callIndex;
    this.callIndex += 1;
    const fx = loadFixture(this.dir, this.harnessId, this.taskId, this.attemptIndex);

    if (call === 0) {
      this.tokens += fx.tokens;
      this.harnessMs += fx.harnessMs;
      const outputTokens = fx.outputTokens ?? fx.tokens;
      const inputTokens = fx.inputTokens ?? Math.max(0, fx.tokens - outputTokens);
      return {
        text: asReplyText(fx.source),
        stopReason: 'end_turn',
        inputTokens,
        outputTokens,
      };
    }

    const repair = fx.repairs?.[call - 1];
    if (repair === undefined) {
      throw missingFixture(
        this.dir, this.harnessId, this.taskId, this.attemptIndex,
        `model call ${call} of this attempt. The fixture records `
        + `${fx.repairs?.length ?? 0} extra reply(s), so this harness asks for more `
        + 'calls than the recording holds',
      );
    }
    // A recorded repair reply carries no separate cost line. Charge the reply
    // text at the published graded rate so the budget still moves.
    const outputTokens = Math.ceil(repair.length / 4);
    this.tokens += outputTokens;
    return { text: asReplyText(repair), stopReason: 'end_turn', inputTokens: 0, outputTokens };
  }
}

/* -------------------------------------------------------------------------- */
/* The graded-answer client                                                    */
/* -------------------------------------------------------------------------- */

/** Best first. The order IS the ladder that rule R3 walks up. */
export const GRADES = [
  'correct', 'off_by_one', 'missing_edge_case', 'wrong_api', 'syntax_error',
] as const;
export type Grade = (typeof GRADES)[number];

const TaskSignaturesSchema = z.object({ signatures: z.array(z.string()).default([]) });

export interface GradedClientOptions {
  readonly tasksDir?: string;
  readonly taskId: string;
  /** Hex64. The run seed. It makes the draw deterministic across machines. */
  readonly seed: string;
  /** task.json signatures. Read from disk when it is not given. */
  readonly signatures?: readonly string[];
}

export class GradedModelClient implements ModelClient {
  readonly tasksDir: string;
  readonly taskId: string;
  private readonly seed: string;
  private readonly signatures: readonly string[];
  private readonly drawn: Grade[] = [];

  constructor(opts: GradedClientOptions) {
    this.tasksDir = opts.tasksDir ?? TASKS_DIR;
    this.taskId = opts.taskId;
    this.seed = opts.seed;
    this.signatures = opts.signatures ?? readTaskSignatures(this.tasksDir, this.taskId);
  }

  /** Every grade this client drew, in call order. Observational. */
  grades(): readonly Grade[] { return this.drawn; }

  async complete(req: ModelRequest): Promise<ModelResponse> {
    const system = req.system ?? '';
    const body = req.messages.map((m) => m.content).join('\n');
    const all = `${system}\n${body}`;

    // R1. Every declared signature must appear, so half a signature list does
    // not earn the reward.
    const hasSignatures = this.signatures.length > 0
      && this.signatures.every((s) => all.includes(s));
    // R2. The system text is harness-written. PROMPT.md never reaches it.
    const hasWorkedExample = system.includes(FENCE);
    // R3. A repair turn is a second turn that quotes an error back.
    const lastUser = [...req.messages].reverse().find((m) => m.role === 'user');
    const isRepair = req.messages.some((m) => m.role === 'assistant')
      && (lastUser?.content ?? '').includes('Error');

    let allowed: Grade[] = [...GRADES];
    if (hasSignatures) allowed = allowed.filter((g) => g !== 'wrong_api');
    if (hasWorkedExample) allowed = allowed.filter((g) => g !== 'syntax_error');

    // R4. One hash, one index. No clock, no randomness.
    const digest = sha256Hex(`petri/graded/1|${this.seed}|${this.taskId}|${req.label}|${all}`);
    let index = Number.parseInt(digest.slice(0, 8), 16) % allowed.length;
    if (isRepair) index = Math.max(0, index - 1);
    const grade = allowed[index]!;
    this.drawn.push(grade);

    const source = readGradedAnswer(this.tasksDir, this.taskId, grade);
    // R5. A deterministic cost, so a replay median is reproducible.
    return {
      text: asReplyText(source),
      stopReason: 'end_turn',
      inputTokens: Math.ceil(all.length / 4),
      outputTokens: Math.ceil(source.length / 4),
    };
  }
}

function readTaskSignatures(tasksDir: string, taskId: string): readonly string[] {
  const path = `${tasksDir}/${taskId}/task.json`;
  if (!existsSync(path)) {
    throw notFoundError(
      `petri: no task metadata at ${path}. The graded client needs task.json to `
      + 'know which signatures count as "the full signatures".',
    );
  }
  const parsed = TaskSignaturesSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
  if (!parsed.success) {
    throw integrityError(`petri: ${path} has no usable signatures: ${parsed.error.message}`);
  }
  return parsed.data.signatures;
}

function readGradedAnswer(tasksDir: string, taskId: string, grade: Grade): string {
  const path = `${tasksDir}/${taskId}/answers/${grade}.mjs`;
  if (!existsSync(path)) {
    let present = '(the answers directory is missing)';
    try {
      present = readdirSync(`${tasksDir}/${taskId}/answers`).sort().join(', ');
    } catch { /* the directory is missing; the default text already says so */ }
    throw notFoundError(
      `petri: task ${taskId} has no graded answer for "${grade}".\n`
      + `  path     ${path}\n`
      + `  present  ${present}\n`
      + `  Every task needs all ${GRADES.length} graded answers: ${GRADES.join(', ')}.`,
    );
  }
  return readFileSync(path, 'utf8');
}

/* -------------------------------------------------------------------------- */
/* The replay client the runner actually gets                                  */
/* -------------------------------------------------------------------------- */

export interface ReplayClientOptions extends FixtureClientOptions {
  /** Hex64. Needed only when the graded fallback is allowed. */
  readonly seed: string;
  readonly tasksDir?: string;
  /** Default false. SPEC.md section 11.5: a miss is a hard error without it. */
  readonly allowGraded?: boolean;
}

/**
 * Fixtures first. The graded answers are a fallback and only with --allow-graded.
 * A CORRUPT fixture never falls back: a bad hash is evidence, not a miss.
 */
export class ReplayModelClient implements ModelClient {
  readonly fixtures: FixtureModelClient;
  readonly graded: GradedModelClient | null;
  private usedGradedAnswer = false;

  constructor(opts: ReplayClientOptions) {
    const fixtureOpts: FixtureClientOptions = opts.dir === undefined
      ? { harnessId: opts.harnessId, taskId: opts.taskId, attemptIndex: opts.attemptIndex }
      : {
        dir: opts.dir, harnessId: opts.harnessId,
        taskId: opts.taskId, attemptIndex: opts.attemptIndex,
      };
    this.fixtures = new FixtureModelClient(fixtureOpts);
    this.graded = opts.allowGraded === true
      ? new GradedModelClient(
        opts.tasksDir === undefined
          ? { taskId: opts.taskId, seed: opts.seed }
          : { tasksDir: opts.tasksDir, taskId: opts.taskId, seed: opts.seed },
      )
      : null;
  }

  /** True once a graded answer was served. The run must then record model 'graded'. */
  usedGraded(): boolean { return this.usedGradedAnswer; }

  recorded(): { tokens: number; harnessMs: number } { return this.fixtures.recorded(); }

  async complete(req: ModelRequest): Promise<ModelResponse> {
    try {
      return await this.fixtures.complete(req);
    } catch (e) {
      if (this.graded === null || !(e instanceof FixtureMissingError)) throw e;
      this.usedGradedAnswer = true;
      return this.graded.complete(req);
    }
  }
}

export const createReplayClient = (opts: ReplayClientOptions): ReplayModelClient =>
  new ReplayModelClient(opts);
