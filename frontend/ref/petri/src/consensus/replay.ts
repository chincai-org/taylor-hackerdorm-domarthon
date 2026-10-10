/**
 * The reducer that rebuilds a whole tree from the log alone. SPEC.md section 9.8.
 *
 * It is pure and deterministic. The same entries in the same order always give
 * the same result. It never throws on unexpected content.
 *
 * This reducer needs no key, no account and no local state. Feed it
 * `readTopic(...)` from src/consensus/mirror.ts and a stranger on a fresh
 * machine rebuilds every node and every status. That is the proof that nobody
 * owns the tree. `petri tree`, `petri status` and `petri export` all run it.
 */

import type { Policy } from '../config.js';
import type { Mode } from '../core/schema.js';
import { evaluate, type CountedVerification, type NodeFacts, type Verdict } from '../policy/acceptance.js';
import type { LogEntry } from './log.js';

export interface ReplayNode extends NodeFacts {
  claims: { pub: string; seq: number; status: string }[]; // StatusChanged. Advisory.
  disputed: boolean;
  hypothesis: string;
  submittedNanos: string;
  submittedSeq: number;
  verdict: Verdict;
}

export interface ReplayResult {
  lastSeq: number;
  nodes: Map<string, ReplayNode>;
  skipped: { reason: string; seq: number }[];
  treeId: string;
}

/**
 * A node's mode is not on the wire. `NodeSubmitted` carries no `mode` field,
 * because every byte of that message is spent on the hypothesis. The first
 * `VerificationSigned` for a node therefore sets it.
 *
 * This default is never observable: a node with no verification is always
 * `pending` with INSUFFICIENT_VERIFICATIONS, whatever its mode.
 */
const DEFAULT_MODE: Mode = 'replay';

export async function replay(
  entries: AsyncIterable<LogEntry>, treeId: string, policy: Policy,
): Promise<ReplayResult> {
  const nodes = new Map<string, ReplayNode>();
  const skipped: { reason: string; seq: number }[] = [];
  /** Set once, by the first VerificationSigned that reaches a known node. */
  const modeFixed = new Set<string>();
  let lastSeq = 0;

  for await (const entry of entries) {
    lastSeq = entry.seq;
    const pub = entry.envelope.pub;   // The signer. NEVER read from the body.
    const body = entry.envelope.body;

    // Rule 1. Another tree's message is not ours to read.
    if (body.tree !== treeId) {
      skipped.push({ seq: entry.seq, reason: `tree ${body.tree} is not ${treeId}` });
      continue;
    }

    if (body.type === 'NodeSubmitted') {
      // Rule 2. The FIRST NodeSubmitted for a node id wins.
      if (nodes.has(body.node)) {
        skipped.push({
          seq: entry.seq,
          reason: `duplicate NodeSubmitted for ${body.node}; the first one keeps authorship`,
        });
        continue;
      }
      nodes.set(body.node, {
        nodeId: body.node,
        author: pub,
        bench: body.bench,
        mode: DEFAULT_MODE,
        parent: body.parent,
        verifications: new Map<string, CountedVerification>(),
        withdrawn: false,
        superseded: false,
        claims: [],
        disputed: false,
        hypothesis: body.hyp,
        submittedNanos: entry.consensusNanos,
        submittedSeq: entry.seq,
        verdict: PENDING_PLACEHOLDER,
      });
      continue;
    }

    if (body.type === 'VerificationSigned') {
      const node = nodes.get(body.node);
      // Rule 3. A verification for a node we have not seen is not evidence yet.
      if (node === undefined) {
        skipped.push({ seq: entry.seq, reason: `VerificationSigned for unknown node ${body.node}` });
        continue;
      }
      // Rule 4. The FIRST VerificationSigned from one key wins. One key is one vote.
      if (node.verifications.has(pub)) {
        skipped.push({
          seq: entry.seq,
          reason: `${pub.slice(0, 8)} already verified ${body.node}; one key is one vote`,
        });
        continue;
      }
      if (!modeFixed.has(body.node)) {
        node.mode = body.mode;
        modeFixed.add(body.node);
      }
      node.verifications.set(pub, { pub, msg: body, seq: entry.seq });
      continue;
    }

    // Rule 5. StatusChanged is advisory. It never sets a status.
    const node = nodes.get(body.node);
    if (node === undefined) {
      skipped.push({ seq: entry.seq, reason: `StatusChanged for unknown node ${body.node}` });
      continue;
    }
    node.claims.push({ pub, seq: entry.seq, status: body.status });
    // Two statuses are exceptions, because nobody can derive them. They are
    // statements by the author, so only the author's key may make them.
    if (pub === node.author) {
      if (body.status === 'withdrawn') node.withdrawn = true;
      if (body.status === 'superseded') node.superseded = true;
    }
  }

  // Rule 6. Recompute every status from the evidence. Nothing is ever cached.
  for (const node of nodes.values()) {
    node.verdict = evaluate(node, policy);
    node.disputed = node.claims.some(
      (c) => c.status !== 'withdrawn' && c.status !== 'superseded' && c.status !== node.verdict.status,
    );
  }

  return { lastSeq, nodes, skipped, treeId };
}

/** Replaced by `evaluate` before the result leaves this module. */
const PENDING_PLACEHOLDER: Verdict = {
  status: 'pending',
  code: 'INSUFFICIENT_VERIFICATIONS',
  reason: 'not evaluated yet',
  deltaBp: null,
  counted: [],
  ignored: [],
};
