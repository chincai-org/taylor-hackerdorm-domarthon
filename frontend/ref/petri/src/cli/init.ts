/**
 * `petri init` and `petri config`.
 *
 * §4.3, the offline default: no ANTHROPIC_API_KEY gives `mode: replay`, and no
 * Hedera operator gives `ledger: local`. Both defaults are correct with zero
 * setup, so design rule 6 holds on a fresh clone.
 */
import { existsSync } from 'node:fs';
import { hostname } from 'node:os';
import { isAbsolute, resolve } from 'node:path';

import type { Command } from 'commander';

import { loadConfig, PetriConfigSchema, saveConfig, type PetriConfig } from '../config.js';
import { benchIdOf } from '../core/ids.js';
import type { BenchSpec, Mode } from '../core/schema.js';
import { MIRROR_REST, type HederaNetwork } from '../consensus/hedera.js';
import { createIdentity } from '../trust/identity.js';
import { configPath, identityPath, petriDir } from '../store/paths.js';
import { PetriStore } from '../store/store.js';
import { buildBenchSpec, tasksDirOf } from '../../bench/src/benchSpec.js';
import { EXIT, fail } from './exit.js';
import { asCanon, emitJson, globalOptions, openCtx, out, type Ctx } from './context.js';
import { printBanner, trustLabel } from './banner.js';
import { writeGenesis, GENESIS_HYPOTHESIS } from './genesis.js';

interface InitOptions {
  tree?: string;
  bench?: string;
  mode?: string;
  ledger?: string;
  label?: string;
  force?: boolean;
  genesis?: boolean;
  hypothesis?: string;
}

const NETWORKS: ReadonlySet<string> = new Set(['testnet', 'mainnet', 'previewnet']);

function defaultMode(): Mode {
  return typeof process.env['ANTHROPIC_API_KEY'] === 'string' &&
    process.env['ANTHROPIC_API_KEY'].length > 0
    ? 'live'
    : 'replay';
}

type HederaBlock = NonNullable<PetriConfig['hedera']>;

function hederaBlock(): HederaBlock | null {
  const key = process.env['HEDERA_OPERATOR_KEY'];
  const operatorId = process.env['HEDERA_OPERATOR_ID'];
  const topicId = process.env['HEDERA_TOPIC_ID'];
  const network = process.env['HEDERA_NETWORK'] ?? 'testnet';
  if (
    typeof key !== 'string' ||
    key.length === 0 ||
    typeof operatorId !== 'string' ||
    typeof topicId !== 'string'
  ) {
    return null;
  }
  if (!NETWORKS.has(network)) return null;
  return {
    mirrorRest: [MIRROR_REST[network as HederaNetwork]],
    network: network as HederaNetwork,
    operatorId,
    topicId,
  };
}

export function registerInit(program: Command): void {
  program
    .command('init')
    .description('create .petri, the identity, the config and the genesis node')
    .option('--tree <id>', 'tree id', 'petri-main')
    .option('--bench <dir>', 'benchmark directory', 'bench')
    .option('--mode <mode>', 'live or replay. Default: replay with no ANTHROPIC_API_KEY')
    .option('--ledger <ledger>', 'hcs or local. Default: local with no Hedera operator')
    .option('--label <name>', 'a human name for this machine')
    .option('--force', 'overwrite an existing config', false)
    .option('--no-genesis', 'do not create the genesis node from harness/')
    .option('--hypothesis <text>', 'the genesis hypothesis', GENESIS_HYPOTHESIS)
    .action(async (opts: InitOptions, cmd: Command) => {
      const g = globalOptions(cmd);
      const root = g.root;

      if (existsSync(configPath(root)) && opts.force !== true) {
        fail(
          EXIT.USAGE,
          `${configPath(root)} already exists. Pass --force to overwrite it.\n` +
            '       --force never touches identity.json. A key is never overwritten.',
        );
      }

      const mode: Mode =
        opts.mode === undefined
          ? defaultMode()
          : opts.mode === 'live' || opts.mode === 'replay'
            ? opts.mode
            : fail(EXIT.USAGE, `--mode must be live or replay, got ${opts.mode}`);

      const hedera = hederaBlock();
      let ledger: 'hcs' | 'local';
      if (opts.ledger === undefined) {
        ledger = hedera === null ? 'local' : 'hcs';
      } else if (opts.ledger === 'local') {
        ledger = 'local';
      } else if (opts.ledger === 'hcs') {
        if (hedera === null) {
          fail(
            EXIT.ENVIRONMENT,
            '--ledger hcs needs HEDERA_OPERATOR_KEY, HEDERA_OPERATOR_ID and HEDERA_TOPIC_ID.\n' +
              '       Run `petri topic create` first, or drop the flag to use the local log.',
          );
        }
        ledger = 'hcs';
      } else {
        fail(EXIT.USAGE, `--ledger must be hcs or local, got ${opts.ledger}`);
      }

      const benchArg = opts.bench ?? 'bench';
      const benchDir = isAbsolute(benchArg) ? benchArg : resolve(root, benchArg);
      if (!existsSync(benchDir)) {
        fail(EXIT.NOT_FOUND, `no benchmark directory at ${benchDir}`);
      }

      const store = new PetriStore(root);
      store.init();

      // Never overwrite a key. `createIdentity` opens the file with 'wx'.
      let identityCreated = false;
      if (!existsSync(identityPath(root))) {
        createIdentity(identityPath(root), opts.label ?? hostname());
        identityCreated = true;
      }

      let spec: BenchSpec;
      try {
        spec = buildBenchSpec(tasksDirOf(benchDir));
      } catch (err) {
        fail(EXIT.ENVIRONMENT, `the benchmark did not load: ${(err as Error).message}`);
      }
      const benchId = benchIdOf(spec);
      store.objects.put(asCanon(spec));

      const config: PetriConfig = {
        bench: { id: benchId, name: spec.id },
        ...(ledger === 'hcs' && hedera !== null ? { hedera } : {}),
        ledger,
        mode,
        policy: {
          maxRunSpreadBp: 3000,
          maxRunnerDisagreementBp: 1000,
          minDeltaBp: 1000,
          minRuns: 5,
          minVerifications: 2,
          trustedRunners: [],
        },
        runsPerVerification: 5,
        treeId: opts.tree ?? 'petri-main',
        version: 1,
      };
      const parsed = PetriConfigSchema.safeParse(config);
      if (!parsed.success) fail(EXIT.USAGE, `the config is invalid: ${parsed.error.message}`);
      saveConfig(parsed.data, configPath(root));

      printBanner(parsed.data, root);

      const ctx = openCtx(cmd, { banner: false });
      let genesis: Awaited<ReturnType<typeof writeGenesis>> | null = null;
      const harnessDir = resolve(root, 'harness');
      if (opts.genesis !== false) {
        if (!existsSync(harnessDir)) {
          process.stderr.write(
            `petri: no harness at ${harnessDir}. The genesis node was not created.\n`,
          );
        } else if (ctx.store.listNodeIds().length > 0) {
          process.stderr.write('petri: this tree already has nodes. No genesis node was created.\n');
        } else {
          genesis = await writeGenesis(ctx, {
            harnessDir,
            hypothesis: opts.hypothesis ?? GENESIS_HYPOTHESIS,
          });
        }
      }
      await ctx.closeLog();

      if (g.json) {
        emitJson(ctx, {
          root,
          petriDir: petriDir(root),
          config: parsed.data,
          identityCreated,
          runnerId: ctx.identity().runnerId,
          genesis,
        });
        return;
      }

      out(`petri initialised at ${petriDir(root)}`);
      out(`  tree      ${parsed.data.treeId}`);
      out(`  bench     ${parsed.data.bench.name}  ${benchId.slice(0, 12)}  ${spec.total} tasks`);
      out(`  mode      ${parsed.data.mode}`);
      out(`  ledger    ${parsed.data.ledger}  (trust ${trustLabel(parsed.data)})`);
      out(
        `  identity  ${ctx.identity().runnerId.slice(0, 12)}  ` +
          `${identityCreated ? 'created' : 'reused'}  ${identityPath(root)}`,
      );
      if (genesis !== null) {
        out(
          `  genesis   ${genesis.nodeId.slice(0, 12)}  harness ${genesis.harnessId.slice(0, 12)}` +
            `  ${genesis.files} files  ${genesis.published ? `published seq ${genesis.seq}` : 'NOT published'}`,
        );
        out('');
        out('The genesis node is not measured. An author\'s own runs never count (§6.4).');
        out('Two independent `petri verify` runs give it a real score.');
      }
      out('');
      // Name only commands this binary registers. `petri --help` is the list.
      out('Next:  petri digest        read the tree before you change anything');
      out('       petri propose       open a scratch workspace and edit the harness');
      out('       petri submit        measure the edit, write the node and publish it');
      out('       petri verify <id>   re-run somebody else\'s node and sign the result');
    });
}

interface ConfigSetOptions {
  root?: string;
}

/** Coerce a command-line string to the JSON type the config schema expects. */
function coerce(raw: string): unknown {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (/^-?\d+$/.test(raw)) return Number(raw);
  if (raw.startsWith('[') || raw.startsWith('{')) {
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return raw;
    }
  }
  return raw;
}

function setDotted(target: Record<string, unknown>, key: string, value: unknown): void {
  const parts = key.split('.');
  let cur: Record<string, unknown> = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]!;
    const next = cur[part];
    if (next === undefined || next === null || typeof next !== 'object' || Array.isArray(next)) {
      fail(EXIT.USAGE, `${parts.slice(0, i + 1).join('.')} is not a config section`);
    }
    cur = next as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]!] = value;
}

export function registerConfig(program: Command): void {
  const group = program.command('config').description('read and write .petri/config.json');

  group
    .command('show')
    .description('print config.json')
    .action((_opts: ConfigSetOptions, cmd: Command) => {
      const ctx: Ctx = openCtx(cmd);
      out(JSON.stringify(ctx.config, null, 2));
    });

  group
    .command('set')
    .argument('<key>', 'a dotted key, for example policy.minRuns')
    .argument('<value>', 'the new value')
    .description('set one key and re-validate the whole file')
    .action((key: string, value: string, _opts: ConfigSetOptions, cmd: Command) => {
      const g = globalOptions(cmd);
      const current = loadConfig(configPath(g.root)) as unknown as Record<string, unknown>;
      const next = JSON.parse(JSON.stringify(current)) as Record<string, unknown>;
      setDotted(next, key, coerce(value));

      const parsed = PetriConfigSchema.safeParse(next);
      if (!parsed.success) {
        fail(EXIT.USAGE, `${key} would make the config invalid: ${parsed.error.message}`);
      }
      if (parsed.data.runsPerVerification % 2 === 0) {
        fail(EXIT.USAGE, 'runsPerVerification must be odd. An even count has no unique median.');
      }
      saveConfig(parsed.data, configPath(g.root));
      printBanner(parsed.data, g.root);
      out(`${key} = ${JSON.stringify(coerce(value))}`);
    });
}
