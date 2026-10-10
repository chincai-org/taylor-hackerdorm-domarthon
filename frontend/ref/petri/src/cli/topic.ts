/**
 * `petri topic` — the Hedera Consensus Service topic that makes the tree public.
 *
 * §8.7: the topic is created with NO admin key and NO submit key. Anyone may
 * post, so verification is permissionless, and nobody can delete or edit the
 * topic, including the person who created it. Design rule 3 then becomes a
 * property of the network rather than a policy.
 */
import type { Command } from 'commander';

import { PetriConfigSchema, saveConfig, type PetriConfig } from '../config.js';
import { createTopic, MIRROR_REST, type HederaNetwork } from '../consensus/hedera.js';
import { configPath } from '../store/paths.js';
import { EXIT, fail } from './exit.js';
import { emitJson, globalOptions, openCtx, out } from './context.js';

const NETWORKS: readonly HederaNetwork[] = ['testnet', 'mainnet', 'previewnet'];

function requireOperator(): { operatorId: string } {
  const operatorId = process.env['HEDERA_OPERATOR_ID'];
  const key = process.env['HEDERA_OPERATOR_KEY'];
  if (typeof operatorId !== 'string' || !/^\d+\.\d+\.\d+$/.test(operatorId)) {
    fail(
      EXIT.ENVIRONMENT,
      'HEDERA_OPERATOR_ID is missing or malformed. It looks like 0.0.98765.',
    );
  }
  if (typeof key !== 'string' || key.length === 0) {
    fail(
      EXIT.ENVIRONMENT,
      'HEDERA_OPERATOR_KEY is not set. It is never written to config.json.',
    );
  }
  return { operatorId };
}

export function registerTopic(program: Command): void {
  const group = program.command('topic').description('the Hedera topic that holds this tree');

  group
    .command('create')
    .description('create a topic with no admin key and no submit key')
    .option('--network <net>', 'testnet, mainnet or previewnet', 'testnet')
    .action(async (opts: { network?: string }, cmd: Command) => {
      const g = globalOptions(cmd);
      const network = (opts.network ?? 'testnet') as HederaNetwork;
      if (!NETWORKS.includes(network)) {
        fail(EXIT.USAGE, `--network must be one of ${NETWORKS.join(', ')}, got ${opts.network}`);
      }
      const { operatorId } = requireOperator();
      const ctx = openCtx(cmd);

      let created: { topicId: string; txId: string };
      try {
        created = await createTopic({ network, treeId: ctx.config.treeId });
      } catch (err) {
        fail(EXIT.NETWORK, `the topic was not created: ${(err as Error).message}`);
      }

      const next: PetriConfig = {
        ...ctx.config,
        ledger: 'hcs',
        hedera: {
          mirrorRest: [MIRROR_REST[network]],
          network,
          operatorId,
          topicId: created.topicId,
        },
      };
      const parsed = PetriConfigSchema.safeParse(next);
      if (!parsed.success) {
        fail(EXIT.INTEGRITY, `the new config is invalid: ${parsed.error.message}`);
      }
      saveConfig(parsed.data, configPath(g.root));
      await ctx.closeLog();

      if (g.json) {
        emitJson(ctx, { topicId: created.topicId, txId: created.txId, network });
        return;
      }
      out(`topic     ${created.topicId}  (${network})`);
      out(`memo      petri/v1 tree=${ctx.config.treeId}`);
      out(`tx        ${created.txId}`);
      out(`ledger    hcs  — written to config.json`);
      out('');
      out('Anyone can now read every message with no account and no key:');
      out(`  ${MIRROR_REST[network]}/api/v1/topics/${created.topicId}/messages`);
      out('A checkout pointed at this topic rebuilds the tree with `petri tree`.');
      out('');
      out('Nodes already in the local log are NOT on the topic. Re-publish each one');
      out('with `petri publish <nodeId>`.');
    });

  group
    .command('show')
    .description('print the topic id, the network and the mirror endpoints')
    .action(async (_opts: unknown, cmd: Command) => {
      const g = globalOptions(cmd);
      const ctx = openCtx(cmd);
      await ctx.closeLog();
      if (ctx.config.hedera === undefined) {
        if (g.json) {
          emitJson(ctx, { topic: null });
          return;
        }
        out('no topic. This tree uses the local log.');
        out('Run `petri topic create` to publish it to a real topic.');
        return;
      }
      const h = ctx.config.hedera;
      if (g.json) {
        emitJson(ctx, { topic: h });
        return;
      }
      out(`topic      ${h.topicId}`);
      out(`network    ${h.network}`);
      out(`operator   ${h.operatorId}`);
      out(`mirrors    ${h.mirrorRest.join(', ')}`);
      out('');
      out('Petri v1 queries the first mirror only (§18.9).');
    });
}
