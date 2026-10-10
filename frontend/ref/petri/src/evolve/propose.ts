/**
 * The model call, the parse, and the one repair turn. SPEC.md §13.1 steps 4 and 5.
 *
 * Nothing here throws on a bad reply. A model that returns prose, or a vague
 * intention instead of a falsifiable claim, produces a `malformed-proposal`
 * outcome carrying the verbatim reply. The caller still writes a node.
 */

import type { ChatMessage, ModelClient } from '../../harness/contract.js';
import { buildRepairPrompt, hypothesisProblems, type BuiltPrompt } from './prompt.js';
import { ProposalSchema, type Proposal } from './schema.js';

/** The label of the first proposal call. Labels must be distinct per solve. */
export const PROPOSAL_LABEL = 'proposal';
/** SPEC.md §13.1 step 5 names this label. */
export const REPAIR_LABEL = 'proposal-repair';

export const DEFAULT_MAX_TOKENS = 8192;

export type ParseResult =
  | { readonly ok: true; readonly proposal: Proposal }
  | { readonly ok: false; readonly problems: string[] };

/**
 * Pull one JSON object out of a reply.
 * It tolerates a code fence and leading prose, because a model adds both, and
 * losing a whole run to a stray backtick teaches the tree nothing.
 */
export function extractJsonObject(text: string): string | null {
  const fenced = /```(?:json)?\s*\n([\s\S]*?)```/.exec(text);
  const body = fenced !== null ? fenced[1]! : text;
  const start = body.indexOf('{');
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < body.length; i++) {
    const c = body[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return body.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Parse one reply into a `Proposal`.
 * The falsifiability check runs here, beside the schema check, so a vague
 * hypothesis and a missing key are handled by the same single repair turn.
 */
export function parseProposalText(text: string): ParseResult {
  const json = extractJsonObject(text);
  if (json === null) {
    return { ok: false, problems: ['the reply carries no JSON object. Send one object and nothing else'] };
  }

  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (err) {
    return { ok: false, problems: [`the JSON does not parse: ${(err as Error).message}`] };
  }

  const parsed = ProposalSchema.safeParse(value);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => {
      const path = i.path.length > 0 ? i.path.join('.') : '(root)';
      return `${path}: ${i.message}`;
    });
    return { ok: false, problems: problems.length > 0 ? problems : ['the object does not match the schema'] };
  }

  const vague = hypothesisProblems(parsed.data.hypothesis, parsed.data.falsifiedIf);
  if (vague.length > 0) return { ok: false, problems: vague };

  return { ok: true, proposal: parsed.data };
}

export interface ProposeInput {
  readonly model: ModelClient;
  readonly prompt: BuiltPrompt;
  readonly maxTokens?: number | undefined;
  readonly temperature?: number | undefined;
}

export interface ProposeAttempt {
  readonly label: string;
  readonly text: string;
  readonly problems: readonly string[];
}

export type ProposeOutcome =
  | {
      readonly ok: true;
      readonly proposal: Proposal;
      readonly attempts: readonly ProposeAttempt[];
      readonly repaired: boolean;
    }
  | {
      readonly ok: false;
      readonly attempts: readonly ProposeAttempt[];
      readonly repaired: boolean;
      /** Verbatim material for `MechanicalResult.evidence`. */
      readonly evidence: string;
    };

function evidenceOf(attempts: readonly ProposeAttempt[]): string {
  return attempts.map((a) => [
    `--- ${a.label} problems ---`,
    ...a.problems.map((p) => `  - ${p}`),
    `--- ${a.label} reply, verbatim ---`,
    a.text === '' ? '(empty reply)' : a.text,
  ].join('\n')).join('\n\n');
}

/**
 * Ask for a proposal. Allow exactly one repair turn.
 * A model error is caught and reported the same way a bad reply is, because a
 * provider failure must not delete the record of the attempt.
 */
export async function propose(input: ProposeInput): Promise<ProposeOutcome> {
  const maxTokens = input.maxTokens ?? DEFAULT_MAX_TOKENS;
  const temperature = input.temperature ?? 0;
  const attempts: ProposeAttempt[] = [];

  const first: ChatMessage = { role: 'user', content: input.prompt.user };

  let firstText: string;
  try {
    const reply = await input.model.complete({
      label: PROPOSAL_LABEL,
      system: input.prompt.system,
      messages: [first],
      maxTokens,
      temperature,
    });
    firstText = reply.text;
  } catch (err) {
    const problems = [`the model call failed: ${(err as Error).message}`];
    attempts.push({ label: PROPOSAL_LABEL, text: '', problems });
    return { ok: false, attempts, repaired: false, evidence: evidenceOf(attempts) };
  }

  const firstParse = parseProposalText(firstText);
  if (firstParse.ok) {
    attempts.push({ label: PROPOSAL_LABEL, text: firstText, problems: [] });
    return { ok: true, proposal: firstParse.proposal, attempts, repaired: false };
  }
  attempts.push({ label: PROPOSAL_LABEL, text: firstText, problems: firstParse.problems });

  // The one repair turn. SPEC.md §13.1 step 5.
  let repairText: string;
  try {
    const reply = await input.model.complete({
      label: REPAIR_LABEL,
      system: input.prompt.system,
      messages: [
        first,
        { role: 'assistant', content: firstText },
        { role: 'user', content: buildRepairPrompt(firstText, firstParse.problems) },
      ],
      maxTokens,
      temperature,
    });
    repairText = reply.text;
  } catch (err) {
    attempts.push({
      label: REPAIR_LABEL, text: '',
      problems: [`the repair call failed: ${(err as Error).message}`],
    });
    return { ok: false, attempts, repaired: true, evidence: evidenceOf(attempts) };
  }

  const repairParse = parseProposalText(repairText);
  if (repairParse.ok) {
    attempts.push({ label: REPAIR_LABEL, text: repairText, problems: [] });
    return { ok: true, proposal: repairParse.proposal, attempts, repaired: true };
  }
  attempts.push({ label: REPAIR_LABEL, text: repairText, problems: repairParse.problems });
  return { ok: false, attempts, repaired: true, evidence: evidenceOf(attempts) };
}
