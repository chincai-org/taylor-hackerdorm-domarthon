/**
 * The Hedera Consensus Service publisher. SPEC.md sections 8.2, 8.7 and 8.9.
 *
 * The topic is created with NO admin key and NO submit key. Anyone may post, so
 * verification is permissionless. Nobody can delete or edit the topic, including
 * the person who created it. That makes design rule 3 a property of the network,
 * not a policy.
 *
 * `publish` returns only a receipt. EVERY read goes through the mirror node,
 * including the author's own, so the local view and a stranger's view can never
 * drift apart. The cost is a delay of a few seconds before a new message appears
 * in the rebuilt tree.
 *
 * The chain holds commitments. The store holds evidence. One HCS chunk is 1024
 * bytes and Petri never splits a consensus message, so `publish` refuses
 * anything larger.
 */

import {
  AccountId, Client, PrivateKey, TopicCreateTransaction, TopicId,
  TopicMessageSubmitTransaction,
} from '@hashgraph/sdk';
import { canonicalBytes } from '../core/canonical.js';
import { seal } from '../trust/envelope.js';
import type { Identity } from '../trust/identity.js';
import type { ConsensusLog, LogEntry, PublishReceipt } from './log.js';
import { PetriMessage } from './messages.js';
import { newMirrorStats, readTopic, type MirrorStats } from './mirror.js';

export const HCS_CHUNK_BYTES = 1024;
export type HederaNetwork = 'testnet' | 'mainnet' | 'previewnet';
export const MIRROR_REST: Record<HederaNetwork, string> = {
  mainnet: 'https://mainnet.mirrornode.hedera.com',
  previewnet: 'https://previewnet.mirrornode.hedera.com',
  testnet: 'https://testnet.mirrornode.hedera.com',
};

/** A topic memo must stay under 100 bytes. */
export const TOPIC_MEMO_MAX_BYTES = 100;
export const topicMemo = (treeId: string): string => `petri/v1 tree=${treeId}`;

/** Thrown for any Hedera-side failure. Exit code 6, NETWORK. */
export class HederaError extends Error {
  constructor(message: string, readonly exitCode: number = 6) {
    super(message);
    this.name = 'HederaError';
  }
}

const MISSING_KEY =
  'petri: HEDERA_OPERATOR_KEY is not set, so Petri cannot write to a topic.\n' +
  '  Reads still work: `petri tree`, `petri status` and `petri export` go through\n' +
  '  the public mirror node and need no key.\n' +
  '  Set HEDERA_OPERATOR_ID and HEDERA_OPERATOR_KEY, or run with `ledger: local`.';

/**
 * Read HEDERA_OPERATOR_KEY. It tries DER, then ED25519, then ECDSA parsing.
 * The key is never written to config.json. Throws when the variable is absent.
 */
export function operatorKeyFromEnv(env: NodeJS.ProcessEnv = process.env): PrivateKey {
  const key = tryOperatorKeyFromEnv(env);
  if (key === null) throw new HederaError(MISSING_KEY, 5);
  return key;
}

/** The same, but null instead of a throw, so a read-only client can be built. */
export function tryOperatorKeyFromEnv(env: NodeJS.ProcessEnv = process.env): PrivateKey | null {
  const raw = (env['HEDERA_OPERATOR_KEY'] ?? '').trim();
  if (raw === '') return null;
  const parsers: Array<(s: string) => PrivateKey> = [
    (s) => PrivateKey.fromStringDer(s),
    (s) => PrivateKey.fromStringED25519(s),
    (s) => PrivateKey.fromStringECDSA(s),
  ];
  for (const parse of parsers) {
    try {
      return parse(raw);
    } catch {
      // Try the next encoding.
    }
  }
  throw new HederaError(
    'petri: HEDERA_OPERATOR_KEY is not a DER, ED25519 or ECDSA private key.', 1,
  );
}

/**
 * Build a client for one network. The operator is set only when both
 * HEDERA_OPERATOR_KEY and an account id are available, so a keyless machine can
 * still build a client and read.
 */
export function makeClient(
  network: HederaNetwork,
  operatorId?: string,
  env: NodeJS.ProcessEnv = process.env,
): Client {
  const client =
    network === 'mainnet' ? Client.forMainnet()
      : network === 'previewnet' ? Client.forPreviewnet()
        : Client.forTestnet();
  const key = tryOperatorKeyFromEnv(env);
  const id = (operatorId ?? env['HEDERA_OPERATOR_ID'] ?? '').trim();
  if (key !== null && id !== '') client.setOperator(AccountId.fromString(id), key);
  return client;
}

export interface CreatedTopic {
  topicId: string;
  network: HederaNetwork;
  memo: string;
  txId: string;
}

/**
 * Create the topic with NO admin key and NO submit key.
 *
 * Nobody can delete or edit it afterwards, including us. That is the point: it
 * turns "nothing is ever deleted" from a promise into a property of the network.
 */
export async function createTopic(opts: {
  network: HederaNetwork;
  treeId: string;
  client?: Client;
}): Promise<CreatedTopic> {
  const memo = topicMemo(opts.treeId);
  if (Buffer.byteLength(memo, 'utf8') >= TOPIC_MEMO_MAX_BYTES) {
    throw new HederaError(
      `petri: the topic memo "${memo}" is ${Buffer.byteLength(memo, 'utf8')} bytes. ` +
      `The limit is ${TOPIC_MEMO_MAX_BYTES}. Use a shorter tree id.`, 1,
    );
  }
  const client = opts.client ?? makeClient(opts.network);
  if (client.operatorAccountId === null) {
    throw new HederaError(
      'petri: `petri topic create` needs HEDERA_OPERATOR_ID and HEDERA_OPERATOR_KEY.', 5,
    );
  }
  // No setAdminKey. No setSubmitKey. Both absences are deliberate.
  const response = await new TopicCreateTransaction().setTopicMemo(memo).execute(client);
  const receipt = await response.getReceipt(client);
  if (receipt.topicId === null) {
    throw new HederaError('petri: Hedera accepted the transaction but returned no topic id.');
  }
  return {
    topicId: receipt.topicId.toString(),
    network: opts.network,
    memo,
    txId: response.transactionId.toString(),
  };
}

export class HederaLog implements ConsensusLog {
  readonly kind = 'hcs' as const;
  readonly topic: string;

  private readonly network: HederaNetwork;
  private readonly client: Client;
  private readonly identity: Identity;
  private readonly mirrorRest: readonly string[];
  private readonly liveStats: MirrorStats = newMirrorStats();

  constructor(
    topicId: string,
    network: HederaNetwork,
    client: Client,
    identity: Identity,
    mirrorRest?: readonly string[],
  ) {
    this.topic = topicId;
    this.network = network;
    this.client = client;
    this.identity = identity;
    // SPEC.md section 18.9: Petri v1 queries the FIRST host only.
    this.mirrorRest = mirrorRest !== undefined && mirrorRest.length > 0
      ? mirrorRest
      : [MIRROR_REST[network]];
  }

  /** Counters from the last read. Malformed and unsigned messages land here. */
  get stats(): MirrorStats {
    return this.liveStats;
  }

  async publish(body: PetriMessage): Promise<PublishReceipt> {
    const parsed = PetriMessage.safeParse(body);
    if (!parsed.success) {
      throw new HederaError(
        `petri: refusing to publish a malformed message: ${parsed.error.message}`, 1,
      );
    }
    const envelope = seal('msg', parsed.data, this.identity);
    const bytes = canonicalBytes(envelope);
    if (bytes.length > HCS_CHUNK_BYTES) {
      throw new HederaError(
        `petri: this ${parsed.data.type} envelope is ${bytes.length} bytes. One HCS chunk ` +
        `holds ${HCS_CHUNK_BYTES}. Petri never splits a consensus message.`, 1,
      );
    }
    if (this.client.operatorAccountId === null) throw new HederaError(MISSING_KEY, 5);

    let response;
    let receipt;
    try {
      response = await new TopicMessageSubmitTransaction()
        .setTopicId(TopicId.fromString(this.topic))
        .setMaxChunks(1)
        .setChunkSize(HCS_CHUNK_BYTES)
        .setMessage(bytes)
        .execute(this.client);
      receipt = await response.getReceipt(this.client);
    } catch (err) {
      throw new HederaError(
        `petri: the ${parsed.data.type} message did not reach topic ${this.topic}: ` +
        `${(err as Error).message}`,
      );
    }
    return {
      seq: receipt.topicSequenceNumber === null ? 0 : receipt.topicSequenceNumber.toNumber(),
      source: 'hcs' as const,
      topic: this.topic,
      txId: response.transactionId.toString(),
      unverified: false,
      warning: '',
    };
  }

  /**
   * Every read goes through the mirror node, including our own messages. The
   * local view and a stranger's view therefore can never drift apart.
   */
  read(afterSeq = 0): AsyncIterable<LogEntry> {
    return readTopic({
      mirrorRest: this.mirrorRest[0]!,
      topicId: this.topic,
      afterSeq,
      stats: this.liveStats,
    });
  }

  trustLabel(): string {
    return `hedera topic ${this.topic} (${this.network})  —  PUBLIC`;
  }

  async close(): Promise<void> {
    this.client.close();
  }
}
