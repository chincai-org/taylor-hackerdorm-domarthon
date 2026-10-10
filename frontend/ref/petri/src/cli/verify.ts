/**
 * `petri verify`, `petri status` and `petri publish`.
 *
 * Design rule 1 is enforced here for the first of its three times: the command
 * refuses to run when you are the node author, and it exits 4.
 *
 * §6.5: one report covers BOTH sides. A verifier who runs only the candidate
 * proves nothing, because the machine, test flakiness, model drift and baseline
 * drift all move an absolute score.
 */
import type { Command } from 'commander';

import { contentId } from '../core/canonical.js';
import { harnessId } from '../core/ids.js';
import type { HarnessSnapshot, PetriNode } from '../core/schema.js';
import { PetriMessage, type VerificationSigned } from '../consensus/messages.js';
import { seal } from '../trust/envelope.js';
import {
  assertNotSelfVerification,
  buildReport,
  checkReport,
  SelfVerificationError,
  type SignedReport,
} from '../trust/report.js';
import { appendWorldCheck, runWorldCheck, worldCheckLine } from '../trust/world.js';
import { EXIT, fail } from './exit.js';
import {
  asCanon,
  buildEnv,
  emitJson,
  globalOptions,
  note,
  openCtx,
  out,
  parseMode,
  parseRuns,
  resolveNodeId,
  type Ctx,
} from './context.js';
import { fmtBp, ignoredPhrase, shortId, statusLine } from './banner.js';
import { loadBench, measure, seedsFor } from './measure.js';
import { printVerifyTrace } from './trace.js';
import { deltasOf, loadTree, verifierTally, type TreeView } from './tree.js';

function harnessFor(ctx: Ctx, node: PetriNode): HarnessSnapshot {
  const files = ctx.store.getHarness(node.manifest.harness);
  const id = harnessId(files);
  if (id !== node.manifest.harness) {
    fail(
      EXIT.INTEGRITY,
      `the stored harness for ${shortId(node.id)} rehashes to ${id.slice(0, 12)}, ` +
        `not ${node.manifest.harness.slice(0, 12)}`,
    );
  }
  return files;
}

export function registerVerify(program: Command): void {
  program
    .command('verify')
    .argument('<nodeId>')
    .option('--runs <odd>', 'runs per side')
    .option('--mode <mode>', 'live or replay')
    .option('--allow-graded', 'let a fixture miss fall back to the graded answers', false)
    .option('--show', 'print the model input, its output and every task result', false)
    .description('independently re-run the parent and the candidate, sign, publish')
    .action(
      async (
        nodeId: string,
        opts: { runs?: string; mode?: string; allowGraded?: boolean; show?: boolean },
        cmd: Command,
      ) => {
        const g = globalOptions(cmd);
        const ctx = openCtx(cmd);
        const view = await loadTree(ctx);
        const id = resolveNodeId(ctx.store, nodeId);
        const node = view.nodes.get(id);
        if (node === undefined) fail(EXIT.NOT_FOUND, `no node ${id}`);

        // A change that a guard or the typecheck stopped was never measured. There is
        // no score to re-run and sign, so refuse here instead of measuring a harness
        // that never ran. Its status stays pending by design (SPEC §13.1): the reason
        // lives in detail.mechanical, where the CLI and the UI show it.
        const blocked = verifyBlocker(node);
        if (blocked !== null) fail(EXIT.REFUSED, blocked);

        const identity = ctx.identity();

        // Design rule 1, enforcement 1 of 3. §9.4. The guard itself lives in
        // src/trust/report.js, beside the collapse rule, so the signing path and
        // the counting path share ONE definition of self-verification.
        // The author key comes from the manifest. The runner key comes from the
        // loaded identity. Neither is read from a message body.
        try {
          assertNotSelfVerification(id, node.manifest.author, identity.runnerId);
        } catch (err) {
          if (!(err instanceof SelfVerificationError)) throw err;
          fail(EXIT.REFUSED, err.message.replace(/^petri: /, ''));
        }

        const mode = parseMode(opts.mode, ctx.config.mode);
        if (mode !== node.detail.mode) {
          fail(
            EXIT.REFUSED,
            `node ${shortId(id)} was measured in ${node.detail.mode} mode and you asked for ` +
              `${mode}.\n       A replay number and a live number can never be compared. ` +
              'That ban is absolute.',
          );
        }
        if (node.manifest.bench !== ctx.config.bench.id) {
          fail(
            EXIT.INTEGRITY,
            `node ${shortId(id)} names bench ${node.manifest.bench.slice(0, 12)}, ` +
              `but this tree runs ${ctx.config.bench.id.slice(0, 12)}.`,
          );
        }

        const runs = parseRuns(opts.runs, ctx.config.runsPerVerification);
        if (runs < ctx.config.policy.minRuns) {
          process.stderr.write(
            `WARNING  ${runs} runs is below policy.minRuns ${ctx.config.policy.minRuns}.\n` +
              '         This report will be ignored by the acceptance rule.\n',
          );
        }

        const bench = loadBench(ctx);
        const allowGraded = opts.allowGraded === true;

        const parentId = node.manifest.parent;
        let parentNode: PetriNode | null = null;
        if (parentId !== 'root') {
          const found = view.nodes.get(parentId);
          if (found === undefined) {
            fail(EXIT.NOT_FOUND, `the parent ${shortId(parentId)} is not on this machine`);
          }
          parentNode = found;
        }

        // §6.9: the parent side of a root is the empty harness. It scores 0 by
        // construction, so it doubles as a per-report sandbox canary.
        const parentHarness: HarnessSnapshot =
          parentNode === null ? {} : harnessFor(ctx, parentNode);
        const parentHarnessId = harnessId(parentHarness);
        const candidateHarness = harnessFor(ctx, node);

        const seeds = seedsFor(id, runs);
        const startedAt = Date.now();

        note(ctx, `verifying ${shortId(id)} against ${shortId(parentId)}  (${runs} runs a side)`);

        const parentSide = await measure({
          ctx,
          node: parentId,
          harness: parentHarness,
          harnessId: parentHarnessId,
          bench,
          mode,
          runs,
          seeds,
          allowGraded,
          label: 'parent',
        });

        if (parentId === 'root' && parentSide.records.some((r) => r.passed > 0)) {
          fail(
            EXIT.ENVIRONMENT,
            'the EMPTY harness passed a task. The sandbox is broken, so every number\n' +
              '       from this machine is meaningless. The report is refused.\n' +
              '       A harness with no files can write no solution, so a pass means the\n' +
              '       task files leaked into the sandbox. Check bench/src/sandbox.ts and\n' +
              '       bench/tasks/, then run `pnpm test` before you measure anything.',
          );
        }

        const candidateSide = await measure({
          ctx,
          node: id,
          harness: candidateHarness,
          harnessId: node.manifest.harness,
          bench,
          mode,
          runs,
          seeds,
          allowGraded,
          label: 'candidate',
        });

        if (parentSide.total !== candidateSide.total) {
          fail(
            EXIT.INTEGRITY,
            `the two sides measured different task totals: ${parentSide.total} and ` +
              `${candidateSide.total}`,
          );
        }

        if (opts.show === true && !g.json) {
          printVerifyTrace({
            benchDir: ctx.benchDir,
            mode,
            parentId,
            candidateId: id,
            parentHarnessId,
            candidateHarnessId: node.manifest.harness,
            candidateHarness,
            parent: parentSide.results,
            candidate: candidateSide.results,
          });
        }

        const env = buildEnv(ctx, mode, allowGraded);
        const report = buildReport({
          tree: ctx.config.treeId,
          bench: ctx.config.bench.id,
          mode,
          runner: identity.runnerId,
          parentNode: parentId,
          candidateNode: id,
          total: candidateSide.total,
          parentRuns: parentSide.records,
          candidateRuns: candidateSide.records,
          startedAt,
          env,
        });

        const signed: SignedReport = seal('report', report, identity);
        const checked = checkReport(signed);
        if (!checked.ok) {
          fail(EXIT.INTEGRITY, `the report I just built does not check out: ${checked.reason}`);
        }
        const reportId = checked.id;
        ctx.store.addVerification(id, reportId, signed);

        const candidateScores = candidateSide.records.map((r) => r.scoreBp);
        const spreadBp = Math.max(...candidateScores) - Math.min(...candidateScores);
        const clean = parentSide.clean && candidateSide.clean;

        const message: VerificationSigned = {
          candMedianBp: report.candidate.medianBp,
          clean,
          deltaMedianBp: report.deltaMedianBp,
          envHash: contentId(asCanon(env)),
          mode,
          node: id,
          parent: parentId,
          parentMedianBp: report.parent.medianBp,
          report: reportId,
          runs,
          spreadBp,
          tree: ctx.config.treeId,
          type: 'VerificationSigned',
        };

        let seq: number | null = null;
        try {
          const receipt = await ctx.log().publish(message);
          seq = receipt.seq;
        } catch (err) {
          process.stderr.write(
            `petri: the report was stored but not published: ${(err as Error).message}\n`,
          );
        }

        // World ID runs after the report is signed and published. It is off by
        // default, and it never changes the acceptance rule. See src/trust/world.ts.
        const world = await runWorldCheck({
          tree: ctx.config.treeId, node: id, report: reportId, runner: identity.runnerId,
        });
        if (world.status === 'done') appendWorldCheck(ctx.root, world.record);

        // Re-derive the status from the evidence, this report included.
        const after = await loadTree(ctx);
        const updated = after.nodes.get(id);
        await ctx.closeLog();

        if (g.json) {
          emitJson(ctx, {
            node: id,
            report: reportId,
            runner: identity.runnerId,
            deltaMedianBp: report.deltaMedianBp,
            parentMedianBp: report.parent.medianBp,
            candidateMedianBp: report.candidate.medianBp,
            spreadBp,
            clean,
            runs,
            seq,
            world: world.status === 'done' ? world.record : null,
            status: updated?.status ?? node.status,
            statusCode: updated?.statusCode ?? node.statusCode,
            statusReason: updated?.statusReason ?? node.statusReason,
          });
          return;
        }

        out(`report     ${reportId}`);
        out(`runner     ${identity.runnerId}`);
        out(`parent     ${shortId(parentId)}  median ${report.parent.medianBp}bp`);
        out(`candidate  ${shortId(id)}  median ${report.candidate.medianBp}bp`);
        out(`delta      ${fmtBp(report.deltaMedianBp)}  (median of ${runs} paired deltas)`);
        out(`spread     ${spreadBp}bp over the candidate runs`);
        out(`clean      ${clean ? 'yes' : 'NO — a tampered or short batch cannot support a node'}`);
        out(`published  ${seq === null ? 'NO' : `seq ${seq}`}`);
        out(`world id   ${worldCheckLine(world)}`);
        out(`selfie     http://localhost:3000/selfie?node=${shortId(id)}&report=${reportId}`);
        out('');
        if (!clean) {
          out('One or more runs were tampered with or discarded. This report publishes');
          out('clean: false, which the acceptance rule turns into NOT_CLEAN.');
          out('');
        }
        if (updated !== undefined) {
          const updatedVerdict = after.verdicts.get(id);
          out(
            statusLine({
              id: updated.id,
              status: updated.status,
              deltaBp: updated.verifiedDeltaBp,
              deltas: deltasOf(updated, updatedVerdict),
              verifiers: verifierTally(updated, updatedVerdict),
              mode: updated.mode,
              trust: updated.trust,
            }),
          );
          out(`  ${updated.statusCode}: ${updated.statusReason}`);
        }
      },
    );
}

export function registerStatus(program: Command): void {
  program
    .command('status')
    .argument('[nodeId]', 'a node. Omit it for the repository status.')
    .option('--why', 'list every verification that did not count, and why', false)
    .description('run the acceptance rule and print the status, the code and the reason')
    .action(async (nodeId: string | undefined, opts: { why?: boolean }, cmd: Command) => {
      const g = globalOptions(cmd);
      const ctx = openCtx(cmd);
      const view = await loadTree(ctx);
      await ctx.closeLog();

      if (nodeId === undefined) {
        printRepoStatus(ctx, view, g.json);
        return;
      }

      const id = resolveNodeId(ctx.store, nodeId);
      const node = view.nodes.get(id);
      const verdict = view.verdicts.get(id);
      if (node === undefined || verdict === undefined) fail(EXIT.NOT_FOUND, `no node ${id}`);

      // The counted set, plus every stored report that did not count and why.
      // `verdict.ignored` alone is not enough: the reducer drops a repeat from
      // one key before the rule ever sees it, so only the tally knows about it.
      const tally = verifierTally(node, verdict);

      if (g.json) {
        emitJson(ctx, {
          node: id,
          status: verdict.status,
          code: verdict.code,
          reason: verdict.reason,
          deltaBp: verdict.deltaBp,
          counted: verdict.counted,
          verifiers: tally.counted,
          storedReports: node.verifications.length,
          ignored: tally.ignored,
          disputed: node.disputed,
        });
        return;
      }

      out(
        statusLine({
          id: node.id,
          status: node.status,
          deltaBp: node.verifiedDeltaBp,
          deltas: deltasOf(node, verdict),
          verifiers: tally,
          mode: node.mode,
          trust: node.trust,
        }),
      );
      out('');
      out(`code    ${verdict.code}`);
      out(`reason  ${verdict.reason}`);
      out(`counted ${verdict.counted.length === 0 ? 'none' : verdict.counted.map(shortId).join(', ')}`);
      out(
        `reports ${node.verifications.length} stored, ${tally.counted} counted, ` +
          `${tally.ignored.length} ignored`,
      );
      if (node.disputed) {
        out('DISPUTED  a StatusChanged message claimed a different status. The computed');
        out('          status wins. The disagreement is on the record.');
      }
      if (opts.why === true) {
        out('');
        out('IGNORED VERIFICATIONS');
        if (tally.ignored.length === 0) out('  none');
        for (const i of tally.ignored) out(`  ${shortId(i.pub)}  ${i.kind}: ${i.why}`);
      }
    });
}

function printRepoStatus(ctx: Ctx, view: TreeView, json: boolean): void {
  const unverified = [...view.nodes.values()]
    .filter((n) => n.status === 'pending')
    .sort((a, b) => a.seq - b.seq || a.id.localeCompare(b.id));
  const totals = { accepted: 0, rejected: 0, pending: 0, contested: 0, other: 0 };
  for (const n of view.nodes.values()) {
    if (n.status === 'accepted') totals.accepted += 1;
    else if (n.status === 'rejected') totals.rejected += 1;
    else if (n.status === 'pending') totals.pending += 1;
    else if (n.status === 'contested') totals.contested += 1;
    else totals.other += 1;
  }

  if (json) {
    emitJson(ctx, {
      root: ctx.root,
      tree: ctx.config.treeId,
      bench: ctx.config.bench,
      policy: ctx.config.policy,
      runnerId: ctx.identity().runnerId,
      totals,
      unverified: unverified.map((n) => {
        const tally = verifierTally(n, view.verdicts.get(n.id));
        return {
          id: n.id,
          verifiers: tally.counted,
          storedReports: n.verifications.length,
          ignored: tally.ignored,
          need: ctx.config.policy.minVerifications,
          statusCode: n.statusCode,
        };
      }),
    });
    return;
  }

  out(`root       ${ctx.root}`);
  out(`tree       ${ctx.config.treeId}`);
  out(`bench      ${ctx.config.bench.name}  ${ctx.config.bench.id.slice(0, 12)}`);
  out(`mode       ${ctx.config.mode}`);
  out(`ledger     ${ctx.config.ledger}  (trust ${ctx.trust})`);
  out(`identity   ${ctx.identity().runnerId}`);
  out(`policy     minDeltaBp ${ctx.config.policy.minDeltaBp}  minRuns ${ctx.config.policy.minRuns}` +
    `  minVerifications ${ctx.config.policy.minVerifications}`);
  out(
    `           maxRunSpreadBp ${ctx.config.policy.maxRunSpreadBp}` +
      `  maxRunnerDisagreementBp ${ctx.config.policy.maxRunnerDisagreementBp}`,
  );
  out(
    `           trustedRunners ${
      ctx.config.policy.trustedRunners.length === 0
        ? 'none — the tree is open'
        : ctx.config.policy.trustedRunners.length
    }`,
  );
  out('');
  out(
    `nodes      ${view.nodes.size}: ${totals.accepted} accepted, ${totals.rejected} rejected, ` +
      `${totals.pending} pending, ${totals.contested} contested, ${totals.other} other`,
  );
  out('');
  out('UNVERIFIED QUEUE');
  if (unverified.length === 0) {
    out('  empty');
  }
  for (const n of unverified) {
    const mine = n.manifest.author === ctx.identity().runnerId;
    // The counted set, never the number of report files. A repeat from one key
    // and a self-report are both on disk, and neither is a verification.
    const tally = verifierTally(n, view.verdicts.get(n.id));
    const ignored = tally.ignored.length === 0 ? '' : `  ${ignoredPhrase(tally)}`;
    out(
      `  ${shortId(n.id)}  ${tally.counted}/${ctx.config.policy.minVerifications}` +
        ` verifications${ignored}  ${n.statusCode}` +
        `${mine ? '  (yours — you cannot verify it)' : ''}`,
    );
  }
  if (view.missing.length > 0) {
    out('');
    out(`${view.missing.length} node(s) are in the log but missing from this machine.`);
  }
}

export function registerPublish(program: Command): void {
  program
    .command('publish')
    .argument('<nodeId>')
    .description('re-publish a stored node\'s NodeSubmitted, after a topic change')
    .action(async (nodeId: string, _opts: unknown, cmd: Command) => {
      const g = globalOptions(cmd);
      const ctx = openCtx(cmd);
      const id = resolveNodeId(ctx.store, nodeId);
      const manifest = ctx.store.readManifest(id);
      const identity = ctx.identity();

      // §18.7: the FIRST NodeSubmitted for a node id defines its author. Never
      // re-sign somebody else's node under your own key.
      if (manifest.author !== identity.runnerId) {
        fail(
          EXIT.REFUSED,
          `${shortId(id)} was authored by ${shortId(manifest.author)}, not by you.\n` +
            '       Re-signing it under your key would steal its authorship.',
        );
      }

      const envelope = ctx.store.readEnvelope(id);
      if (envelope === null) {
        fail(
          EXIT.NOT_FOUND,
          `${shortId(id)} has no stored envelope, so there is nothing to re-publish.`,
        );
      }
      // The stored bytes are re-published verbatim. The parse only proves they
      // are still a PetriMessage; it never rewrites what the author signed.
      const parsedBody = PetriMessage.safeParse(envelope.body);
      if (!parsedBody.success) {
        fail(
          EXIT.INTEGRITY,
          `the stored envelope of ${shortId(id)} is not a petri message: ${parsedBody.error.message}`,
        );
      }
      const receipt = await ctx.log().publish(parsedBody.data);
      await ctx.closeLog();

      if (g.json) {
        emitJson(ctx, { node: id, seq: receipt.seq, topic: receipt.topic, txId: receipt.txId });
        return;
      }
      out(`node    ${id}`);
      out(`topic   ${receipt.topic}`);
      out(`seq     ${receipt.seq}`);
      out(`tx      ${receipt.txId}`);
    });
}

/** Why this node cannot be verified, or null. Pure, so it is unit tested. */
export function verifyBlocker(node: Pick<PetriNode, 'id' | 'detail'>): string | null {
  const m = node.detail.mechanical;
  if (m.cls === 'ok') return null;
  return (
    `node ${shortId(node.id)} was stopped before scoring (${m.cls}).\n` +
    '       Nothing was measured, so there is no score to verify. It stays in the tree as a record.'
  );
}
