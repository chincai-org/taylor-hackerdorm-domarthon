/**
 * The exact HCS wire schemas. SPEC.md section 8.3.
 *
 * The chain holds commitments. The store holds evidence. A hash on the chain
 * lets anyone check that the bytes they fetched are the bytes the author signed.
 *
 * The hypothesis is the one exception. Design rule 4 says every node must state
 * a hypothesis in plain English, so the hypothesis goes on the chain in full.
 * One text, one place, no chance of two versions.
 *
 * `z.strictObject` rejects unknown keys. An unknown key would change the signed
 * bytes, so it must be a hard error.
 *
 * Measured worst-case envelope sizes, with a 64-character tree id, every hex
 * field full, the hypothesis at its 240-byte cap and the reason at its 200-byte
 * cap: NodeSubmitted 797, VerificationSigned 749, StatusChanged (4 verifiers)
 * 911. One HCS chunk holds 1024.
 */

import { z } from 'zod';
import { Hex64, ParentRef, TreeId, ModeSchema, byteLen } from '../core/schema.js';

export const NodeSubmitted = z.strictObject({
  bench:  Hex64,
  hyp:    z.string().min(12).refine(byteLen(240), 'hypothesis over 240 escaped bytes'),
  node:   Hex64,     // The node id. It equals contentId(manifest).
  parent: ParentRef,
  tree:   TreeId,
  type:   z.literal('NodeSubmitted'),
});

export const VerificationSigned = z.strictObject({
  candMedianBp:   z.int().min(0).max(10000),
  clean:          z.boolean(),      // No run was tampered, timed out as infra, or discarded short.
  deltaMedianBp:  z.int().min(-10000).max(10000),
  envHash:        Hex64,            // contentId(report.env)
  mode:           ModeSchema,
  node:           Hex64,
  parent:         ParentRef,
  parentMedianBp: z.int().min(0).max(10000),
  report:         Hex64,            // contentId(report)
  runs:           z.int().min(3).max(99),
  spreadBp:       z.int().min(0).max(10000),  // max minus min of candidate.runs[].scoreBp
  tree:           TreeId,
  type:           z.literal('VerificationSigned'),
});

export const StatusChanged = z.strictObject({
  node:      Hex64,
  reason:    z.string().min(1).refine(byteLen(200), 'reason over 200 escaped bytes'),
  status:    z.enum(['accepted', 'rejected', 'contested', 'withdrawn', 'superseded']),
  tree:      TreeId,
  type:      z.literal('StatusChanged'),
  verifiers: z.array(Hex64).max(4),   // The keys the publisher counted.
});

export const PetriMessage = z.discriminatedUnion('type',
  [NodeSubmitted, VerificationSigned, StatusChanged]);

export type NodeSubmitted = z.infer<typeof NodeSubmitted>;
export type VerificationSigned = z.infer<typeof VerificationSigned>;
export type StatusChanged = z.infer<typeof StatusChanged>;
export type PetriMessage = z.infer<typeof PetriMessage>;
