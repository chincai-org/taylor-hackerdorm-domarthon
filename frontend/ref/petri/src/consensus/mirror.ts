/**
 * The mirror-node reader. SPEC.md section 8.8.
 *
 * This module needs NO key, NO account and NO local state. It is how a stranger
 * on a fresh machine rebuilds the whole tree from a public topic. It imports no
 * Hedera SDK, only `fetch`.
 *
 * Measured facts about the live mirror API:
 *   - `message` is standard base64 with padding.
 *   - `chunk_info` is null for a single-chunk message.
 *   - `sequencenumber=gt:N` works and combines with `order=asc`.
 *   - `limit` maxes out at 100. A request for 101 silently returns 100.
 *   - `links.next` is a relative path, not an absolute URL.
 *
 * Petri drives pagination with `sequencenumber=gt:` and ignores `links.next`.
 * A sequence number is a cursor Petri can persist in cursor.json. A path is not.
 *
 * THE READER NEVER THROWS ON BAD CONTENT. The topic is permissionless, so anyone
 * can post garbage. Garbage is counted in MirrorStats and skipped. Only a network
 * or HTTP failure throws. A replay that crashes on one bad message is a
 * denial-of-service hole.
 */

import { openEnvelope } from '../trust/envelope.js';
import { type LogEntry, parseConsensusTimestamp } from './log.js';
import { PetriMessage } from './messages.js';

/** The mirror API caps a page at 100 items. Asking for more silently returns 100. */
export const MIRROR_PAGE_LIMIT = 100;

/** Thrown only for a network or HTTP failure, never for bad message content. */
export class MirrorError extends Error {
  readonly exitCode = 6;
  constructor(message: string, readonly url: string) {
    super(message);
    this.name = 'MirrorError';
  }
}

export interface MirrorChunkInfo {
  initial_transaction_id?: unknown;
  number?: number;
  total?: number;
}

/** One record as the mirror REST API returns it. */
export interface MirrorMessage {
  chunk_info?: MirrorChunkInfo | null;
  consensus_timestamp?: string;
  message?: string;
  payer_account_id?: string;
  running_hash?: string;
  sequence_number?: number;
  topic_id?: string;
}

export interface MirrorStats {
  accepted: number;
  badSignature: number;
  malformed: number;  // Not UTF-8, not JSON, or not a Petri message.
  oversized: number;  // It arrived in more than one chunk.
  pending: number;    // Chunks still waiting for their siblings.
}

export const newMirrorStats = (): MirrorStats => ({
  accepted: 0, badSignature: 0, malformed: 0, oversized: 0, pending: 0,
});

export type FetchLike = (input: string, init?: { signal?: AbortSignal }) => Promise<Response>;

export interface ReadTopicOptions {
  /** A mirror REST base URL, for example https://testnet.mirrornode.hedera.com */
  mirrorRest: string;
  /** The topic, as "0.0.5551234". */
  topicId: string;
  /** Start after this sequence number. 0 reads the whole topic. */
  afterSeq?: number;
  /** Page size. The API caps it at 100. */
  limit?: number;
  /** Counters, mutated as the stream runs. Pass one in to read it afterwards. */
  stats?: MirrorStats;
  /** Injected for tests. Defaults to the global fetch. */
  fetchImpl?: FetchLike;
  /** Network attempts per page, including the first. */
  maxAttempts?: number;
  signal?: AbortSignal;
}

interface MirrorPage { messages?: unknown }

const sleep = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });

function pageUrl(base: string, topicId: string, afterSeq: number, limit: number): string {
  const root = base.replace(/\/+$/, '');
  return `${root}/api/v1/topics/${encodeURIComponent(topicId)}/messages` +
    `?limit=${limit}&order=asc&sequencenumber=gt:${afterSeq}`;
}

/** GET one page. Retries a network error, a 429 and any 5xx. Then throws. */
async function getPage(
  url: string, doFetch: FetchLike, maxAttempts: number, signal?: AbortSignal,
): Promise<MirrorPage> {
  let lastReason = 'unknown';
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = signal === undefined
        ? await doFetch(url)
        : await doFetch(url, { signal });
      if (res.ok) {
        return await res.json() as MirrorPage;
      }
      lastReason = `HTTP ${res.status}`;
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable) {
        throw new MirrorError(`petri: the mirror node answered ${res.status} for ${url}`, url);
      }
    } catch (err) {
      if (err instanceof MirrorError) throw err;
      lastReason = (err as Error).message;
    }
    if (attempt < maxAttempts) await sleep(200 * attempt);
  }
  throw new MirrorError(
    `petri: the mirror node at ${url} failed after ${maxAttempts} attempts: ${lastReason}`,
    url,
  );
}

/** A group of chunks that belongs to one submitted message. */
interface ChunkGroup { total: number; parts: Map<number, string> }

const chunkKey = (info: MirrorChunkInfo): string => {
  const id = info.initial_transaction_id;
  if (typeof id === 'string') return id;
  if (id !== null && typeof id === 'object') {
    const o = id as Record<string, unknown>;
    return [o['account_id'], o['transaction_valid_start'], o['nonce'], o['scheduled']]
      .map((v) => String(v)).join('-');
  }
  return 'unknown';
};

/**
 * Decode one already-reassembled message body into a LogEntry, or return null
 * and bump the right counter. It never throws.
 */
function toLogEntry(m: MirrorMessage, base64: string, stats: MirrorStats): LogEntry | null {
  const seq = m.sequence_number;
  const topic = m.topic_id;
  const ts = m.consensus_timestamp;
  if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || typeof topic !== 'string'
      || typeof ts !== 'string') {
    stats.malformed++;
    return null;
  }

  let consensusNanos: string;
  try {
    consensusNanos = parseConsensusTimestamp(ts);
  } catch {
    stats.malformed++;
    return null;
  }

  const bytes = Buffer.from(base64, 'base64');
  const text = bytes.toString('utf8');
  // Buffer.toString replaces invalid UTF-8 with U+FFFD. A round trip catches it.
  if (!Buffer.from(text, 'utf8').equals(bytes)) {
    stats.malformed++;
    return null;
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    stats.malformed++;
    return null;
  }

  const opened = openEnvelope('msg', value);
  if (!opened.ok) {
    if (opened.reason === 'signature check failed') stats.badSignature++;
    else stats.malformed++;
    return null;
  }

  const parsed = PetriMessage.safeParse(opened.body);
  if (!parsed.success) {
    stats.malformed++;
    return null;
  }

  // openEnvelope already checked that `sig` is 128 hex characters.
  const sig = (value as { sig: string }).sig;
  const runningHash = typeof m.running_hash === 'string' ? m.running_hash : '';

  stats.accepted++;
  return {
    chain: Buffer.from(runningHash, 'base64').toString('hex'),
    consensusNanos,
    envelope: { body: parsed.data, pub: opened.pub, sig, ver: 1 },
    payer: typeof m.payer_account_id === 'string' ? m.payer_account_id : 'unknown',
    seq,
    source: 'hcs',
    topic,
  };
}

/**
 * Stream every Petri message on a topic, in consensus order, as `LogEntry`.
 *
 * Multi-chunk messages are reassembled by `chunk_info.initial_transaction_id`,
 * counted in `stats.oversized` and then SKIPPED. `HederaLog.publish` refuses to
 * send anything over one 1024-byte chunk, so a chunked message was never written
 * by Petri. Incomplete groups stay in `stats.pending`.
 */
export async function* readTopic(opts: ReadTopicOptions): AsyncGenerator<LogEntry> {
  const stats = opts.stats ?? newMirrorStats();
  const limit = Math.min(opts.limit ?? MIRROR_PAGE_LIMIT, MIRROR_PAGE_LIMIT);
  const maxAttempts = opts.maxAttempts ?? 4;
  const doFetch: FetchLike = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  const groups = new Map<string, ChunkGroup>();
  let cursor = opts.afterSeq ?? 0;

  for (;;) {
    const url = pageUrl(opts.mirrorRest, opts.topicId, cursor, limit);
    const page = await getPage(url, doFetch, maxAttempts, opts.signal);
    const raw = page.messages;
    if (!Array.isArray(raw) || raw.length === 0) return;

    for (const item of raw as MirrorMessage[]) {
      if (item === null || typeof item !== 'object') { stats.malformed++; continue; }
      if (typeof item.sequence_number === 'number') cursor = item.sequence_number;
      if (typeof item.message !== 'string') { stats.malformed++; continue; }

      const info = item.chunk_info;
      const total = info === null || info === undefined ? 1 : (info.total ?? 1);

      if (total <= 1) {
        const entry = toLogEntry(item, item.message, stats);
        if (entry !== null) yield entry;
        continue;
      }

      // A chunked message. Collect the parts so we can tell complete from pending.
      const key = chunkKey(info!);
      const group = groups.get(key) ?? { total, parts: new Map<number, string>() };
      group.parts.set(info!.number ?? group.parts.size + 1, item.message);
      groups.set(key, group);
      if (group.parts.size >= group.total) {
        groups.delete(key);
        stats.oversized++;   // Petri never writes one. It is not a Petri message.
      }
      stats.pending = groups.size;
    }

    if (raw.length < limit) return;
  }
}
