/**
 * The World ID check. It runs after `petri verify` signs a report.
 *
 * The check is OFF by default. Set PETRI_WORLD_ID=1 to turn it on.
 *
 * Why it exists: two distinct keys are not two distinct people. One person can
 * create many keys. World AgentKit keeps an AgentBook on World Chain that maps an
 * agent wallet to an anonymous human id, after the human proves they are unique
 * with World ID. A verifier who names their registered wallet in
 * PETRI_WORLD_ADDRESS lets this check look up that human id.
 *
 * What the check records: the wallet, the human id or the reason there is none,
 * and the report it belongs to. The record goes to world-checks.jsonl and then to
 * the Hedera topic.
 *
 * What it does NOT do yet:
 *   - It does not prove the wallet belongs to the key that signed the report.
 *     A signed link between the two keys is the next step.
 *   - It does not change the acceptance rule. A report without a human id still
 *     counts. SPEC.md fixes that rule, and this check does not change it.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { canonicalJson } from '../core/canonical.js';
import { worldChecksPath } from '../store/paths.js';

export const WORLD_CHECK_ENV = 'PETRI_WORLD_ID';
export const WORLD_ADDRESS_ENV = 'PETRI_WORLD_ADDRESS';
/** The public World Chain RPC the repo's AgentKit code already uses. */
export const WORLD_CHAIN_RPC = 'https://worldchain-mainnet.g.alchemy.com/public';

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export type WorldCheckRecord = {
  address: string;
  checkedAt: number;
  humanId: string;
  kind: 'petri/world-check/1';
  node: string;
  reason: string;
  report: string;
  result: 'human' | 'not-registered' | 'error';
  runner: string;
  tree: string;
};

/** Returns the anonymous human id for a wallet, or null when it is not registered. */
export type HumanLookup = (address: string) => Promise<string | null>;

export type WorldCheckOutcome =
  | { status: 'disabled' }
  | { status: 'done'; record: WorldCheckRecord };

export const worldCheckEnabled = (env: NodeJS.ProcessEnv = process.env): boolean =>
  (env[WORLD_CHECK_ENV] ?? '').trim() === '1';

/**
 * Load the AgentBook verifier. The package comes from the repository root, so a
 * checkout without it still runs every other command. The import happens only
 * when the check is on.
 */
export async function agentBookLookup(): Promise<HumanLookup> {
  const spec = '@worldcoin/agentkit';
  const mod = (await import(spec)) as {
    createAgentBookVerifier: (o: { rpcUrl: string }) => { lookupHuman: HumanLookup };
  };
  const verifier = mod.createAgentBookVerifier({ rpcUrl: WORLD_CHAIN_RPC });
  return (address) => verifier.lookupHuman(address);
}

export async function runWorldCheck(input: {
  env?: NodeJS.ProcessEnv;
  tree: string;
  node: string;
  report: string;
  runner: string;
  lookup?: HumanLookup;
  now?: () => number;
}): Promise<WorldCheckOutcome> {
  const env = input.env ?? process.env;
  if (!worldCheckEnabled(env)) return { status: 'disabled' };

  const address = (env[WORLD_ADDRESS_ENV] ?? '').trim();
  const base = {
    address,
    checkedAt: (input.now ?? Date.now)(),
    kind: 'petri/world-check/1' as const,
    node: input.node,
    report: input.report,
    runner: input.runner,
    tree: input.tree,
  };

  if (!EVM_ADDRESS.test(address)) {
    return {
      status: 'done',
      record: { ...base, humanId: '', reason: `${WORLD_ADDRESS_ENV} is not a 0x wallet address`, result: 'error' },
    };
  }
  try {
    const lookup = input.lookup ?? (await agentBookLookup());
    const humanId = await lookup(address);
    return humanId === null || humanId === ''
      ? { status: 'done', record: { ...base, humanId: '', reason: 'the wallet is not in AgentBook', result: 'not-registered' } }
      : { status: 'done', record: { ...base, humanId, reason: '', result: 'human' } };
  } catch (err) {
    return {
      status: 'done',
      record: { ...base, humanId: '', reason: `lookup failed: ${(err as Error).message}`.slice(0, 200), result: 'error' },
    };
  }
}

export function appendWorldCheck(root: string, record: WorldCheckRecord): void {
  const path = worldChecksPath(root);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${canonicalJson(record)}\n`, 'utf8');
}

/** One line for the CLI. */
export function worldCheckLine(outcome: WorldCheckOutcome): string {
  if (outcome.status === 'disabled') return `off  (set ${WORLD_CHECK_ENV}=1 and ${WORLD_ADDRESS_ENV} to turn it on)`;
  const r = outcome.record;
  if (r.result === 'human') return `human  ${r.address}  id ${r.humanId.slice(0, 16)}`;
  return `${r.result}  ${r.reason}`;
}
