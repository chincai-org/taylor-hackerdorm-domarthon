#!/usr/bin/env node
/**
 * The commander entry point. SPEC.md section 14 and section 15.
 *
 * This file registers every command and maps every throw to the exit-code table
 * of section 14.1. It writes nothing itself. Each `register*` function owns its
 * own commands, and `src/cli/context.ts` owns the shared plumbing.
 */
import { Command } from 'commander';

import { EXIT, exitCodeOf, flushAndExit, messageOf } from './exit.js';
import { DEFAULT_ROOT } from './context.js';
import { registerInit, registerConfig } from './init.js';
import { registerIdentity } from './identity.js';
import { registerTopic } from './topic.js';
import { registerNode } from './node.js';
import { registerEvolve } from './evolve.js';
import { registerRun } from './run.js';
import { registerVerify, registerStatus, registerPublish } from './verify.js';
import { registerDigest, registerAreas } from './digest.js';
import { registerExport } from './log.js';
import { registerFsck } from './fsck.js';
import { autoAnchor, registerAnchor } from './anchor.js';
import { isAbsolute, resolve } from 'node:path';

const VERSION = '0.1.0';

export function buildProgram(): Command {
  const program = new Command();

  program
    .name('petri')
    .description(
      'A git for AI agent harness evolution. Every node carries a hypothesis, a\n' +
        'measured result and signatures from independent machines. Nothing is deleted.',
    )
    .version(VERSION, '-V, --version')
    .option('--root <dir>', 'the repo root that holds .petri/', DEFAULT_ROOT)
    .option('--json', 'print machine-readable JSON to stdout', false)
    .option('--quiet', 'suppress progress. It never suppresses the trust banner.', false)
    .option('--no-color', 'disable ANSI colour')
    .showHelpAfterError();

  registerInit(program);
  registerConfig(program);
  registerIdentity(program);
  registerTopic(program);
  registerNode(program);
  registerEvolve(program);
  registerRun(program);
  registerVerify(program);
  registerStatus(program);
  registerPublish(program);
  registerDigest(program);
  registerAreas(program);
  registerExport(program);
  registerFsck(program);
  registerAnchor(program);

  return program;
}

/** SIGINT and SIGTERM exit 7. Section 14.1. */
function installSignalHandlers(): void {
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      process.stderr.write(`\npetri: ${sig}. Nothing was written.\n`);
      flushAndExit(EXIT.INTERRUPTED);
    });
  }
}

export async function main(argv: readonly string[]): Promise<void> {
  installSignalHandlers();
  // petri/.env holds the Hedera account. A variable already set in the shell wins.
  try {
    process.loadEnvFile(resolve(DEFAULT_ROOT, '.env'));
  } catch {
    // No .env file. Every variable is optional.
  }
  const program = buildProgram();
  try {
    await program.parseAsync(argv as string[]);
  } catch (err) {
    // Commander throws its own signal for --help and --version. Those exit 0.
    const code = (err as { code?: unknown }).code;
    if (code === 'commander.helpDisplayed' || code === 'commander.version') {
      flushAndExit(EXIT.OK);
      return;
    }
    if (code === 'commander.help') {
      flushAndExit(EXIT.OK);
      return;
    }
    if (typeof code === 'string' && code.startsWith('commander.')) {
      process.stderr.write(`petri: ${messageOf(err)}\n`);
      flushAndExit(EXIT.USAGE);
      return;
    }
    process.stderr.write(`petri: ${messageOf(err)}\n`);
    flushAndExit(exitCodeOf(err));
    return;
  }
  // Send any new records to the Hedera topic, when one is set up.
  const rawRoot = (program.opts() as { root?: string }).root ?? DEFAULT_ROOT;
  await autoAnchor(argv, isAbsolute(rawRoot) ? rawRoot : resolve(process.cwd(), rawRoot));
  flushAndExit(process.exitCode === undefined ? EXIT.OK : Number(process.exitCode));
}

await main(process.argv);
