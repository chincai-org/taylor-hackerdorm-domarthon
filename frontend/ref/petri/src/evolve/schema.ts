/**
 * The proposal record, the provenance record and the mechanical result.
 *
 * SPEC.md §13.2 and §13.4 fix every field here.
 *
 * This file imports nothing from `src/core/schema.ts`, on purpose.
 * `src/core/schema.ts` imports `ProposalSchema`, `ProvenanceSchema` and
 * `MechanicalResultSchema` from here, because `NodeDetailSchema` nests all three.
 * An import back would make a module cycle, and a cycle breaks Zod at load time.
 * `Hex64` is therefore repeated here, and only here.
 */

import { z } from 'zod';
import { AREAS } from '../flatten/areas.js';

/** Local copy. See the file comment for why. It is the same regex as core/schema.ts. */
const Hex64 = z.string().regex(/^[0-9a-f]{64}$/);

/**
 * One proposed change to the harness.
 * The model returns FULL file contents, never a diff. SPEC.md §13.2.
 */
export const ProposalSchema = z.strictObject({
  hypothesis: z.string().min(30).max(600),
  falsifiedIf: z.string().min(15).max(400),
  primaryArea: z.enum(AREAS),
  motif: z.string().max(40).regex(/^[a-z0-9]+(-[a-z0-9]+){0,5}$/),
  metric: z.enum(['score', 'tokens']),
  /** Non-zero and signed. For metric 'score' the unit is basis points. */
  predictedDelta: z.int().refine((n) => n !== 0, 'predictedDelta must be non-zero'),
  reasoning: z.string().max(1200),
  whyNotUntested: z.string().max(400).nullable().default(null),
  contradicts: z.array(z.strictObject({
    nodeId: z.string(), why: z.string().max(300),
  })).max(3).default([]),
  files: z.array(z.strictObject({
    path: z.string().regex(/^harness\/[a-z0-9_-]+\.ts$/),
    contents: z.string().min(1).max(40_000),
  })).min(1).max(2),
});
export type Proposal = z.infer<typeof ProposalSchema>;

/** One proposed file, full contents. */
export type ProposalFile = Proposal['files'][number];

/** Who produced the proposal, and from which prompt. SPEC.md §13.4. */
export const ProvenanceSchema = z.strictObject({
  source: z.enum(['model', 'human', 'model-via-human']),
  model: z.string().min(1).max(64),   // 'claude-sonnet-5', 'graded', or 'none'.
  promptHash: Hex64,                  // sha256 of the exact prompt sent.
  digestHash: z.string().max(16),     // Which digest the proposer read.
  seed: z.int().min(0),
});
export type Provenance = z.infer<typeof ProvenanceSchema>;

/** 'ok', or the machine rejection that stopped the run. SPEC.md §13.4. */
export const MechanicalResultSchema = z.strictObject({
  cls: z.enum(['ok', 'malformed-proposal', 'patch-out-of-bounds', 'patch-too-large',
               'sandbox-violation', 'contract-violation', 'rule-violation', 'typecheck-failed',
               'not-scored']),
  command: z.string().max(400),   // '' when there was no command.
  exitCode: z.int(),              // 0 when cls is 'ok'.
  evidence: z.string().max(4000), // Verbatim tool output. '' when cls is 'ok'.
});
export type MechanicalResult = z.infer<typeof MechanicalResultSchema>;

/** The rejection classes a machine can decide on its own. */
export type MechanicalClass = MechanicalResult['cls'];

/** The one value of `mechanical` that lets a node reach the benchmark. */
export const MECHANICAL_OK: MechanicalResult = Object.freeze({
  cls: 'ok', command: '', exitCode: 0, evidence: '',
});

/** The evidence field is capped at 4000 bytes. Cut long tool output to fit. */
export function clipEvidence(text: string, max = 4000): string {
  const s = text.replace(/\r\n?/g, '\n');
  if (s.length <= max) return s;
  const head = s.slice(0, max - 24);
  return `${head}\n… ${s.length - head.length} more characters cut`;
}

/** Build a mechanical failure record. */
export function mechanicalFailure(
  cls: Exclude<MechanicalClass, 'ok'>,
  evidence: string,
  command = '',
  exitCode = 1,
): MechanicalResult {
  return { cls, command: command.slice(0, 400), exitCode, evidence: clipEvidence(evidence) };
}
