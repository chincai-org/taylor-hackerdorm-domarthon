/**
 * Areas — the fixed vocabulary of harness levers. SPEC.md §12.1.
 *
 * This file imports nothing from Petri. `src/core/schema.ts` uses `AreaSchema`
 * inside `NodeDetailSchema`, so any Petri import here would make a cycle.
 */

import { z } from 'zod';

export const AREAS = [
  'prompt', 'retrieval', 'recovery', 'loop', 'decoding',
  'budget', 'verification', 'decomposition', 'memory', 'other',
] as const;
export type Area = (typeof AREAS)[number];
export const AreaSchema = z.enum(AREAS);

/** The position of each area in AREAS. Every tie in the digest breaks on it. */
export const AREA_INDEX: Record<Area, number> =
  Object.fromEntries(AREAS.map((a, i) => [a, i])) as Record<Area, number>;

export function isArea(value: string): value is Area {
  return (AREAS as readonly string[]).includes(value);
}

export const AREA_REGISTRY: Record<Area, { summary: string; probes: string[] }> = {
  prompt:        { summary: 'What the harness says to the model.',
                   probes: ['system text', 'output format', 'worked examples', 'signatures'] },
  retrieval:     { summary: 'What task material enters the prompt, and in what order.',
                   probes: ['ranking', 'truncation', 'file selection'] },
  recovery:      { summary: 'What the harness does after a bad reply.',
                   probes: ['repair turns', 'error text feedback', 'fallbacks'] },
  loop:          { summary: 'The control flow of one solve call.',
                   probes: ['step count', 'stop rule', 'reply parsing'] },
  decoding:      { summary: 'Sampling controls on each model call.',
                   probes: ['temperature', 'maxTokens', 'stop sequences'] },
  budget:        { summary: 'How the harness spends calls and tokens.',
                   probes: ['per-step caps', 'reserve for repair'] },
  verification:  { summary: 'Checks the harness runs on its own answer before it returns.',
                   probes: ['invariant checks', 'self-review pass', 'shape checks'] },
  decomposition: { summary: 'Splitting one task into smaller model calls.',
                   probes: ['plan then write', 'one call per symbol', 'sub-agents'] },
  memory:        { summary: 'State carried across steps inside one solve call.',
                   probes: ['scratchpad', 'reuse of earlier drafts'] },
  other:         { summary: 'Anything the registry does not name.', probes: [] },
};

/**
 * A standing limit the digest prints instead of letting an agent spend a node
 * discovering it. SPEC.md §12.1.
 */
export const AREA_LIMITS: Partial<Record<Area, string>> = {
  memory: 'ctx is fresh per task. Cross-task memory needs a contract change. '
    + 'The contract is frozen, so it is out of scope.',
};

/** The fixed path map. A file listed here is never classified by keyword. */
export const PATH_AREA: Record<string, Area> = {
  'harness/prompt.ts': 'prompt',
  'harness/retrieval.ts': 'retrieval',
  'harness/recovery.ts': 'recovery',
  'harness/loop.ts': 'loop',
  'harness/index.ts': 'loop',
};

/**
 * Keywords for a file the path map does not name. Every entry is matched at a
 * word start, over lowercased text, so `retriev` catches `retrieval` and
 * `retrieve` but `budget` never catches `rebudget`.
 */
export const AREA_KEYWORDS: Record<Area, readonly string[]> = {
  prompt: ['prompt', 'system', 'instruction', 'persona', 'wording', 'template',
    'example', 'signature', 'outputformat', 'format'],
  retrieval: ['retriev', 'rank', 'select', 'context', 'starter', 'truncat',
    'relevan', 'excerpt', 'snippet'],
  recovery: ['recover', 'repair', 'retry', 'fallback', 'salvage', 'secondattempt',
    'errortext', 'diagnos'],
  loop: ['loop', 'iterat', 'controlflow', 'stoprule', 'fence', 'parsereply',
    'roundtrip', 'turn', 'step'],
  decoding: ['temperature', 'maxtokens', 'max_tokens', 'topp', 'top_p', 'toplogprob',
    'stopsequence', 'stop_sequence', 'sampl', 'decod', 'greedy'],
  budget: ['budget', 'tokensleft', 'callsleft', 'tokensused', 'callsused', 'quota',
    'spend', 'reserve', 'cost', 'maxcalls', 'maxwallms'],
  verification: ['verif', 'validat', 'invariant', 'selfcheck', 'selfreview',
    'sanity', 'assert', 'shapecheck', 'lint'],
  decomposition: ['decompos', 'subtask', 'subagent', 'sub_agent', 'split', 'outline',
    'planthen', 'persymbol', 'stage', 'phase'],
  memory: ['memory', 'scratchpad', 'remember', 'recall', 'carryover', 'history',
    'notepad', 'priordraft'],
  other: [],
};

const KEYWORD_RE: Record<Area, RegExp | null> = Object.fromEntries(
  AREAS.map((a) => {
    const words = AREA_KEYWORDS[a];
    return [a, words.length === 0 ? null : new RegExp(`\\b(?:${words.map(escapeRe).join('|')})`, 'i')];
  }),
) as Record<Area, RegExp | null>;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface ChangedFile { path: string; addedLines: string[]; removedLines: string[]; }

/** The weight a match must reach before the digest reports the area. §12.1. */
export const AREA_REPORT_WEIGHT = 3;

/**
 * Deterministic. Path map first, then keywords over the changed lines.
 *
 * A path contributes `lines + 1` weight to the area it names. A keyword hit on
 * one changed line contributes 3, counted once per line per area. Areas at
 * weight 3 or more are reported, heaviest first. Ties break on the area name,
 * ascending. `areas[0]` is always `primaryArea`.
 */
export function classifyAreas(changed: ChangedFile[]): { areas: Area[]; primaryArea: Area } {
  const weight = new Map<Area, number>();
  const add = (area: Area, w: number): void => { weight.set(area, (weight.get(area) ?? 0) + w); };

  for (const file of changed) {
    const path = file.path.replace(/\\/g, '/');
    const lines = file.addedLines.length + file.removedLines.length;

    const mapped = PATH_AREA[path];
    if (mapped !== undefined) { add(mapped, lines + 1); continue; }

    const base = (path.split('/').pop() ?? path).replace(/\.[a-z0-9]+$/i, '').toLowerCase();
    for (const area of AREAS) {
      const re = KEYWORD_RE[area];
      if (re !== null && re.test(base)) add(area, lines + 1);
    }
    for (const line of [...file.addedLines, ...file.removedLines]) {
      const hay = line.toLowerCase();
      for (const area of AREAS) {
        const re = KEYWORD_RE[area];
        if (re !== null && re.test(hay)) add(area, 3);
      }
    }
  }

  const scored = AREAS
    .filter((a) => (weight.get(a) ?? 0) >= AREA_REPORT_WEIGHT)
    .sort((a, b) => (weight.get(b) ?? 0) - (weight.get(a) ?? 0) || (a < b ? -1 : a > b ? 1 : 0));

  if (scored.length === 0) return { areas: ['other'], primaryArea: 'other' };
  return { areas: scored, primaryArea: scored[0] ?? 'other' };
}
