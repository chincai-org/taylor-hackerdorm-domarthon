/**
 * The Hedera anchor. It copies every record of the tree to a public HCS topic.
 *
 * The local log stays the source of the tree. The anchor sends each log line to
 * the topic as the exact bytes on disk, in sequence order, and it stores one
 * receipt per line. Anyone can then read the topic from the mirror node, join the
 * messages in order, and rebuild `log.jsonl`. The hash chain in each line then
 * proves that no line was changed or removed after it reached Hedera.
 *
 * World ID checks go to the same topic. See src/trust/world.ts.
 *
 * What the anchor adds: a public order and a consensus timestamp for every line,
 * on a topic with no admin key, so nobody can delete it.
 * What it does NOT add: proof that a verifier ran the benchmark, or that two keys
 * are two people. The CLI must not claim either.
 *
 * This is separate from `ledger: hcs` (src/consensus/hedera.ts). That mode reads
 * the tree FROM the topic. The anchor only writes a copy, so a tree that started
 * on the local log keeps every record and every author signature.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { TopicId, TopicMessageSubmitTransaction } from '@hashgraph/sdk';
import { z } from 'zod';

import { AccountId } from '../config.js';
import { canonicalJson, sha256Hex } from '../core/canonical.js';
import { Hex64 } from '../core/schema.js';
import { anchorConfigPath, anchorsPath, anchorTimesPath, logPath, worldChecksPath } from '../store/paths.js';
import { HederaError, makeClient, MIRROR_REST, type HederaNetwork } from './hedera.js';

/**
 * A log line is one signed envelope plus its chain fields. The largest one is
 * about 1.1 KB, so it can be larger than one 1024-byte chunk. HCS joins the
 * chunks back in order. Four chunks leave a wide margin.
 */
export const ANCHOR_MAX_CHUNKS = 4;

export const AnchorConfigSchema = z.strictObject({
  createdTx: z.string().min(1).max(128),
  network: z.enum(['testnet', 'mainnet', 'previewnet']),
  topicId: AccountId,
});
export type AnchorConfig = z.infer<typeof AnchorConfigSchema>;

export const AnchorReceiptSchema = z.strictObject({
  hcsSeq: z.int().min(0),
  lineHash: Hex64,
  localSeq: z.int().min(1),
  source: z.enum(['log', 'world']),
  topicId: AccountId,
  txId: z.string().min(1).max(128),
});
export type AnchorReceipt = z.infer<typeof AnchorReceiptSchema>;

/** One line waiting to reach the topic. */
export interface AnchorItem {
  source: 'log' | 'world';
  localSeq: number;
  line: string;
  lineHash: string;
}

/** Sends the bytes of one line to the topic. Tests replace it with a fake. */
export type AnchorSubmit = (bytes: Buffer) => Promise<{ hcsSeq: number; txId: string }>;

export const mirrorMessagesUrl = (cfg: AnchorConfig): string =>
  `${MIRROR_REST[cfg.network]}/api/v1/topics/${cfg.topicId}/messages`;
export const hashscanTopicUrl = (cfg: AnchorConfig): string =>
  `https://hashscan.io/${cfg.network}/topic/${cfg.topicId}`;

export function loadAnchorConfig(root: string): AnchorConfig | null {
  const path = anchorConfigPath(root);
  if (!existsSync(path)) return null;
  const parsed = AnchorConfigSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
  if (!parsed.success) {
    throw new HederaError(`petri: ${path} is not a valid anchor config: ${parsed.error.message}`, 1);
  }
  return parsed.data;
}

export function saveAnchorConfig(root: string, cfg: AnchorConfig): void {
  const path = anchorConfigPath(root);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(AnchorConfigSchema.parse(cfg), null, 2)}\n`, 'utf8');
}

function linesOf(path: string): string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter((l) => l.trim() !== '');
}

export function readReceipts(root: string): AnchorReceipt[] {
  return linesOf(anchorsPath(root)).map((line, i) => {
    const parsed = AnchorReceiptSchema.safeParse(JSON.parse(line));
    if (!parsed.success) {
      throw new HederaError(`petri: ${anchorsPath(root)} line ${i + 1} is not a receipt.`, 1);
    }
    return parsed.data;
  });
}

/** Every line of the log and of the World ID file, in the order they are sent. */
export function localItems(root: string): AnchorItem[] {
  const items: AnchorItem[] = [];
  const add = (source: AnchorItem['source'], path: string): void => {
    linesOf(path).forEach((line, i) => {
      items.push({ source, localSeq: i + 1, line, lineHash: sha256Hex(line) });
    });
  };
  add('log', logPath(root));
  add('world', worldChecksPath(root));
  return items;
}

const keyOf = (x: { source: string; localSeq: number }): string => `${x.source}:${x.localSeq}`;

export interface AnchorStatus {
  config: AnchorConfig | null;
  total: number;
  anchored: number;
  pending: AnchorItem[];
  /** A line that changed on disk after its receipt was written. */
  changed: AnchorItem[];
  /** Receipt per log sequence number, for the web view. */
  logReceipts: Map<number, AnchorReceipt>;
}

export function anchorStatus(root: string): AnchorStatus {
  const config = loadAnchorConfig(root);
  const receipts = new Map(readReceipts(root).map((r) => [keyOf(r), r]));
  const items = localItems(root);
  const pending: AnchorItem[] = [];
  const changed: AnchorItem[] = [];
  const logReceipts = new Map<number, AnchorReceipt>();
  for (const item of items) {
    const r = receipts.get(keyOf(item));
    if (r === undefined) pending.push(item);
    else if (r.lineHash !== item.lineHash) changed.push(item);
    else if (r.source === 'log') logReceipts.set(r.localSeq, r);
  }
  return { config, total: items.length, anchored: items.length - pending.length - changed.length, pending, changed, logReceipts };
}

export interface PushResult {
  pushed: AnchorReceipt[];
  error: string | null;
}

/**
 * Send every pending line in order, and write each receipt as soon as it
 * arrives. A failure stops the push. The receipts written before it stay, so
 * the next push starts where this one stopped.
 */
export async function pushAnchors(root: string, cfg: AnchorConfig, submit: AnchorSubmit): Promise<PushResult> {
  const status = anchorStatus(root);
  if (status.changed.length > 0) {
    const first = status.changed[0]!;
    return {
      pushed: [],
      error: `${first.source} line ${first.localSeq} changed after it reached Hedera. ` +
        'The copy on the topic is the original. Nothing more is sent.',
    };
  }
  const pushed: AnchorReceipt[] = [];
  for (const item of status.pending) {
    let sent: { hcsSeq: number; txId: string };
    try {
      sent = await submit(Buffer.from(item.line, 'utf8'));
    } catch (err) {
      return { pushed, error: `${item.source} line ${item.localSeq} did not reach ${cfg.topicId}: ${(err as Error).message}` };
    }
    const receipt: AnchorReceipt = {
      hcsSeq: sent.hcsSeq,
      lineHash: item.lineHash,
      localSeq: item.localSeq,
      source: item.source,
      topicId: cfg.topicId,
      txId: sent.txId,
    };
    mkdirSync(dirname(anchorsPath(root)), { recursive: true });
    appendFileSync(anchorsPath(root), `${canonicalJson(receipt)}\n`, 'utf8');
    pushed.push(receipt);
  }
  return { pushed, error: null };
}

/**
 * The real sender. It needs HEDERA_OPERATOR_ID and HEDERA_OPERATOR_KEY, and it
 * pays for each message from that account.
 */
export function hcsSubmitter(
  cfg: AnchorConfig, env: NodeJS.ProcessEnv = process.env,
): { submit: AnchorSubmit; close: () => void } {
  const client = makeClient(cfg.network as HederaNetwork, undefined, env);
  if (client.operatorAccountId === null) {
    client.close();
    throw new HederaError(
      'petri: HEDERA_OPERATOR_ID and HEDERA_OPERATOR_KEY must both be set to write to Hedera.', 5,
    );
  }
  const submit: AnchorSubmit = async (bytes) => {
    const response = await new TopicMessageSubmitTransaction()
      .setTopicId(TopicId.fromString(cfg.topicId))
      .setMaxChunks(ANCHOR_MAX_CHUNKS)
      .setMessage(bytes)
      .execute(client);
    const receipt = await response.getReceipt(client);
    return {
      hcsSeq: receipt.topicSequenceNumber === null ? 0 : receipt.topicSequenceNumber.toNumber(),
      txId: response.transactionId.toString(),
    };
  };
  return { submit, close: () => client.close() };
}

/* -------------------------------------------------------------------------- */
/* Check: compare the public topic with this machine                           */
/* -------------------------------------------------------------------------- */

/** One message as the public mirror node returns it, chunks joined. */
export interface TopicMessage {
  seq: number;
  bytes: Buffer;
  consensusTimestamp: string;
  runningHash: string;
}

type MirrorPage = {
  messages?: {
    sequence_number: number;
    consensus_timestamp: string;
    message: string;
    running_hash: string;
    chunk_info?: { number: number; total: number } | null;
  }[];
  links?: { next?: string | null };
};

/**
 * Read every message on the topic from the public mirror node. No key and no
 * account are needed, so anyone can run this. A message split into chunks is
 * joined back in order and reported under its last sequence number.
 */
export async function fetchTopicMessages(
  cfg: AnchorConfig,
  fetchFn: (url: string) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }> = fetch,
): Promise<TopicMessage[]> {
  const host = MIRROR_REST[cfg.network];
  let url: string | null = `${host}/api/v1/topics/${cfg.topicId}/messages?limit=100&order=asc`;
  const out: TopicMessage[] = [];
  let parts: Buffer[] = [];
  while (url !== null) {
    const res = await fetchFn(url);
    if (!res.ok) throw new HederaError(`petri: the mirror node answered HTTP ${res.status} for ${url}`);
    const page = (await res.json()) as MirrorPage;
    for (const m of page.messages ?? []) {
      parts.push(Buffer.from(m.message, 'base64'));
      const total = m.chunk_info?.total ?? 1;
      const number = m.chunk_info?.number ?? 1;
      if (number < total) continue;
      out.push({
        seq: m.sequence_number,
        bytes: Buffer.concat(parts),
        consensusTimestamp: m.consensus_timestamp,
        runningHash: Buffer.from(m.running_hash, 'base64').toString('hex'),
      });
      parts = [];
    }
    const next = page.links?.next ?? null;
    url = next === null ? null : `${host}${next}`;
  }
  return out;
}

export interface CheckResult {
  receipts: number;
  matched: number;
  /** A receipt whose message the mirror node does not hold. */
  missing: AnchorReceipt[];
  /** A message whose bytes are not the bytes the receipt recorded. */
  differ: AnchorReceipt[];
  /** A local line that changed after it reached Hedera. */
  changedLocally: AnchorItem[];
  /** Lines on this machine with no receipt yet. */
  notSent: number;
  /** Matched records, newest last, for display. */
  matches: { receipt: AnchorReceipt; message: TopicMessage }[];
}

/** Compare every receipt with the topic, and every local line with its receipt. */
export function compareWithTopic(root: string, messages: readonly TopicMessage[]): CheckResult {
  const bySeq = new Map(messages.map((m) => [m.seq, m]));
  const status = anchorStatus(root);
  const result: CheckResult = {
    receipts: 0, matched: 0, missing: [], differ: [],
    changedLocally: status.changed, notSent: status.pending.length, matches: [],
  };
  for (const receipt of readReceipts(root)) {
    result.receipts += 1;
    const message = bySeq.get(receipt.hcsSeq);
    if (message === undefined) result.missing.push(receipt);
    else if (sha256Hex(message.bytes) !== receipt.lineHash) result.differ.push(receipt);
    else { result.matched += 1; result.matches.push({ receipt, message }); }
  }
  return result;
}

/** Consensus time and running hash per topic sequence number. */
export type AnchorTimes = Record<string, { timestamp: string; runningHash: string }>;

export function loadAnchorTimes(root: string): AnchorTimes {
  try {
    return JSON.parse(readFileSync(anchorTimesPath(root), 'utf8')) as AnchorTimes;
  } catch {
    return {};
  }
}

export function saveAnchorTimes(root: string, messages: readonly TopicMessage[]): void {
  const times = loadAnchorTimes(root);
  for (const m of messages) times[String(m.seq)] = { timestamp: m.consensusTimestamp, runningHash: m.runningHash };
  const ordered: AnchorTimes = {};
  for (const k of Object.keys(times).sort((a, b) => Number(a) - Number(b))) ordered[k] = times[k]!;
  writeFileSync(anchorTimesPath(root), `${JSON.stringify(ordered, null, 2)}\n`, 'utf8');
}

/**
 * Read the topic back until the mirror node shows `wantSeq`, then save the
 * consensus times. The mirror node lags consensus by a few seconds. It gives up
 * after `waitMs`; the next `petri hedera check` fills in anything missing.
 */
export async function syncAnchorTimes(root: string, cfg: AnchorConfig, wantSeq: number, waitMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const messages = await fetchTopicMessages(cfg);
    saveAnchorTimes(root, messages);
    if (messages.some((m) => m.seq >= wantSeq)) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 2000));
  }
}
