/**
 * `petri anchor` — copy every record of the tree to a public Hedera topic.
 *
 * The local log stays the source of the tree. See src/consensus/anchor.ts.
 * After any command that writes to the log, the CLI pushes the new lines by
 * itself, when a topic is set up and the Hedera keys are in the environment.
 */
import type { Command } from 'commander';

import { createTopic, type HederaNetwork } from '../consensus/hedera.js';
import {
  anchorStatus, compareWithTopic, fetchTopicMessages, saveAnchorTimes, syncAnchorTimes, hashscanTopicUrl, hcsSubmitter, loadAnchorConfig, mirrorMessagesUrl,
  pushAnchors, saveAnchorConfig, type AnchorConfig, type AnchorReceipt,
} from '../consensus/anchor.js';
import { EXIT, fail } from './exit.js';
import { emitJson, globalOptions, openCtx, out } from './context.js';

const NETWORKS: readonly HederaNetwork[] = ['testnet', 'mainnet', 'previewnet'];

/** The commands that append to the log or to world-checks.jsonl. */
const WRITERS = new Set(['verify', 'submit', 'evolve', 'publish', 'init']);

function hasOperator(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env['HEDERA_OPERATOR_ID'] ?? '').trim() !== '' && (env['HEDERA_OPERATOR_KEY'] ?? '').trim() !== '';
}

async function push(root: string, cfg: AnchorConfig): Promise<{ pushed: AnchorReceipt[]; error: string | null }> {
  const sender = hcsSubmitter(cfg);
  try {
    return await pushAnchors(root, cfg, sender.submit);
  } finally {
    sender.close();
  }
}

/** One block per record: where it landed, and a link anyone can open. */
function printReceipts(cfg: AnchorConfig, receipts: readonly AnchorReceipt[]): void {
  for (const r of receipts) {
    out(`  ${r.source} line ${r.localSeq}  ->  topic seq ${r.hcsSeq}`);
    out(`    tx      ${r.txId}`);
    out(`    mirror  ${mirrorMessagesUrl(cfg)}/${r.hcsSeq}`);
  }
}

export function registerAnchor(program: Command): void {
  const group = program
    .command('anchor')
    .alias('hedera')
    .description('copy every log record and World ID check to a public Hedera topic');

  group
    .command('create')
    .description('create the Hedera topic, with no admin key and no submit key')
    .option('--network <net>', 'testnet, mainnet or previewnet', 'testnet')
    .action(async (opts: { network?: string }, cmd: Command) => {
      const g = globalOptions(cmd);
      const network = (opts.network ?? 'testnet') as HederaNetwork;
      if (!NETWORKS.includes(network)) fail(EXIT.USAGE, `--network must be one of ${NETWORKS.join(', ')}`);
      if (!hasOperator()) fail(EXIT.ENVIRONMENT, 'set HEDERA_OPERATOR_ID and HEDERA_OPERATOR_KEY first.');
      const existing = loadAnchorConfig(g.root);
      if (existing !== null) {
        fail(EXIT.REFUSED, `this tree already anchors to ${existing.topicId} (${existing.network}). ` +
          'One tree uses one topic, so the order of its records stays whole.');
      }
      const ctx = openCtx(cmd);
      let created: { topicId: string; txId: string };
      try {
        created = await createTopic({ network, treeId: ctx.config.treeId });
      } catch (err) {
        fail(EXIT.NETWORK, `the topic was not created: ${(err as Error).message}`);
      }
      const cfg: AnchorConfig = { createdTx: created.txId, network, topicId: created.topicId };
      saveAnchorConfig(g.root, cfg);
      if (g.json) { emitJson(ctx, { topicId: cfg.topicId, network, txId: cfg.createdTx }); return; }
      out(`topic     ${cfg.topicId}  (${network})`);
      out(`tx        ${cfg.createdTx}`);
      out(`hashscan  ${hashscanTopicUrl(cfg)}`);
      out('');
      out('Send the existing records with `petri anchor push`.');
    });

  group
    .command('push')
    .description('send every record that is not on the topic yet, in order')
    .action(async (_opts: unknown, cmd: Command) => {
      const g = globalOptions(cmd);
      const ctx = openCtx(cmd);
      const cfg = loadAnchorConfig(g.root);
      if (cfg === null) fail(EXIT.NOT_FOUND, 'no topic yet. Run `petri anchor create` first.');
      const before = anchorStatus(g.root);
      if (before.pending.length === 0 && before.changed.length === 0) {
        out(`nothing to send. All ${before.total} records are on ${cfg.topicId}.`);
        return;
      }
      if (!hasOperator()) fail(EXIT.ENVIRONMENT, 'set HEDERA_OPERATOR_ID and HEDERA_OPERATOR_KEY first.');
      const result = await push(g.root, cfg);
      if (result.pushed.length > 0) {
        await syncAnchorTimes(g.root, cfg, Math.max(...result.pushed.map((x) => x.hcsSeq))).catch(() => false);
      }
      const after = anchorStatus(g.root);
      if (g.json) { emitJson(ctx, { topicId: cfg.topicId, pushed: result.pushed, anchored: after.anchored, total: after.total, error: result.error }); }
      else {
        out(`sent      ${result.pushed.length} records to ${cfg.topicId}`);
        printReceipts(cfg, result.pushed);
        out(`anchored  ${after.anchored} of ${after.total}`);
        out(`hashscan  ${hashscanTopicUrl(cfg)}`);
      }
      if (result.error !== null) fail(EXIT.NETWORK, result.error);
    });

  group
    .command('check')
    .description('download the public topic and compare every record with this machine')
    .action(async (_opts: unknown, cmd: Command) => {
      const g = globalOptions(cmd);
      const ctx = openCtx(cmd);
      const cfg = loadAnchorConfig(g.root);
      if (cfg === null) fail(EXIT.NOT_FOUND, 'no topic yet. Run `petri anchor create` first.');
      let messages;
      try {
        messages = await fetchTopicMessages(cfg);
      } catch (err) {
        fail(EXIT.NETWORK, (err as Error).message);
      }
      saveAnchorTimes(g.root, messages);
      const r = compareWithTopic(g.root, messages);
      const bad = r.missing.length + r.differ.length + r.changedLocally.length;
      if (g.json) {
        emitJson(ctx, {
          topic: cfg.topicId, onTopic: messages.length, receipts: r.receipts, matched: r.matched,
          missing: r.missing.map((x) => x.hcsSeq), differ: r.differ.map((x) => x.hcsSeq),
          changedLocally: r.changedLocally.map((x) => `${x.source}:${x.localSeq}`), notSent: r.notSent,
        });
        if (bad > 0) process.exitCode = EXIT.INTEGRITY;
        return;
      }
      out(`topic      ${cfg.topicId}  (${cfg.network})  read from the public mirror node, no key used`);
      out(`on topic   ${messages.length} messages`);
      out(`matched    ${r.matched} of ${r.receipts} records, byte for byte (sha256 of each line)`);
      if (r.missing.length > 0) out(`MISSING    ${r.missing.length} receipts have no message on the topic: seq ${r.missing.map((x) => x.hcsSeq).join(', ')}`);
      if (r.differ.length > 0) out(`DIFFERENT  ${r.differ.length} messages are not the bytes this machine sent: seq ${r.differ.map((x) => x.hcsSeq).join(', ')}`);
      if (r.changedLocally.length > 0) out(`CHANGED    ${r.changedLocally.length} local lines were edited after they reached Hedera`);
      if (r.notSent > 0) out(`not sent   ${r.notSent} new records. Run \`petri anchor push\`.`);
      out('');
      out('latest records on Hedera');
      for (const { receipt, message } of r.matches.slice(-3)) {
        let what: string = receipt.source;
        try {
          const line = JSON.parse(message.bytes.toString('utf8')) as { envelope?: { body?: { type?: string; node?: string } }; kind?: string; node?: string };
          const body = line.envelope?.body;
          what = body?.type !== undefined ? `${body.type} ${String(body.node ?? '').slice(0, 8)}` : `${line.kind ?? receipt.source} ${String(line.node ?? '').slice(0, 8)}`;
        } catch { /* show the source only */ }
        const seconds = Number(message.consensusTimestamp.split('.')[0]);
        out(`  #${String(message.seq).padEnd(4)} ${what}`);
        out(`        time          ${new Date(seconds * 1000).toISOString()}`);
        out(`        running hash  ${message.runningHash}`);
      }
      out('');
      out(bad === 0
        ? 'OK  Every record on this machine is on Hedera, unchanged.'
        : 'FAIL  The copy on Hedera and this machine disagree. The topic is the original.');
      out(`hashscan   ${hashscanTopicUrl(cfg)}`);
      if (bad > 0) process.exitCode = EXIT.INTEGRITY;
    });

  group
    .command('status')
    .description('show the topic and how many records reached it')
    .action((_opts: unknown, cmd: Command) => {
      const g = globalOptions(cmd);
      const ctx = openCtx(cmd);
      const s = anchorStatus(g.root);
      if (g.json) {
        emitJson(ctx, {
          topic: s.config, total: s.total, anchored: s.anchored,
          pending: s.pending.length, changed: s.changed.map((c) => `${c.source}:${c.localSeq}`),
        });
        return;
      }
      if (s.config === null) {
        out(`no topic. ${s.total} records are on this machine only.`);
        out('Run `petri anchor create` with HEDERA_OPERATOR_ID and HEDERA_OPERATOR_KEY set.');
        return;
      }
      out(`topic     ${s.config.topicId}  (${s.config.network})`);
      out(`anchored  ${s.anchored} of ${s.total}`);
      out(`pending   ${s.pending.length}`);
      if (s.changed.length > 0) {
        out(`CHANGED   ${s.changed.length} records changed after they reached Hedera:`);
        for (const c of s.changed) out(`          ${c.source} line ${c.localSeq}`);
      }
      out(`mirror    ${mirrorMessagesUrl(s.config)}`);
      out(`hashscan  ${hashscanTopicUrl(s.config)}`);
    });
}

/**
 * Run after a command that wrote records. It never fails the command: the
 * records are already safe in the local log, and `petri anchor push` sends them later.
 */
export async function autoAnchor(argv: readonly string[], root: string): Promise<void> {
  if (!argv.slice(2).some((a) => WRITERS.has(a))) return;
  // PETRI_ANCHOR_AUTO=0 holds the records back until `petri anchor push`.
  if ((process.env['PETRI_ANCHOR_AUTO'] ?? '').trim() === '0') return;
  let cfg: AnchorConfig | null;
  try { cfg = loadAnchorConfig(root); } catch { return; }
  if (cfg === null) return;
  const pending = anchorStatus(root).pending.length;
  if (pending === 0) return;
  if (!hasOperator()) {
    process.stderr.write(`petri: ${pending} records are not on Hedera yet. ` +
      'Set HEDERA_OPERATOR_ID and HEDERA_OPERATOR_KEY, then run `petri anchor push`.\n');
    return;
  }
  try {
    const result = await push(root, cfg);
    process.stderr.write(`hedera     sent ${result.pushed.length} records to ${cfg.topicId}\n`);
    for (const r of result.pushed) {
      process.stderr.write(`           ${r.source} line ${r.localSeq} -> topic seq ${r.hcsSeq}  tx ${r.txId}\n`);
    }
    if (result.pushed.length > 0) {
      process.stderr.write(`hashscan   ${hashscanTopicUrl(cfg)}\n`);
      await syncAnchorTimes(root, cfg, Math.max(...result.pushed.map((x) => x.hcsSeq))).catch(() => false);
    }
    if (result.error !== null) process.stderr.write(`petri: ${result.error}\n`);
  } catch (err) {
    process.stderr.write(`petri: the records were not sent to Hedera: ${(err as Error).message}\n`);
  }
}
