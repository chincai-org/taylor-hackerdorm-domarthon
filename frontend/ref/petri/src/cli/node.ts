/**
 * `petri snapshot`, `propose`, `submit`, `show`, `tree`, `tips`, `dead-ends`,
 * `lineage` and `diff`.
 *
 * Design rule 3 lives here: `tree` and `dead-ends` print rejected branches with
 * their reasons. Nothing is ever hidden, and nothing is ever deleted.
 */
import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';

import type { Command } from 'commander';

import { sha256Hex } from '../core/canonical.js';
import { harnessId } from '../core/ids.js';
import type { HarnessSnapshot, PetriNode } from '../core/schema.js';
import { AREAS, type Area } from '../flatten/areas.js';
import { buildDigest, type Digest } from '../flatten/digest.js';
import { unifiedDiff } from '../evolve/diff.js';
import { ProposalSchema, type Proposal, type Provenance } from '../evolve/schema.js';
import { runCandidate } from '../evolve/run.js';
import { checkReport } from '../trust/report.js';
import { writeJsonFile } from '../store/json.js';
import { scratchDir } from '../store/paths.js';
import { EXIT, fail } from './exit.js';
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
  type Ctx,
} from './context.js';
import { fmtBp, shortId, statusLine, verifiersPhrase } from './banner.js';
import { loadBench } from './measure.js';
import {
  changedFiles,
  changedLineCount,
  HARNESS_PREFIX,
  readHarness,
  writeHarness,
} from './snapshot.js';
import {
  claimedMedianOf,
  currentTip,
  deltasOf,
  depthOf,
  lineageOf,
  loadTree,
  tipsOf,
  verifiedMedianOf,
  verifierTally,
  type TreeView,
} from './tree.js';

/** §13.6. The scratch typecheck needs no node_modules beyond typescript. */
const SCRATCH_TSCONFIG = {
  compilerOptions: {
    target: 'ES2023',
    lib: ['ES2023'],
    module: 'NodeNext',
    moduleResolution: 'NodeNext',
    strict: true,
    noEmit: true,
    types: [],
    exactOptionalPropertyTypes: true,
    noUncheckedIndexedAccess: true,
    skipLibCheck: true,
  },
  include: ['harness/**/*.ts'],
};

interface WorkspaceFile {
  parent: string;
  proposal: Omit<Proposal, 'files'>;
}

function readWorkspaceFile(path: string): WorkspaceFile {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (err) {
    fail(EXIT.NOT_FOUND, `cannot read ${path}: ${(err as Error).message}`);
  }
  const value = raw as Partial<WorkspaceFile>;
  if (typeof value.parent !== 'string' || value.proposal === undefined) {
    fail(EXIT.USAGE, `${path} is not a petri workspace file`);
  }
  return value as WorkspaceFile;
}

function parseArea(value: string | undefined, fallback: Area): Area {
  if (value === undefined) return fallback;
  if (!(AREAS as readonly string[]).includes(value)) {
    fail(EXIT.USAGE, `--area must be one of ${AREAS.join(', ')}, got ${value}`);
  }
  return value as Area;
}

/** Resolve the parent a new candidate extends. */
function resolveParent(ctx: Ctx, view: TreeView, requested: string | undefined): PetriNode {
  if (requested !== undefined) {
    const id = resolveNodeId(ctx.store, requested);
    const node = view.nodes.get(id);
    if (node === undefined) fail(EXIT.NOT_FOUND, `no node ${id}`);
    return node;
  }
  const tip = currentTip(view);
  if (tip === null) {
    fail(
      EXIT.NOT_FOUND,
      'this tree has no node yet. Run `petri init` to create the genesis node.',
    );
  }
  return tip;
}

function harnessOf(ctx: Ctx, node: PetriNode): HarnessSnapshot {
  try {
    return ctx.store.getHarness(node.manifest.harness);
  } catch (err) {
    fail(
      EXIT.NOT_FOUND,
      `the harness object ${node.manifest.harness.slice(0, 12)} is missing: ${(err as Error).message}`,
    );
  }
}

export function registerNode(program: Command): void {
  registerSnapshot(program);
  registerPropose(program);
  registerSubmit(program);
  registerShow(program);
  registerTree(program);
  registerTips(program);
  registerDeadEnds(program);
  registerLineage(program);
  registerDiff(program);
}

function registerSnapshot(program: Command): void {
  program
    .command('snapshot')
    .argument('<dir>', 'a harness directory')
    .option('--prefix <p>', 'the snapshot key prefix', HARNESS_PREFIX)
    .description('hash a directory into a harness id')
    .action((dir: string, opts: { prefix?: string }, cmd: Command) => {
      const g = globalOptions(cmd);
      const abs = isAbsolute(dir) ? dir : resolve(process.cwd(), dir);
      if (!existsSync(abs)) fail(EXIT.NOT_FOUND, `no directory at ${abs}`);
      const files = readHarness(abs, opts.prefix ?? HARNESS_PREFIX);
      const id = harnessId(files);
      const paths = Object.keys(files).sort();
      if (g.json) {
        out(JSON.stringify({ harnessId: id, files: paths }, null, 2));
        return;
      }
      out(`harness id  ${id}`);
      out(`files       ${paths.length}`);
      for (const p of paths) out(`  ${p}  ${Buffer.byteLength(files[p]!, 'utf8')} bytes`);
    });
}

function registerPropose(program: Command): void {
  program
    .command('propose')
    .description('create a scratch workspace to edit by hand. It runs nothing.')
    .option('--parent <id>', 'the parent node. Default: the current tip')
    .option('--area <area>', 'the declared primary area', 'other')
    .option('--motif <slug>', 'a short slug for the idea', 'hand-edit')
    .option('--hypothesis <text>', 'plain English. Design rule 4.')
    .option('--falsified-if <text>', 'what result would disprove it')
    .option('--metric <metric>', 'score or tokens', 'score')
    .option('--predict <int>', 'the predicted, signed, non-zero delta', '1000')
    .option('--reasoning <text>', 'why you think this works', '')
    .option('--why-not-untested <text>', 'why not an untried area')
    .action(async (opts: Record<string, string | undefined>, cmd: Command) => {
      const g = globalOptions(cmd);
      const ctx = openCtx(cmd);
      const view = await loadTree(ctx);
      const parent = resolveParent(ctx, view, opts['parent']);

      const hypothesis = opts['hypothesis'];
      if (hypothesis === undefined || hypothesis.trim().length < 30) {
        fail(
          EXIT.USAGE,
          '--hypothesis is required and must be at least 30 characters.\n' +
            '       Design rule 4: every node states a hypothesis in plain English.',
        );
      }
      const metric = opts['metric'] ?? 'score';
      if (metric !== 'score' && metric !== 'tokens') {
        fail(EXIT.USAGE, `--metric must be score or tokens, got ${metric}`);
      }
      const predicted = parseInt10(opts['predict'], 1000, '--predict');
      if (predicted === 0) fail(EXIT.USAGE, '--predict must be non-zero');

      const runId = randomUUID();
      const dir = scratchDir(runId, ctx.root);
      writeHarness(resolve(dir, 'harness'), harnessOf(ctx, parent));
      writeJsonFile(resolve(dir, 'tsconfig.json'), SCRATCH_TSCONFIG);

      const workspace: WorkspaceFile = {
        parent: parent.id,
        proposal: {
          hypothesis: hypothesis.trim(),
          falsifiedIf:
            opts['falsifiedIf'] ?? 'A verified delta below the 1000bp margin on both verifiers.',
          primaryArea: parseArea(opts['area'], 'other'),
          motif: opts['motif'] ?? 'hand-edit',
          metric,
          predictedDelta: predicted,
          reasoning: opts['reasoning'] ?? '',
          whyNotUntested: opts['whyNotUntested'] ?? null,
          contradicts: [],
        },
      };
      writeJsonFile(resolve(dir, 'proposal.json'), workspace);
      await ctx.closeLog();

      if (g.json) {
        emitJson(ctx, { workspace: dir, parent: parent.id, runId });
        return;
      }
      out(`workspace  ${dir}`);
      out(`parent     ${shortId(parent.id)}  ${parent.status}`);
      out('');
      out('Edit the TypeScript under harness/, then measure and submit it:');
      out(`  petri submit --workspace ${dir}`);
      out('');
      out('The same rules apply to you as to a model: at most 2 changed files,');
      out('at most 120 changed lines, relative sibling imports only, and');
      out('harness/contract.ts is immutable.');
    });
}

function registerSubmit(program: Command): void {
  program
    .command('submit')
    .description('package an edited harness as a candidate, measure it and publish it')
    .option('--workspace <dir>', 'a `petri propose` workspace. Default: the repo harness/')
    .option('--parent <id>', 'the parent node. Default: the workspace parent, or the tip')
    .option('--runs <odd>', 'runs per side')
    .option('--seed <int>', 'the proposal seed', '7')
    .option('--mode <mode>', 'live or replay')
    .option('--hypothesis <text>', 'plain English. Design rule 4.')
    .option('--falsified-if <text>', 'what result would disprove it')
    .option('--area <area>', 'the declared primary area')
    .option('--motif <slug>', 'a short slug for the idea')
    .option('--metric <metric>', 'score or tokens')
    .option('--predict <int>', 'the predicted, signed, non-zero delta')
    .option('--reasoning <text>', 'why you think this works')
    .option('--why-not-untested <text>', 'why not an untried area')
    .action(async (opts: Record<string, string | undefined>, cmd: Command) => {
      const g = globalOptions(cmd);
      const ctx = openCtx(cmd);
      const view = await loadTree(ctx);

      const workspaceArg = opts['workspace'];
      const workspaceDir =
        workspaceArg === undefined
          ? null
          : isAbsolute(workspaceArg)
            ? workspaceArg
            : resolve(process.cwd(), workspaceArg);

      let stored: WorkspaceFile | null = null;
      let harnessDir: string;
      if (workspaceDir === null) {
        harnessDir = resolve(ctx.root, 'harness');
      } else {
        const nested = resolve(workspaceDir, 'harness');
        harnessDir = existsSync(nested) ? nested : workspaceDir;
        const file = resolve(workspaceDir, 'proposal.json');
        if (existsSync(file)) stored = readWorkspaceFile(file);
      }
      if (!existsSync(harnessDir)) fail(EXIT.NOT_FOUND, `no harness at ${harnessDir}`);

      const parent = resolveParent(ctx, view, opts['parent'] ?? stored?.parent);
      const before = harnessOf(ctx, parent);
      const after = readHarness(harnessDir);

      const changed = changedFiles(before, after);
      if (changed.length === 0) {
        fail(
          EXIT.USAGE,
          `${harnessDir} is byte-identical to the parent harness ${shortId(parent.id)}.\n` +
            '       There is nothing to measure. Edit a file first.',
        );
      }
      const removed = changed.filter((c) => after[c.path] === undefined);
      if (removed.length > 0) {
        fail(
          EXIT.USAGE,
          `a proposal cannot delete a file. Deleted: ${removed.map((r) => r.path).join(', ')}`,
        );
      }
      if (changed.length > 2) {
        fail(
          EXIT.USAGE,
          `${changed.length} files changed. The cap is 2: ${changed.map((c) => c.path).join(', ')}`,
        );
      }
      const lineCount = changedLineCount(changed);
      if (lineCount > 120) {
        fail(EXIT.USAGE, `${lineCount} changed lines. The cap is 120.`);
      }

      const metric = opts['metric'] ?? stored?.proposal.metric ?? 'score';
      if (metric !== 'score' && metric !== 'tokens') {
        fail(EXIT.USAGE, `--metric must be score or tokens, got ${metric}`);
      }
      const hypothesis = (opts['hypothesis'] ?? stored?.proposal.hypothesis ?? '').trim();
      if (hypothesis.length < 30) {
        fail(
          EXIT.USAGE,
          '--hypothesis is required and must be at least 30 characters.\n' +
            '       Design rule 4: every node states a hypothesis in plain English.',
        );
      }

      const candidate = {
        hypothesis,
        falsifiedIf:
          opts['falsifiedIf'] ??
          stored?.proposal.falsifiedIf ??
          'A verified delta below the 1000bp margin on both verifiers.',
        primaryArea: parseArea(opts['area'], stored?.proposal.primaryArea ?? 'other'),
        motif: opts['motif'] ?? stored?.proposal.motif ?? 'hand-edit',
        metric,
        predictedDelta: parseInt10(
          opts['predict'],
          stored?.proposal.predictedDelta ?? 1000,
          '--predict',
        ),
        reasoning: opts['reasoning'] ?? stored?.proposal.reasoning ?? '',
        whyNotUntested: opts['whyNotUntested'] ?? stored?.proposal.whyNotUntested ?? null,
        contradicts: stored?.proposal.contradicts ?? [],
        files: changed.map((c) => ({ path: c.path, contents: after[c.path]! })),
      };

      const parsed = ProposalSchema.safeParse(candidate);
      if (!parsed.success) {
        fail(EXIT.USAGE, `the proposal is invalid: ${parsed.error.message}`);
      }
      const proposal: Proposal = parsed.data;

      const mode = parseMode(opts['mode'], ctx.config.mode);
      const runs = parseRuns(opts['runs'], ctx.config.runsPerVerification);
      const seed = parseInt10(opts['seed'], 7, '--seed');

      const provenance: Provenance = {
        source: 'human',
        model: 'none',
        promptHash: sha256Hex(''),
        digestHash: '',
        seed,
      };

      note(ctx, `measuring ${runs} runs of the candidate against ${shortId(parent.id)} …`);
      // The guards read the digest, and only the CLI can materialise the tree. Pass
      // it in, or `runCandidate` reads an empty tree and no area is ever saturated.
      const node = await runCandidate(
        {
          parentId: parent.id,
          proposal,
          provenance,
          runs,
          seed,
          mode,
        },
        { digest: digestOf(ctx, view) },
      );
      await ctx.closeLog();

      if (g.json) {
        emitJson(ctx, {
          node: node.id,
          parent: parent.id,
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

/** The digest of the loaded tree. The evolve guards read it. §12.2. */
export function digestOf(ctx: Ctx, view: TreeView): Digest {
  const bench = loadBench(ctx);
  return buildDigest({
    nodes: [...view.nodes.values()],
    bench: ctx.config.bench.id,
    benchName: ctx.config.bench.name,
    mode: ctx.config.mode,
    ledger: ctx.config.ledger,
    taskCount: bench.total,
    runs: ctx.config.runsPerVerification,
    constraints: { minDeltaBp: ctx.config.policy.minDeltaBp },
  });
}

/** One shared result block for `submit` and `evolve`. */
export function printCandidateResult(node: PetriNode): void {
  out(`node       ${node.id}`);
  out(`parent     ${shortId(node.manifest.parent)}`);
  out(`harness    ${shortId(node.manifest.harness)}`);
  out(`hypothesis ${node.manifest.hypothesis}`);
  out(`area       ${node.detail.proposal.primaryArea} / ${node.detail.proposal.motif}`);
  out(`derived    ${node.detail.derivedAreas.join(', ')}${node.detail.areaMismatch ? '  (MISMATCH: the digest uses the derived set)' : ''}`);
  if (node.detail.mechanical.cls === 'ok') {
    out(
      `claimed    ${node.detail.claimedMedianBp}bp over ${node.detail.claimedRuns.length} runs` +
        '  — a claim, not a vote. It never counts toward acceptance.',
    );
  } else {
    out(`mechanical ${node.detail.mechanical.cls}  exit ${node.detail.mechanical.exitCode}`);
    if (node.detail.mechanical.command !== '') out(`command    ${node.detail.mechanical.command}`);
    const evidence = node.detail.mechanical.evidence.trim();
    if (evidence !== '') {
      out('evidence');
      for (const line of evidence.split('\n').slice(0, 20)) out(`  ${line}`);
    }
  }
  out(`status     ${node.status}  ${node.statusCode}`);
  out(`           ${node.statusReason}`);
  out('');
  out('This node is NOT accepted. Two independent runners decide:');
  out(`  petri verify ${node.id.slice(0, 12)}`);
  out('You cannot verify your own node. That is design rule 1.');
}

function registerShow(program: Command): void {
  program
    .command('show')
    .argument('<nodeId>')
    .option('--diff', 'print the unified diff against the parent', false)
    .option('--runs', 'print the author\'s claimed runs', false)
    .option('--verifications', 'print every verification', false)
    .option('--full', 'print everything', false)
    .description('one node in full')
    .action(
      async (
        nodeId: string,
        opts: { diff?: boolean; runs?: boolean; verifications?: boolean; full?: boolean },
        cmd: Command,
      ) => {
        const g = globalOptions(cmd);
        const ctx = openCtx(cmd);
        const view = await loadTree(ctx);
        const id = resolveNodeId(ctx.store, nodeId);
        const node = view.nodes.get(id);
        if (node === undefined) fail(EXIT.NOT_FOUND, `no node ${id}`);
        await ctx.closeLog();

        const full = opts.full === true;
        const wantDiff = full || opts.diff === true;
        const wantRuns = full || opts.runs === true;
        const wantVer = full || opts.verifications === true;

        if (g.json) {
          emitJson(ctx, {
            node: {
              id: node.id,
              manifest: node.manifest,
              detail: node.detail,
              status: node.status,
              statusCode: node.statusCode,
              statusReason: node.statusReason,
              verifiedDeltaBp: node.verifiedDeltaBp,
              disputed: node.disputed,
              seq: node.seq,
              consensusNanos: node.consensusNanos,
              verifications: node.verifications,
              ...(wantDiff ? { diff: node.diff } : {}),
            },
          });
          return;
        }

        out(`node petri1:${node.id}`);
        out('');
        out(`tree       ${node.manifest.tree}`);
        out(`parent     ${shortId(node.manifest.parent)}`);
        out(`author     ${shortId(node.manifest.author)}`);
        out(`harness    ${shortId(node.manifest.harness)}`);
        out(`bench      ${shortId(node.manifest.bench)}`);
        out(`detail     ${shortId(node.manifest.detail)}`);
        out(`mode       ${node.mode}`);
        out(`trust      ${node.trust}`);
        out(`log seq    ${node.seq === 0 ? 'not published' : node.seq}`);
        out('');
        out('HYPOTHESIS');
        out(`  ${node.manifest.hypothesis}`);
        out(`  falsified if: ${node.detail.proposal.falsifiedIf}`);
        out('');
        out('AREA');
        out(`  declared ${node.detail.proposal.primaryArea} / ${node.detail.proposal.motif}`);
        out(`  derived  ${node.detail.derivedAreas.join(', ')}`);
        if (node.detail.areaMismatch) {
          out('  MISMATCH. The digest uses the derived set, so a label cannot dodge a');
          out('  saturated area.');
        }
        out('');
        out('PROVENANCE');
        out(
          `  ${node.detail.provenance.source} / model ${node.detail.provenance.model}` +
            ` / seed ${node.detail.provenance.seed}`,
        );
        out(`  prompt ${node.detail.provenance.promptHash.slice(0, 12)}  digest ${node.detail.provenance.digestHash || '-'}`);
        out('');
        out('MECHANICAL');
        out(`  ${node.detail.mechanical.cls}  exit ${node.detail.mechanical.exitCode}`);
        if (node.detail.mechanical.command !== '') out(`  ${node.detail.mechanical.command}`);
        if (node.detail.mechanical.evidence.trim() !== '') {
          for (const line of node.detail.mechanical.evidence.trim().split('\n')) out(`  ${line}`);
        }
        out('');
        out('CLAIMED BY THE AUTHOR  (never counts toward acceptance)');
        out(`  median ${node.detail.claimedMedianBp}bp over ${node.detail.claimedRuns.length} runs`);
        if (wantRuns) {
          node.detail.claimedRuns.forEach((r, i) => {
            out(
              `  run ${i}  passed ${r.passed}  ${r.scoreBp}bp  ${r.tokens} tok  ${r.wallMs} ms`,
            );
          });
        }
        out('');
        out('VERIFIED');
        // The counted set, never the file count. A repeat from one key and a
        // self-report are both on disk, and the rule counts neither.
        const verdict = view.verdicts.get(id);
        const tally = verifierTally(node, verdict);
        const verified = verifiedMedianOf(node, verdict);
        out(`  median ${verified === null ? '-' : `${verified}bp`}`);
        out(
          `  delta  ${node.verifiedDeltaBp === null ? '-' : fmtBp(node.verifiedDeltaBp)}` +
            `  from ${verifiersPhrase(tally)} report(s)`,
        );
        out(`  status ${node.status}  ${node.statusCode}${node.disputed ? '  DISPUTED' : ''}`);
        out(`         ${node.statusReason}`);
        out('');
        out('SIGNATURES');
        if (node.verifications.length === 0) {
          out('  none yet');
        }
        for (const signed of node.verifications) {
          const checked = checkReport(signed);
          const self = signed.pub === node.manifest.author ? '  SELF — never counts' : '';
          if (!checked.ok) {
            out(`  ${shortId(signed.pub)}  INVALID: ${checked.reason}`);
            continue;
          }
          out(
            `  ${shortId(signed.pub)}  delta ${fmtBp(checked.report.deltaMedianBp)}` +
              `  parent ${checked.report.parent.medianBp}bp -> candidate ${checked.report.candidate.medianBp}bp` +
              `  runs ${checked.report.runs}  mode ${checked.report.mode}${self}`,
          );
          if (wantVer) {
            out(`    report ${checked.id}`);
            out(`    sig    ${signed.sig}`);
            out(`    env    ${checked.report.env.platform}/${checked.report.env.arch} node ${checked.report.env.nodeVersion} model ${checked.report.env.model}`);
            checked.report.candidate.runs.forEach((r, i) => {
              const p = checked.report.parent.runs[i]!;
              out(
                `    run ${i}  parent ${p.passed}/${checked.report.parent.total} ${p.scoreBp}bp` +
                  `   candidate ${r.passed}/${checked.report.candidate.total} ${r.scoreBp}bp` +
                  `   seed ${r.seed.slice(0, 8)}`,
              );
            });
          }
        }
        if (wantDiff) {
          out('');
          out('DIFF  (display only. It is never hashed.)');
          out(node.diff === '' ? '  (no stored diff)' : node.diff);
        }
      },
    );
}

function registerTree(program: Command): void {
  program
    .command('tree')
    .option('--from <id>', 'start at this node')
    .option('--depth <n>', 'maximum depth to print')
    .option('--all', 'print every node, orphans included', false)
    .description('print the whole tree, rejected branches included')
    .action(
      async (opts: { from?: string; depth?: string; all?: boolean }, cmd: Command) => {
        const g = globalOptions(cmd);
        const ctx = openCtx(cmd);
        const view = await loadTree(ctx);
        await ctx.closeLog();

        const maxDepth = opts.depth === undefined ? Infinity : parseInt10(opts.depth, 0, '--depth');
        const starts =
          opts.from === undefined ? view.roots : [resolveNodeId(ctx.store, opts.from)];

        if (g.json) {
          emitJson(ctx, {
            nodes: [...view.nodes.values()].map((n) => {
              const tally = verifierTally(n, view.verdicts.get(n.id));
              return {
                id: n.id,
                parent: n.manifest.parent,
                status: n.status,
                statusCode: n.statusCode,
                statusReason: n.statusReason,
                deltaBp: n.verifiedDeltaBp,
                verifiers: tally.counted,
                storedReports: n.verifications.length,
                ignored: tally.ignored,
                hypothesis: n.manifest.hypothesis,
                mode: n.mode,
                seq: n.seq,
              };
            }),
            missing: view.missing,
          });
          return;
        }

        if (view.nodes.size === 0) {
          out('this tree has no node yet. Run `petri init` to create the genesis node.');
          return;
        }

        const lines: string[] = [];
        const seen = new Set<string>();
        const walk = (id: string, prefix: string, depth: number): void => {
          if (seen.has(id) || depth > maxDepth) return;
          seen.add(id);
          const node = view.nodes.get(id);
          if (node === undefined) return;
          const verdict = view.verdicts.get(id);
          lines.push(
            `${prefix}${statusLine({
              id: node.id,
              status: node.status,
              deltaBp: node.verifiedDeltaBp,
              deltas: deltasOf(node, verdict),
              verifiers: verifierTally(node, verdict),
              mode: node.mode,
              trust: node.trust,
            })}`,
          );
          lines.push(`${prefix}    ${node.manifest.hypothesis}`);
          lines.push(`${prefix}    ${node.statusCode}: ${node.statusReason}`);
          for (const kid of view.children.get(id) ?? []) walk(kid, `${prefix}  `, depth + 1);
        };
        for (const start of starts) walk(start, '', 0);

        if (opts.all === true) {
          for (const id of [...view.nodes.keys()].sort()) {
            if (!seen.has(id)) walk(id, '', 0);
          }
        }
        for (const line of lines) out(line);

        const totals = { accepted: 0, rejected: 0, pending: 0, contested: 0, other: 0 };
        for (const n of view.nodes.values()) {
          if (n.status === 'accepted') totals.accepted += 1;
          else if (n.status === 'rejected') totals.rejected += 1;
          else if (n.status === 'pending') totals.pending += 1;
          else if (n.status === 'contested') totals.contested += 1;
          else totals.other += 1;
        }
        out('');
        out(
          `${view.nodes.size} nodes: ${totals.accepted} accepted, ${totals.rejected} rejected, ` +
            `${totals.pending} pending, ${totals.contested} contested, ${totals.other} other`,
        );
        out('Rejected branches stay here forever. That is design rule 3.');
        if (view.missing.length > 0) {
          out('');
          out(`${view.missing.length} node(s) are in the log but not on this machine:`);
          for (const id of view.missing) out(`  ${shortId(id)}`);
        }
      },
    );
}

function registerTips(program: Command): void {
  program
    .command('tips')
    .description('accepted leaves. These are the frontiers worth extending.')
    .action(async (_opts: unknown, cmd: Command) => {
      const g = globalOptions(cmd);
      const ctx = openCtx(cmd);
      const view = await loadTree(ctx);
      await ctx.closeLog();
      const tips = tipsOf(view);
      if (g.json) {
        emitJson(ctx, {
          tips: tips.map((t) => ({
            id: t.id,
            depth: depthOf(view, t.id),
            deltaBp: t.verifiedDeltaBp,
            medianBp: verifiedMedianOf(t, view.verdicts.get(t.id)),
            hypothesis: t.manifest.hypothesis,
          })),
        });
        return;
      }
      if (tips.length === 0) {
        out('no accepted node yet. Every tree starts here.');
        out('Run `petri verify <nodeId>` from two independent machines.');
        return;
      }
      for (const t of tips) {
        out(
          `${shortId(t.id)}  depth ${depthOf(view, t.id)}  ` +
            `median ${verifiedMedianOf(t, view.verdicts.get(t.id)) ?? claimedMedianOf(t)}bp  ` +
            `delta ${t.verifiedDeltaBp === null ? '-' : fmtBp(t.verifiedDeltaBp)}`,
        );
        out(`          ${t.manifest.hypothesis}`);
      }
    });
}

function registerDeadEnds(program: Command): void {
  program
    .command('dead-ends')
    .argument('[nodeId]', 'restrict to one subtree')
    .description('every rejected node with its reason. Design rule 3, made visible.')
    .action(async (nodeId: string | undefined, _opts: unknown, cmd: Command) => {
      const g = globalOptions(cmd);
      const ctx = openCtx(cmd);
      const view = await loadTree(ctx);
      await ctx.closeLog();

      const within =
        nodeId === undefined
          ? null
          : new Set(subtreeOf(view, resolveNodeId(ctx.store, nodeId)));

      const dead = [...view.nodes.values()]
        .filter((n) => n.status === 'rejected' || n.status === 'contested')
        .filter((n) => within === null || within.has(n.id))
        .sort((a, b) => a.seq - b.seq || a.id.localeCompare(b.id));

      if (g.json) {
        emitJson(ctx, {
          deadEnds: dead.map((n) => ({
            id: n.id,
            status: n.status,
            statusCode: n.statusCode,
            statusReason: n.statusReason,
            deltaBp: n.verifiedDeltaBp,
            area: n.detail.proposal.primaryArea,
            motif: n.detail.proposal.motif,
            hypothesis: n.manifest.hypothesis,
          })),
        });
        return;
      }
      if (dead.length === 0) {
        out('no rejected node yet.');
        return;
      }
      for (const n of dead) {
        out(
          `${shortId(n.id)}  ${n.status}  ${n.statusCode}  ` +
            `${n.detail.proposal.primaryArea}/${n.detail.proposal.motif}  ` +
            `${n.verifiedDeltaBp === null ? '' : fmtBp(n.verifiedDeltaBp)}`,
        );
        out(`  "${n.manifest.hypothesis}"`);
        out(`  ${n.statusReason}`);
        out('');
      }
      out(`${dead.length} recorded failures. None of them was deleted.`);
    });
}

function subtreeOf(view: TreeView, id: string): string[] {
  const out: string[] = [];
  const stack = [id];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    out.push(cur);
    for (const kid of view.children.get(cur) ?? []) stack.push(kid);
  }
  return out;
}

function registerLineage(program: Command): void {
  program
    .command('lineage')
    .argument('<nodeId>')
    .description('the root-first path and the lineage digest')
    .action(async (nodeId: string, _opts: unknown, cmd: Command) => {
      const g = globalOptions(cmd);
      const ctx = openCtx(cmd);
      const view = await loadTree(ctx);
      await ctx.closeLog();
      const id = resolveNodeId(ctx.store, nodeId);
      const path = lineageOf(view, id);
      const digest = sha256Hex(path.map((n) => n.id).join('|'));

      if (g.json) {
        emitJson(ctx, {
          lineage: path.map((n) => ({
            id: n.id,
            status: n.status,
            deltaBp: n.verifiedDeltaBp,
            hypothesis: n.manifest.hypothesis,
          })),
          lineageDigest: digest,
        });
        return;
      }
      path.forEach((n, i) => {
        out(
          `${String(i).padStart(2, '0')}  ${shortId(n.id)}  ${n.status.padEnd(10)}` +
            ` ${n.verifiedDeltaBp === null ? '      -' : fmtBp(n.verifiedDeltaBp).padStart(7)}` +
            `  ${n.detail.proposal.primaryArea}/${n.detail.proposal.motif}`,
        );
        out(`    ${n.manifest.hypothesis}`);
      });
      out('');
      out(`lineage digest  ${digest}`);
    });
}

function registerDiff(program: Command): void {
  program
    .command('diff')
    .argument('<nodeId>')
    .option('--regenerate', 'rebuild the patch from the two snapshots and compare', false)
    .description('print diff.patch. It is display only and never hashed.')
    .action(
      async (nodeId: string, opts: { regenerate?: boolean }, cmd: Command) => {
        const g = globalOptions(cmd);
        const ctx = openCtx(cmd);
        const view = await loadTree(ctx);
        await ctx.closeLog();
        const id = resolveNodeId(ctx.store, nodeId);
        const node = view.nodes.get(id);
        if (node === undefined) fail(EXIT.NOT_FOUND, `no node ${id}`);

        let text = node.diff;
        let mismatch = false;
        if (opts.regenerate === true) {
          const parentId = node.manifest.parent;
          const before: HarnessSnapshot =
            parentId === 'root' ? {} : harnessOf(ctx, view.nodes.get(parentId)!);
          const after = ctx.store.getHarness(node.manifest.harness);
          const rebuilt = unifiedDiff(before, after);
          mismatch = rebuilt !== node.diff;
          text = rebuilt;
        }

        if (g.json) {
          emitJson(ctx, { node: id, diff: text, regenerated: opts.regenerate === true, mismatch });
          return;
        }
        out(text === '' ? '(no stored diff)' : text);
        if (mismatch) {
          process.stderr.write(
            'WARNING  the regenerated patch differs from the stored one.\n' +
              '         Diff algorithms vary, so this is a warning, not an error.\n' +
              '         The two harness snapshots remain the authority.\n',
          );
        }
      },
    );
}
