/**
 * `petri digest` and `petri areas`.
 *
 * The digest is the agent-readable view of the whole tree (§12). It is
 * deterministic: the same ledger always renders the same bytes, and no model
 * takes part. An agent reads it before it proposes node N+1.
 */
import type { Command } from 'commander';

import { AREA_REGISTRY, AREAS, PATH_AREA } from '../flatten/areas.js';
import { buildDigest } from '../flatten/digest.js';
import { renderDigest } from '../flatten/render.js';
import { emitJson, globalOptions, openCtx, out, parseInt10 } from './context.js';
import { loadBench } from './measure.js';
import { loadTree } from './tree.js';

export function registerDigest(program: Command): void {
  program
    .command('digest')
    .option('--max-tokens <int>', 'the render budget', '6000')
    .description('render the agent-readable context digest of the whole tree')
    .action(async (opts: { maxTokens?: string }, cmd: Command) => {
      const g = globalOptions(cmd);
      const ctx = openCtx(cmd);
      const view = await loadTree(ctx);
      await ctx.closeLog();

      const bench = loadBench(ctx);
      const digest = buildDigest({
        nodes: [...view.nodes.values()],
        bench: ctx.config.bench.id,
        benchName: ctx.config.bench.name,
        mode: ctx.config.mode,
        ledger: ctx.config.ledger,
        taskCount: bench.total,
        runs: ctx.config.runsPerVerification,
        constraints: { minDeltaBp: ctx.config.policy.minDeltaBp },
      });

      if (g.json) {
        emitJson(ctx, { digest });
        return;
      }
      out(renderDigest(digest, parseInt10(opts.maxTokens, 6000, '--max-tokens')));
    });
}

export function registerAreas(program: Command): void {
  program
    .command('areas')
    .description('print the area registry and the path map the classifier uses')
    .action(async (_opts: unknown, cmd: Command) => {
      const g = globalOptions(cmd);
      const ctx = openCtx(cmd);
      await ctx.closeLog();

      if (g.json) {
        emitJson(ctx, { areas: AREAS, registry: AREA_REGISTRY, pathMap: PATH_AREA });
        return;
      }
      out('AREAS');
      for (const area of AREAS) {
        const entry = AREA_REGISTRY[area];
        out(`  ${area.padEnd(14)} ${entry.summary}`);
        if (entry.probes.length > 0) {
          out(`  ${''.padEnd(14)} probes: ${entry.probes.join(', ')}`);
        }
      }
      out('');
      out('PATH MAP  (a file here is classified by path, before any keyword)');
      for (const [path, area] of Object.entries(PATH_AREA)) {
        out(`  ${path.padEnd(24)} ${area}`);
      }
      out('');
      out('A file outside the map is classified by keyword, over its base name and');
      out('then over its changed lines. A path contributes lines + 1 weight. A keyword');
      out('hit contributes 3. An area at weight 3 or more is reported.');
      out('');
      out('The digest always uses the DERIVED area set, never the declared one, so a');
      out('label cannot dodge a saturated area.');
    });
}
