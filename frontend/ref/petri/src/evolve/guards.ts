/**
 * The guards of SPEC.md §13.3.
 *
 * A guard never throws. It returns a plain English reason, or null when the
 * proposal is clean. The caller turns the first reason into a `MechanicalResult`
 * and writes the node anyway. A failed experiment is a record, not a crash.
 *
 * These guards are an EARLY WARNING, not the boundary. They run over a proposal,
 * so they can tell a proposer what is out of bounds before a measurement is
 * wasted. What actually stops a harness from reading the benchmark tests is the
 * child process in `bench/src/harnessJail.ts`, and what actually scans every file
 * of a harness, inherited files included, is `scanHarnessSnapshot` below, called
 * again as a hard gate by `bench/src/runner.ts` before any harness runs.
 *
 * `checkSandbox` and `scanHarnessSnapshot` have ONE implementation, in
 * `bench/src/harnessScan.ts`. Evolve sits at L4 and bench at L3, so the rule lives
 * in the lower layer, where the runtime boundary that backs it also lives.
 */

import {
  checkHarnessPathShape, checkSandbox, scanHarnessSnapshot,
  ENTRY_FILE, HARNESS_PREFIX,
} from '../../bench/src/harnessScan.js';
import type { ScanFailure } from '../../bench/src/harnessScan.js';
import type { HarnessSnapshot } from '../core/schema.js';
import type { MechanicalClass, Proposal } from './schema.js';

export { checkSandbox, scanHarnessSnapshot, ENTRY_FILE, HARNESS_PREFIX };
export type { ScanFailure };

/** At most 2 files change in one node. SPEC.md §13.3. */
export const MAX_FILES = 2;
/** At most 120 changed lines in one node. Added plus removed. */
export const MAX_CHANGED_LINES = 120;
/** SPEC.md §11.1 rule 2. A patch that touches this file is rejected. */
export const IMMUTABLE_FILES: readonly string[] = ['harness/contract.ts'];

const SOLVE_RE = /export\s+async\s+function\s+solve\s*\(\s*task\s*:\s*TaskView\s*,\s*ctx\s*:\s*HarnessContext\s*\)\s*:\s*Promise<Solution>/;

/** One failed guard, with the machine class that names it. */
export interface GuardFailure {
  readonly cls: Exclude<MechanicalClass, 'ok'>;
  readonly message: string;
}

/** What the digest says is already mined out. Both lists come from SPEC.md §12.2. */
export interface DigestFacts {
  readonly saturatedAreas: readonly string[];
  readonly exhaustedMotifs: readonly string[];
}

export const NO_DIGEST_FACTS: DigestFacts = Object.freeze({
  saturatedAreas: [], exhaustedMotifs: [],
});

/** A path must sit inside `harness/`, and it must not be the frozen contract. */
export function checkPath(path: string): string | null {
  const shape = checkHarnessPathShape(path);
  if (shape !== null) return shape;
  if (IMMUTABLE_FILES.includes(path)) {
    return `${path} is frozen. SPEC.md §11.1 rule 2 forbids any change to it.`;
  }
  return null;
}

/** The entry point keeps its signature forever. SPEC.md §11.1 rule 1. */
export function checkContract(path: string, contents: string): string | null {
  if (path !== ENTRY_FILE) return null;
  if (!SOLVE_RE.test(contents)) {
    return `${ENTRY_FILE} no longer exports `
      + '`export async function solve(task: TaskView, ctx: HarnessContext): Promise<Solution>`. '
      + 'The entry signature is frozen.';
  }
  return null;
}

/**
 * The two rules the digest imposes on a proposer.
 * A saturated area needs an argument. An exhausted motif needs a contradiction.
 */
export function checkRules(proposal: Proposal, facts: DigestFacts): string | null {
  if (facts.saturatedAreas.includes(proposal.primaryArea) && proposal.whyNotUntested === null) {
    return `area "${proposal.primaryArea}" is SATURATED in the digest. `
      + 'Fill `whyNotUntested` with what is different this time, or pick another area.';
  }
  if (facts.exhaustedMotifs.includes(proposal.motif) && proposal.contradicts.length === 0) {
    return `motif "${proposal.motif}" is EXHAUSTED in the digest. `
      + 'Fill `contradicts` with the node you disagree with and why, or pick another motif.';
  }
  return null;
}

/** File count and changed-line count. The line count comes from the real diff. */
export function checkPatchSize(fileCount: number, changedLines: number): string | null {
  if (fileCount > MAX_FILES) {
    return `${fileCount} files changed. The limit is ${MAX_FILES}.`;
  }
  if (changedLines > MAX_CHANGED_LINES) {
    return `${changedLines} changed lines. The limit is ${MAX_CHANGED_LINES}.`;
  }
  return null;
}

export interface GuardInput {
  readonly proposal: Proposal;
  /** Added plus removed lines, measured against the parent snapshot. */
  readonly changedLines: number;
  readonly facts: DigestFacts;
  /**
   * The COMPLETE candidate snapshot: the parent harness with the proposal applied.
   *
   * Give it, and every file is scanned, including files this proposal never
   * touched. Leave it out, and only the changed files are scanned here — the
   * complete scan then still runs, as a hard error rather than a recorded
   * rejection, in `bench/src/runner.ts` before the harness is allowed to run.
   */
  readonly snapshot?: HarnessSnapshot | undefined;
}

/**
 * Run every guard in the order of the SPEC.md §13.3 table.
 * Return the FIRST failure, or null when the proposal may proceed to the typecheck.
 */
export function runGuards(input: GuardInput): GuardFailure | null {
  const { proposal, changedLines, facts } = input;

  for (const f of proposal.files) {
    const bad = checkPath(f.path);
    if (bad !== null) return { cls: 'patch-out-of-bounds', message: bad };
  }

  const paths = proposal.files.map((f) => f.path);
  const duplicate = paths.find((p, i) => paths.indexOf(p) !== i);
  if (duplicate !== undefined) {
    return { cls: 'patch-out-of-bounds', message: `path "${duplicate}" appears twice` };
  }

  const size = checkPatchSize(proposal.files.length, changedLines);
  if (size !== null) return { cls: 'patch-too-large', message: size };

  // The complete snapshot when the caller has it, the changed files otherwise.
  // A file inherited unchanged from a parent is not safe because nobody looked.
  if (input.snapshot !== undefined) {
    const bad = scanHarnessSnapshot(input.snapshot);
    if (bad !== null) return { cls: 'sandbox-violation', message: bad.message };
  } else {
    for (const f of proposal.files) {
      const bad = checkSandbox(f.path, f.contents);
      if (bad !== null) return { cls: 'sandbox-violation', message: bad };
    }
  }

  for (const f of proposal.files) {
    const bad = checkContract(f.path, f.contents);
    if (bad !== null) return { cls: 'contract-violation', message: bad };
  }

  const rule = checkRules(proposal, facts);
  if (rule !== null) return { cls: 'rule-violation', message: rule };

  return null;
}
