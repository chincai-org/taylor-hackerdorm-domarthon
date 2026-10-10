/**
 * `petri evolve`: scene 3 of the demo.
 *
 * An agent reads the digest of the whole tree, proposes one change that avoids the
 * recorded dead ends, and the change is measured and published as a node. A proposal
 * that fails a guard or does not compile still becomes a rejected node. SPEC.md §13.1.
 *
 * The engine is runEvolve() in src/evolve/run.ts. This file only wires the flags,
 * refuses the calls that cannot work, and passes the REAL digest in. Without that
 * digest the guards would read an empty tree and never see a saturated area.
 */
import type { Command } from 'commander';
import { AREAS, type Area } from '../flatten/areas.js';
import { runEvolve } from '../evolve/run.js';
import { AnthropicClient, LIVE_MODEL_ID } from '../model/anthropic.js';
import { shortId } from './banner.js';
import {
  emitJson,
  globalOptions,
  note,
  openCtx,
  out,
  parseInt10,
  parseMode,
  parseRuns,
  resolveNodeId,
} from './context.js';
import { EXIT, fail } from './exit.js';
import { digestOf, printCandidateResult } from './node.js';
import { loadTree } from './tree.js';

type Mode = ReturnType<typeof parseMode>;

export interface EvolveGate {
  readonly mode: Mode;
  readonly hasKey: boolean;
  readonly dryRun: boolean;
  readonly allowGraded: boolean;
}

/**
 * Why this evolve call cannot run, or null.
 * A proposal is always a NEW harness. Replay has recorded answers for two harness
 * versions only, so it has nothing to replay for a proposal. Say that plainly.
 */
export function evolveBlocker(gate: EvolveGate): string | null {
  if (gate.dryRun) return null;
  if (gate.mode === 'replay' && !gate.allowGraded) {
    return (
      'replay mode cannot score a proposed change.\n' +
      '       Replay holds recorded answers for 2 harness versions only. A proposal is a new\n' +
      '       harness, so there is nothing to replay. Use one of these:\n' +
      '         petri evolve --dry-run      show what the agent reads and is asked. No key needed.\n' +
      '         petri evolve --mode live    propose and measure for real. Needs ANTHROPIC_API_KEY.'
    );
  }
  if (gate.mode === 'live' && !gate.hasKey) {
    return (
      'live mode needs ANTHROPIC_API_KEY.\n' +
      '       Set it, or run `petri evolve --dry-run` to see the prompt without a key.'
    );
  }
  return null;
}

export function registerEvolve(program: Command): void {
  program
    .command('evolve')
    .description('an agent reads the digest, proposes one change, measures it and publishes it')
    .option('--parent <id>', 'the parent node. Default: the best accepted version')
    .option('--area <area>', `steer the proposal to one area: ${AREAS.join(', ')}`)
    .option('--runs <odd>', 'runs per side')
    .option('--seed <int>', 'the proposal seed', '7')
    .option('--mode <mode>', 'live or replay')
    .option('--dry-run', 'print the digest and the exact prompt, then stop. Needs no key.')
    .option('--proposal <file>', 'a proposal JSON saved from a chat. Skips the model call.')
    .option('--max-tokens <int>', 'the reply budget for the proposal')
    .option('--allow-graded', 'let a fixture miss fall back to the graded answers')
    .action(async (opts: Record<string, string | boolean | undefined>, cmd: Command) => {
      const g = globalOptions(cmd);
      const ctx = openCtx(cmd);
      const view = await loadTree(ctx);
      const str = (k: string): string | undefined => {
        const v = opts[k];
        return typeof v === 'string' ? v : undefined;
      };

      const areaArg = str('area');
      if (areaArg !== undefined && !(AREAS as readonly string[]).includes(areaArg)) {
        fail(EXIT.USAGE, `--area must be one of: ${AREAS.join(', ')}`);
      }
      const parentArg = str('parent');
      const parentId = parentArg === undefined ? undefined : resolveNodeId(ctx.store, parentArg);
      const mode = parseMode(str('mode'), ctx.config.mode);
      const runs = parseRuns(str('runs'), ctx.config.runsPerVerification);
      const seed = parseInt10(str('seed'), 7, '--seed');
      const dryRun = opts['dryRun'] === true;
      const allowGraded = opts['allowGraded'] === true;
      const proposalFile = str('proposal');
      const maxTokensArg = str('maxTokens');
      const apiKey = process.env['ANTHROPIC_API_KEY'] ?? '';

      const blocker = evolveBlocker({ mode, hasKey: apiKey !== '', dryRun, allowGraded });
      if (blocker !== null) fail(mode === 'live' ? EXIT.ENVIRONMENT : EXIT.USAGE, blocker);

      const model =
        !dryRun && proposalFile === undefined && apiKey !== ''
          ? new AnthropicClient({ apiKey, model: LIVE_MODEL_ID })
          : undefined;

      note(
        ctx,
        dryRun
          ? 'reading the tree and building the proposal prompt …'
          : `evolving: reading the tree, proposing one change, measuring ${runs} runs …`,
      );
      const outcome = await runEvolve({
        parentId,
        runs,
        seed,
        mode,
        dryRun,
        forceArea: areaArg as Area | undefined,
        proposalFile,
        model,
        modelName: model === undefined ? undefined : LIVE_MODEL_ID,
        maxTokens: maxTokensArg === undefined ? undefined : parseInt10(maxTokensArg, 8192, '--max-tokens'),
        allowGraded,
        deps: { digest: digestOf(ctx, view) },
      });
      await ctx.closeLog();

      if (outcome.kind === 'dry-run') {
        if (g.json) {
          emitJson(ctx, {
            dryRun: true,
            promptHash: outcome.prompt.promptHash,
            system: outcome.prompt.system,
            user: outcome.prompt.user,
          });
          return;
        }
        out('================ WHAT THE AGENT READS (petri digest) ================');
        out(outcome.digestText);
        out('');
        out('================ SYSTEM PROMPT ================');
        out(outcome.prompt.system);
        out('');
        out('================ USER PROMPT ================');
        out(outcome.prompt.user);
        out('');
        out(`prompt hash ${shortId(outcome.prompt.promptHash)}. Dry run: nothing was measured or published.`);
        return;
      }

      const node = outcome.node;
      if (g.json) {
        emitJson(ctx, {
          node: node.id,
          parent: node.manifest.parent,
          status: node.status,
          statusCode: node.statusCode,
          statusReason: node.statusReason,
          mechanical: node.detail.mechanical,
          claimedMedianBp: node.detail.claimedMedianBp,
        });
        return;
      }
      printCandidateResult(node);
    });
}
