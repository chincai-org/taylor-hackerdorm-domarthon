/**
 * The one consensus-log interface. SPEC.md section 8.1.
 *
 * The Hedera topic and the local file implement the SAME interface. The rest of
 * the codebase never branches on which one is active. Replay cannot tell the two
 * apart, except through `LogEntry.source`.
 *
 * Inside one topic, `seq` IS the total order. Hedera assigns it in consensus
 * order. The local log assigns it under an exclusive file lock.
 */

import type { PetriConfig } from '../config.js';
import type { Identity } from '../trust/identity.js';
import type { SignedEnvelope } from '../trust/envelope.js';
import type { PetriMessage } from './messages.js';
import { REPO_ROOT, lockPath, logPath } from '../store/paths.js';
import { LocalLog } from './local.js';
import { HederaLog, makeClient } from './hedera.js';

/**
 * One entry in the consensus log. The shape is identical for Hedera and for the
 * local file.
 *
 * Declared as a type alias, not an interface. A local log line IS the canonical
 * JSON of this object, so it must satisfy `Canon`, and TypeScript gives an
 * implicit index signature to an object type alias only.
 */
export type LogEntry = {
  chain: string;           // hcs: the running hash, as hex. local: our own sha256 chain.
  consensusNanos: string;  // Decimal nanoseconds since the epoch. Exactly 19 digits.
  envelope: SignedEnvelope<PetriMessage>;
  payer: string;           // hcs: the payer account id. local: "local".
  seq: number;             // A per-topic sequence number. 1-based. Gap-free.
  source: 'hcs' | 'local';
  topic: string;           // hcs: "0.0.5551234". local: "local:<treeId>".
};

export interface PublishReceipt {
  seq: number;
  source: 'hcs' | 'local';
  topic: string;
  txId: string;
  /**
   * True when this message reached the local log only.
   *
   * SPEC.md section 8.10: a local log proves authorship and integrity. It proves
   * NOTHING about time, non-deletion or independence. The CLI MUST print
   * `warning` whenever this flag is true. There is no flag to hide it.
   */
  unverified: boolean;
  /** The exact warning to print when `unverified` is true. '' on a real topic. */
  warning: string;
}

export interface ConsensusLog {
  readonly kind: 'hcs' | 'local';
  readonly topic: string;
  publish(body: PetriMessage): Promise<PublishReceipt>;
  read(afterSeq?: number): AsyncIterable<LogEntry>;
  /** The honest one-line trust label. The CLI MUST print this. */
  trustLabel(): string;
  close(): Promise<void>;
}

/** Inside one topic, `seq` IS the total order. Hedera assigns it in consensus order. */
export const orderKey = (e: LogEntry): string =>
  `${e.topic}:${String(e.seq).padStart(12, '0')}`;

/**
 * Parse "1789201331.867291917" with no loss. NEVER use parseFloat here.
 * parseFloat("1757656789.123456789") gives 1757656789.1234567. Two digits are
 * gone, and two messages in the same 100 nanoseconds would then collide.
 */
export function parseConsensusTimestamp(ts: string): string {
  const m = /^(\d+)\.(\d{1,9})$/.exec(ts);
  if (!m) throw new Error(`bad consensus timestamp: ${ts}`);
  const nanos = BigInt(m[1]!) * 1_000_000_000n + BigInt(m[2]!.padEnd(9, '0'));
  return nanos.toString().padStart(19, '0'); // Width 19 keeps a lexical sort valid to 2262.
}

export function formatConsensusTimestamp(nanos: string): string {
  const n = BigInt(nanos);
  return `${n / 1_000_000_000n}.${String(n % 1_000_000_000n).padStart(9, '0')}`;
}

/**
 * Pick the backend. This is the ONLY place the choice is made.
 * `ledger: 'local'`, or an `hcs` config with no `hedera` block, gives the local log.
 */
export function openLog(
  cfg: PetriConfig,
  identity: Identity,
  root: string = REPO_ROOT,
): ConsensusLog {
  // `root` is the `--root` flag of §14.2. Without it every repository on this
  // machine would append to the one hardcoded log, and a node created under one
  // root would appear in a different root's tree.
  if (cfg.ledger === 'local' || !cfg.hedera) {
    return new LocalLog(cfg.treeId, identity, logPath(root), lockPath(root));
  }
  return new HederaLog(cfg.hedera.topicId, cfg.hedera.network,
    makeClient(cfg.hedera.network, cfg.hedera.operatorId), identity, cfg.hedera.mirrorRest);
}
