/**
 * The proposal prompt, and the falsifiability rule it teaches.
 *
 * Two jobs, and they must agree:
 *   1. `buildProposalPrompt` tells the model what a usable proposal looks like.
 *   2. `validateHypothesis` rejects a reply that does not meet the same bar.
 * Both read the same text, `HYPOTHESIS_RULE`, so the bar cannot drift.
 *
 * The prompt pushes the proposer AWAY from what the ledger has already mined out.
 * A saturated area and an exhausted motif are printed as a refusal list, with the
 * one escape hatch each of them has, because §13.3 turns a bare retry into a
 * `rule-violation` node before anything runs.
 */

import { sha256Hex } from '../core/canonical.js';
import type { HarnessSnapshot } from '../core/schema.js';
import { AREA_REGISTRY, type Area } from '../flatten/areas.js';
import type { AreaStat, Digest, MotifStat } from '../flatten/digest.js';
import { MAX_CHANGED_LINES, MAX_FILES } from './guards.js';

/** Characters of parent harness source the prompt may carry. */
export const HARNESS_CHAR_BUDGET = 24_000;

export interface BuiltPrompt {
  readonly system: string;
  readonly user: string;
  /** sha256 of the exact bytes sent. Stored in `Provenance.promptHash`. */
  readonly promptHash: string;
}

/** The hash stored for a proposal nobody prompted a model for. */
export const NO_PROMPT_HASH = sha256Hex('petri/evolve/no-prompt/1');

/** The hash of one prompt pair. */
export function promptHashOf(system: string, user: string): string {
  return sha256Hex(`petri/evolve/prompt/1\n${system}\n--- user ---\n${user}`);
}

/**
 * The key a replay run uses to pick a graded answer for the proposal call.
 * SPEC.md §13.1 step 4.
 */
export function proposalSeedKey(digestHash: string, seed: number): string {
  return sha256Hex(`${digestHash}${seed}`);
}

export const SYSTEM_PROMPT = [
  'You are the proposer in Petri, a tree of agent-harness versions.',
  '',
  'One proposal is one experiment. It states a hypothesis in plain English, changes at',
  'most two files, and is then measured five times by two independent machines.',
  'A rejected node stays in the tree forever, and every later proposer reads it. A',
  'vague guess therefore costs the whole team, twice: once in machine time, and again',
  'in the space it takes up in the record.',
  '',
  'Answer with one JSON object and nothing else. No prose before it. No code fence',
  'around it. No comments inside it.',
].join('\n');

export const HYPOTHESIS_RULE = [
  'A hypothesis is a falsifiable claim about a measurable quantity. It is not an',
  'intention, and it is not a description of the change. Write it in this shape:',
  '',
  '  Because <what the harness does today, a fact you can point at in the files above>,',
  '  <the change> will <raise|lower> <the median score in bp | the tokens per task>',
  '  by at least <number><unit>.',
  '',
  'It must carry all four of these:',
  '  1. a number;',
  '  2. a unit: bp for score, tokens for cost, tasks for the pass count;',
  '  3. a direction: raise, lower, increase, reduce, cut;',
  '  4. the measured quantity: the median, the score, the bp, the tokens, tasks passed.',
  '',
  'These are NOT hypotheses. Each one is refused and asked for again:',
  '  "Better prompts will improve the results."        no number, no quantity',
  '  "This should help the model understand the task." nothing can measure it',
  '  "Add a repair turn."                              an action, not a claim',
  '',
  '`falsifiedIf` names the measurement that proves you wrong. It carries a number too.',
  '  Good: "The median delta over 5 paired runs is below +1000bp."',
  '  Bad:  "The change does not work."',
].join('\n');

const UNIT_RE = /\b\d[\d,._]*\s*(?:bp|basis points?|%|tokens?|tok|k tok|tasks?)\b/i;
const DIRECTION_RE = /\b(?:raise|raises|raising|lower|lowers|lowering|increase|increases|reduce|reduces|cut|cuts|drop|drops|fall|falls|rise|rises|gain|gains|save|saves|shrink|shrinks)\b/i;
const QUANTITY_RE = /\b(?:median|score|scorebp|bp|basis points?|tokens?|tok|pass rate|passed|tasks?)\b/i;
const MAGNITUDE_RE = /\b(?:by|above|below|over|under|to|than|least|most|more|fewer|less)\s+(?:at\s+least\s+|at\s+most\s+|more\s+than\s+|fewer\s+than\s+)?[\d,._]+/i;

/**
 * Check one hypothesis against the rule above.
 * Return null when it passes, or the plain English reason it failed.
 */
export function validateHypothesis(hypothesis: string): string | null {
  const s = hypothesis.trim();
  if (s.length < 30) {
    return 'the hypothesis is shorter than 30 characters, so it cannot state a claim';
  }
  if (!/\d/.test(s)) {
    return 'the hypothesis carries no number, so no measurement can falsify it';
  }
  if (!UNIT_RE.test(s)) {
    return 'the hypothesis carries no unit. Say bp for score, tokens for cost, or tasks';
  }
  if (!DIRECTION_RE.test(s)) {
    return 'the hypothesis states no direction. Say raise, lower, reduce or increase';
  }
  if (!QUANTITY_RE.test(s)) {
    return 'the hypothesis names no measured quantity. Say the median, the score in bp, '
      + 'the tokens per task, or the tasks passed';
  }
  if (!MAGNITUDE_RE.test(s)) {
    return 'the hypothesis states no size for the effect. Say "by at least <number><unit>"';
  }
  return null;
}

/** Check `falsifiedIf`. It must name a measurement, with a number in it. */
export function validateFalsifiedIf(falsifiedIf: string): string | null {
  const s = falsifiedIf.trim();
  if (s.length < 15) return 'falsifiedIf is shorter than 15 characters';
  if (!/\d/.test(s)) {
    return 'falsifiedIf carries no number, so it names no measurement that could refute the claim';
  }
  if (!QUANTITY_RE.test(s) && !UNIT_RE.test(s)) {
    return 'falsifiedIf names no measured quantity. Say the median delta in bp, or the tokens per task';
  }
  return null;
}

/** Every reason this proposal text is not usable. Empty means it is usable. */
export function hypothesisProblems(hypothesis: string, falsifiedIf: string): string[] {
  const out: string[] = [];
  const h = validateHypothesis(hypothesis);
  if (h !== null) out.push(`hypothesis: ${h}`);
  const f = validateFalsifiedIf(falsifiedIf);
  if (f !== null) out.push(`falsifiedIf: ${f}`);
  return out;
}

export interface ProposalPromptInput {
  /** The rendered digest of SPEC.md §12.4, verbatim. */
  readonly digestText: string;
  readonly digest: Digest;
  /** The parent harness the proposer is editing. Keys carry the `harness/` prefix. */
  readonly parentHarness: HarnessSnapshot;
  readonly parentId: string;
  /** `--force-area`. When set, the proposer must use this area. */
  readonly forceArea?: Area | undefined;
  /** The acceptance margin in basis points, from the policy. */
  readonly minDeltaBp: number;
}

const bar = (title: string): string => `\n## ${title}\n`;

function aimSection(digest: Digest, forceArea: Area | undefined): string {
  const byVerdict = (v: string): AreaStat[] => digest.areas.filter((a) => a.verdict === v);
  const lines: string[] = [];

  if (forceArea !== undefined) {
    lines.push(`The operator fixed the area for this node: ${forceArea}.`);
    lines.push(`${AREA_REGISTRY[forceArea].summary}`);
    const probes = AREA_REGISTRY[forceArea].probes;
    if (probes.length > 0) lines.push(`probes: ${probes.join(', ')}`);
    lines.push('Set `primaryArea` to that area. Everything below still applies.');
    lines.push('');
  }

  lines.push('Ranked by what the ledger has already measured.');
  lines.push('');

  const never = digest.neverTried;
  if (never.length > 0) {
    lines.push('1. NEVER TRIED — no node has touched these. One node buys the most information here.');
    for (const a of never) {
      lines.push(`   ${a.padEnd(14)} ${AREA_REGISTRY[a].summary}`);
      const probes = AREA_REGISTRY[a].probes;
      if (probes.length > 0) lines.push(`   ${''.padEnd(14)} probes: ${probes.join(', ')}`);
    }
  } else {
    lines.push('1. NEVER TRIED — none left. Every area has at least one node.');
  }

  const open = byVerdict('OPEN');
  lines.push('');
  lines.push(open.length > 0
    ? `2. OPEN — tried, no verdict yet: ${open.map((a) => `${a.area} (${a.tried} tried)`).join(', ')}`
    : '2. OPEN — none.');

  const productive = byVerdict('PRODUCTIVE');
  lines.push('');
  lines.push(productive.length > 0
    ? `3. PRODUCTIVE — a change here has already won: `
      + `${productive.map((a) => `${a.area} (best ${fmtBp(a.bestDeltaBp)})`).join(', ')}`
    : '3. PRODUCTIVE — none yet.');

  return lines.join('\n');
}

const fmtBp = (bp: number | null): string =>
  bp === null ? 'n/a' : `${bp >= 0 ? '+' : ''}${bp}bp`;

function refusalSection(digest: Digest): string {
  const saturated = digest.areas.filter((a) => a.verdict === 'SATURATED');
  const exhausted: MotifStat[] = digest.exhaustedMotifs;
  const lines: string[] = [];

  if (saturated.length === 0 && exhausted.length === 0) {
    lines.push('The ledger has not mined out any area or motif yet. Nothing is refused.');
    return lines.join('\n');
  }

  lines.push('The ledger has already spent nodes on the following and measured nothing.');
  lines.push('Do not propose them again. A guard rejects the node before it runs, and the');
  lines.push('rejection is recorded as `rule-violation` against your hypothesis.');
  lines.push('');

  for (const a of saturated) {
    lines.push(`  SATURATED AREA   ${a.area.padEnd(14)} `
      + `${a.tried} tried, ${a.accepted} accepted, best ${fmtBp(a.bestDeltaBp)}`);
  }
  for (const m of exhausted) {
    lines.push(`  EXHAUSTED MOTIF  ${`${m.area}/${m.motif}`.padEnd(30)} `
      + `${m.attempts} attempts, best ${fmtBp(m.bestDeltaBp)}, nodes ${m.nodeIds.map(shortId).join(', ')}`);
  }

  lines.push('');
  lines.push('Each has exactly one escape hatch, and it costs you a sentence:');
  lines.push('  - a SATURATED area needs `whyNotUntested`: say what the earlier nodes in that');
  lines.push('    area did NOT test, and why your change is not the same lever.');
  lines.push('  - an EXHAUSTED motif needs `contradicts`: name the node id you disagree with');
  lines.push('    and say what is different this time.');
  lines.push('An empty field is not an argument. Prefer an untried area over a rehearsed one.');
  return lines.join('\n');
}

const shortId = (id: string): string => (id.length > 8 ? id.slice(0, 8) : id);

function harnessSection(snapshot: HarnessSnapshot): string {
  const paths = Object.keys(snapshot).sort();
  const lines: string[] = [];
  let used = 0;
  const dropped: string[] = [];
  for (const p of paths) {
    const body = snapshot[p] ?? '';
    if (used + body.length > HARNESS_CHAR_BUDGET) { dropped.push(p); continue; }
    used += body.length;
    const frozen = p === 'harness/contract.ts' ? '   (FROZEN — you may read it, never write it)' : '';
    lines.push(`--- ${p} ---${frozen}`);
    lines.push(body.endsWith('\n') ? body.slice(0, -1) : body);
    lines.push('');
  }
  if (dropped.length > 0) {
    lines.push(`(${dropped.length} file(s) left out of this prompt for size: ${dropped.join(', ')})`);
  }
  return lines.join('\n');
}

function outputSection(minDeltaBp: number): string {
  return [
    'Reply with exactly this JSON object. Every key is required except where stated.',
    '',
    '{',
    '  "hypothesis":     string, 30-600 chars. The rule in section 5. One claim.',
    '  "falsifiedIf":    string, 15-400 chars. The measurement that refutes it.',
    '  "primaryArea":    one of: ' + Object.keys(AREA_REGISTRY).join(', ') + '.',
    '  "motif":          lowercase slug, words joined by "-", at most 6 words.',
    '                    Reuse a known slug when it fits. Invent one when it does not.',
    '  "metric":         "score" or "tokens". What your predictedDelta measures.',
    '  "predictedDelta": signed non-zero integer. bp for "score", tokens for "tokens".',
    `                    A score win must clear ${minDeltaBp}bp to be accepted.`,
    '  "reasoning":      string, at most 1200 chars. Why you believe the claim.',
    '  "whyNotUntested": string or null. Required when the area is SATURATED.',
    '  "contradicts":    [{ "nodeId": string, "why": string }], at most 3.',
    '                    Required when the motif is EXHAUSTED. Otherwise [].',
    `  "files":          [{ "path": "harness/<name>.ts", "contents": "<full file>" }]`,
    `                    1 to ${MAX_FILES} entries. FULL file contents, never a diff.`,
    '}',
    '',
    'Rules the guards enforce before anything runs:',
    `  - at most ${MAX_FILES} files, at most ${MAX_CHANGED_LINES} changed lines against the parent;`,
    '  - every path matches harness/<lowercase-name>.ts;',
    '  - harness/contract.ts is frozen and may never appear in "files";',
    '  - harness/index.ts must keep exactly:',
    '      export async function solve(task: TaskView, ctx: HarnessContext): Promise<Solution>',
    '  - a harness file may import only "./sibling.js" — no packages, no node builtins;',
    '  - the words require(, import(, eval(, new Function(, process. and globalThis. are banned;',
    '  - the file must compile under tsc --strict with no DOM and no node types.',
  ].join('\n');
}

/** Build the exact prompt sent to the proposer. */
export function buildProposalPrompt(input: ProposalPromptInput): BuiltPrompt {
  const d = input.digest;
  const parts: string[] = [];

  parts.push('# PROPOSE NODE N+1');
  parts.push([
    `tree parent ${input.parentId}`,
    `bench ${d.benchName} (${d.taskCount} tasks, unit tests only), N=${d.runs} runs, MEDIAN`,
    `mode ${d.mode.toUpperCase()} — a ${d.mode} number is never compared against the other mode`,
    `acceptance margin ${input.minDeltaBp}bp, and two independent verifications`,
  ].join('\n'));

  parts.push(bar('1. THE LEDGER, RENDERED'));
  parts.push('Everything below was measured. Nothing in it is an opinion.');
  parts.push('');
  parts.push(input.digestText);

  parts.push(bar('2. THE PARENT HARNESS — THESE ARE THE FILES YOU EDIT'));
  parts.push(harnessSection(input.parentHarness));

  parts.push(bar('3. WHERE TO AIM'));
  parts.push(aimSection(d, input.forceArea));

  parts.push(bar('4. WHAT IS ALREADY MINED OUT — DO NOT REPROPOSE'));
  parts.push(refusalSection(d));

  parts.push(bar('5. THE HYPOTHESIS RULE'));
  parts.push(HYPOTHESIS_RULE);

  parts.push(bar('6. OUTPUT'));
  parts.push(outputSection(input.minDeltaBp));

  const user = parts.join('\n');
  return { system: SYSTEM_PROMPT, user, promptHash: promptHashOf(SYSTEM_PROMPT, user) };
}

/**
 * The one repair turn of SPEC.md §13.1 step 5.
 * It quotes the problems and the previous reply, and asks for the whole object again.
 */
export function buildRepairPrompt(previousReply: string, problems: readonly string[]): string {
  const quoted = previousReply.length > 6000
    ? `${previousReply.slice(0, 6000)}\n… reply cut at 6000 characters`
    : previousReply;
  return [
    'Your reply could not be used. This is the only retry.',
    '',
    'Problems:',
    ...problems.map((p) => `  - ${p}`),
    '',
    'Your previous reply, verbatim, between the markers:',
    '<<<REPLY',
    quoted,
    'REPLY>>>',
    '',
    'Send the whole JSON object again, corrected. One object, nothing else, no code fence.',
    'Keep the parts that were already right. Fix only what is listed above.',
  ].join('\n');
}
