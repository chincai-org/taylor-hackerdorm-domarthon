/**
 * `petri fsck` — the integrity checker of SPEC.md §19.
 *
 * It checks the fourteen invariants of §19 against what is on disk and in the
 * log. It reads. It never deletes, and it never rewrites a node: design rule 3
 * says a record stays a record, including a broken one. `--rebuild` writes one
 * thing only, `.petri/index/`, which is a derived cache and holds no evidence.
 *
 * Check 8 is a warning, because two diff algorithms legitimately disagree and
 * the snapshots stay the authority. Everything else is an error and exits 3.
 * `--strict` turns the warning into an error too.
 *
 * Every check reports and continues. A tool that stops at the first fault tells
 * you about one problem; this one tells you about all of them.
 */
import { existsSync, readdirSync } from 'node:fs';

import type { Command } from 'commander';

import { contentId, type Canon } from '../core/canonical.js';
import { detailIdOf, harnessId, nodeIdOf } from '../core/ids.js';
import {
  BenchSpecSchema, HarnessObjectSchema, NodeDetailSchema, NodeManifestSchema,
  VerificationReportSchema,
  type NodeDetail, type NodeManifest, type NodeStatus,
} from '../core/schema.js';
import type { LogEntry } from '../consensus/log.js';
import { openEnvelope } from '../trust/envelope.js';
import { checkReport } from '../trust/report.js';
import { loadIdentity } from '../trust/identity.js';
import { unifiedDiff } from '../evolve/diff.js';
import { readJsonFile } from '../store/json.js';
import type { NodeIndexEntry } from '../store/store.js';
import {
  diffPath, envelopePath, identityPath, manifestPath, objectsDir, verificationPath,
  verificationsDir,
} from '../store/paths.js';
import { EXIT, fail, messageOf } from './exit.js';
import { emitJson, globalOptions, openCtx, out, type Ctx } from './context.js';
import { shortId } from './banner.js';
import { loadTree, type TreeView } from './tree.js';

/** One thing that is wrong. `where` is a node id, an object id or ''. */
export interface Finding {
  check: number;
  level: 'error' | 'warning';
  where: string;
  message: string;
}

/** The §19 invariant each check number covers. Printed with every finding. */
const CHECK_TITLES: Readonly<Record<number, string>> = {
  1: 'the node id is the hash of its manifest',
  2: 'the stored envelope opens and its signer is the author',
  3: 'every parent exists and the graph is acyclic',
  4: 'the harness object rehashes to the id the manifest names',
  5: 'the detail hashes to the id the manifest names',
  6: 'every verification checks out and its file name is its report id',
  7: 'no verification was signed by the node author',
  8: 'diff.patch regenerates from the two snapshots',
  9: 'every report mode equals its node mode',
  10: 'the log chain reproduces and the sequence is gap-free',
  11: 'the cached status equals the status the rule derives now',
  12: 'nothing was deleted',
  13: 'the identity file is private and its keys agree',
  14: 'every stored object parses against the schema its protocol names',
};

class Report {
  readonly findings: Finding[] = [];

  error(check: number, where: string, message: string): void {
    this.findings.push({ check, level: 'error', where, message });
  }

  warn(check: number, where: string, message: string): void {
    this.findings.push({ check, level: 'warning', where, message });
  }

  get errors(): Finding[] { return this.findings.filter((f) => f.level === 'error'); }
  get warnings(): Finding[] { return this.findings.filter((f) => f.level === 'warning'); }
}

/* ------------------------------------------------------------------ *
 * Per-node checks: 1, 2, 4, 5, 6, 7, 8, 9.
 * ------------------------------------------------------------------ */

/** Read a manifest without the store's throw, so a broken one is reported. */
function readManifestSafely(ctx: Ctx, id: string, r: Report): NodeManifest | null {
  const path = manifestPath(id, ctx.root);
  let raw: unknown;
  try {
    raw = readJsonFile(path);
  } catch (err) {
    r.error(1, id, `${path} could not be read: ${messageOf(err)}`);
    return null;
  }
  const parsed = NodeManifestSchema.safeParse(raw);
  if (!parsed.success) {
    r.error(1, id, `manifest.json is not a node manifest: ${parsed.error.message}`);
    return null;
  }
  const manifest = parsed.data as NodeManifest;
  const actual = nodeIdOf(manifest);
  if (actual !== id) {
    r.error(1, id, `the manifest hashes to ${actual}. The file was edited after it was written.`);
    return null;
  }
  return manifest;
}

function checkEnvelope(ctx: Ctx, id: string, manifest: NodeManifest, r: Report): void {
  const path = envelopePath(id, ctx.root);
  if (!existsSync(path)) {
    r.error(2, id, 'envelope.json is missing, so nothing proves who authored this node.');
    return;
  }
  let value: unknown;
  try {
    value = readJsonFile(path);
  } catch (err) {
    r.error(2, id, `envelope.json could not be read: ${messageOf(err)}`);
    return;
  }
  const opened = openEnvelope('msg', value);
  if (!opened.ok) {
    r.error(2, id, `envelope.json does not open: ${opened.reason}`);
    return;
  }
  if (opened.pub !== manifest.author) {
    r.error(
      2, id,
      `the envelope was signed by ${shortId(opened.pub)} but the manifest names author `
      + `${shortId(manifest.author)}.`,
    );
  }
}

function checkHarness(ctx: Ctx, id: string, manifest: NodeManifest, r: Report): void {
  if (!ctx.store.hasHarness(manifest.harness)) {
    r.error(4, id, `no harness object ${shortId(manifest.harness)}. The snapshot is gone.`);
    return;
  }
  try {
    ctx.store.getHarness(manifest.harness); // Rehashes through harnessDigestInput.
  } catch (err) {
    r.error(4, id, messageOf(err));
  }
}

/** Check 5, and return the detail so checks 8 and 9 can use it. */
function checkDetail(ctx: Ctx, id: string, manifest: NodeManifest, r: Report): NodeDetail | null {
  let value: Canon;
  try {
    value = ctx.store.objects.getUnder(manifest.detail);
  } catch (err) {
    r.error(5, id, `the detail object is unreadable: ${messageOf(err)}`);
    return null;
  }
  const parsed = NodeDetailSchema.safeParse(value);
  if (!parsed.success) {
    r.error(5, id, `the detail object is not a node detail: ${parsed.error.message}`);
    return null;
  }
  const detail = parsed.data as NodeDetail;
  const actual = detailIdOf(detail);
  if (actual !== manifest.detail) {
    r.error(
      5, id,
      `the detail hashes to ${actual} once the node back-reference is blanked, but the `
      + `manifest names ${manifest.detail}.`,
    );
    return null;
  }
  if (detail.node !== '' && detail.node !== id) {
    r.error(5, id, `the detail back-reference names node ${shortId(detail.node)}.`);
  }
  return detail;
}

/** Checks 6, 7 and 9 together, because all three read the same report files. */
function checkVerifications(
  ctx: Ctx, id: string, manifest: NodeManifest, detail: NodeDetail | null, r: Report,
): void {
  const dir = verificationsDir(id, ctx.root);
  if (!existsSync(dir)) return;
  for (const file of readdirSync(dir).sort()) {
    if (!/^[0-9a-f]{64}\.json$/.test(file)) {
      r.error(6, id, `${file} is not a report file name. A report is named by its report id.`);
      continue;
    }
    const reportId = file.slice(0, 64);
    let value: unknown;
    try {
      value = readJsonFile(verificationPath(id, reportId, ctx.root));
    } catch (err) {
      r.error(6, id, `verification ${shortId(reportId)} could not be read: ${messageOf(err)}`);
      continue;
    }
    const checked = checkReport(value, reportId);
    if (!checked.ok) {
      r.error(6, id, `verification ${shortId(reportId)} does not check out: ${checked.reason}`);
      continue;
    }
    // Design rule 1. The author can never verify their own node.
    if (checked.report.runner === manifest.author) {
      r.error(
        7, id,
        `verification ${shortId(reportId)} was signed by the node author `
        + `${shortId(manifest.author)}. An author's own run is never a vote.`,
      );
    }
    if (detail !== null && checked.report.mode !== detail.mode) {
      r.error(
        9, id,
        `verification ${shortId(reportId)} is a ${checked.report.mode} report, but the node was `
        + `measured in ${detail.mode} mode. The two can never be compared.`,
      );
    }
  }
}

/** Check 8. A warning: two diff algorithms may legitimately disagree. */
function checkDiff(ctx: Ctx, id: string, manifest: NodeManifest, r: Report): void {
  const path = diffPath(id, ctx.root);
  if (!existsSync(path)) return; // The patch is display output. Absence loses nothing.
  let before: Record<string, string>;
  let after: Record<string, string>;
  try {
    before = { ...ctx.store.parentSnapshotOf(id) };
    after = { ...ctx.store.getHarness(manifest.harness) };
  } catch (err) {
    r.warn(8, id, `diff.patch could not be regenerated: ${messageOf(err)}`);
    return;
  }
  const rebuilt = unifiedDiff(before, after);
  if (rebuilt !== ctx.store.readDiff(id)) {
    r.warn(
      8, id,
      'diff.patch differs from the patch the two snapshots regenerate. The snapshots are '
      + 'the authority, and the node id never covered this file.',
    );
  }
}

/* ------------------------------------------------------------------ *
 * Repository checks: 3, 10, 11, 12, 13, 14.
 * ------------------------------------------------------------------ */

/** Check 3. Every parent exists, and no node is its own ancestor. */
function checkGraph(manifests: Map<string, NodeManifest>, r: Report): void {
  for (const [id, manifest] of manifests) {
    if (manifest.parent !== 'root' && !manifests.has(manifest.parent)) {
      r.error(
        3, id,
        `its parent ${shortId(manifest.parent)} is not on this machine. `
        + 'A node whose parent is gone cannot be re-measured.',
      );
    }
  }
  for (const id of manifests.keys()) {
    const seen = new Set<string>([id]);
    let cur = manifests.get(id)!.parent;
    while (cur !== 'root') {
      if (seen.has(cur)) {
        r.error(3, id, `the parent chain loops back to ${shortId(cur)}. The graph is not a tree.`);
        break;
      }
      seen.add(cur);
      const next = manifests.get(cur);
      if (next === undefined) break; // Already reported above.
      cur = next.parent;
    }
  }
}

/**
 * Check 13. The private key must stay private, and the two keys must agree.
 *
 * `loadIdentity` already refuses a file other users can read and a public key
 * that does not derive from the private key. Calling it IS the check, so there
 * is only one copy of the rule.
 */
function checkIdentity(ctx: Ctx, r: Report): void {
  const path = identityPath(ctx.root);
  if (!existsSync(path)) {
    r.error(13, '', `no identity at ${path}. Run \`petri id create\` first.`);
    return;
  }
  try {
    loadIdentity(path);
  } catch (err) {
    r.error(13, '', messageOf(err));
  }
}

/**
 * Check 14. Every object parses against the schema its `protocol` names, and it
 * still hashes to the id it is stored under.
 *
 * Two protocols are addressed by a rule that is not contentId of the stored
 * bytes, and both are the documented exceptions of §7.8.
 */
function checkObjects(ctx: Ctx, r: Report): void {
  const base = objectsDir(ctx.root);
  if (!existsSync(base)) return;
  for (const shard of readdirSync(base, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!shard.isDirectory() || !/^[0-9a-f]{2}$/.test(shard.name)) continue;
    for (const file of readdirSync(`${base}/${shard.name}`).sort()) {
      if (!/^[0-9a-f]{62}\.json$/.test(file)) {
        r.error(14, '', `objects/${shard.name}/${file} is not an object file name.`);
        continue;
      }
      const id = shard.name + file.slice(0, 62);
      let value: Canon;
      try {
        value = ctx.store.objects.getUnder(id);
      } catch (err) {
        r.error(14, id, messageOf(err));
        continue;
      }
      checkOneObject(id, value, r);
    }
  }
}

function checkOneObject(id: string, value: Canon, r: Report): void {
  const protocol =
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value['protocol']
      : undefined;
  if (typeof protocol !== 'string') {
    r.error(14, id, 'the object carries no `protocol` field, so no schema can be chosen.');
    return;
  }
  switch (protocol) {
    case 'petri/harness/1': {
      const parsed = HarnessObjectSchema.safeParse(value);
      if (!parsed.success) { r.error(14, id, `not a harness object: ${parsed.error.message}`); return; }
      const actual = harnessId(parsed.data.files);
      if (actual !== id) r.error(14, id, `the harness files hash to ${actual}.`);
      return;
    }
    case 'petri/detail/1': {
      const parsed = NodeDetailSchema.safeParse(value);
      if (!parsed.success) { r.error(14, id, `not a node detail: ${parsed.error.message}`); return; }
      const actual = detailIdOf(parsed.data as NodeDetail);
      if (actual !== id) r.error(14, id, `the detail hashes to ${actual} with the node blanked.`);
      return;
    }
    case 'petri/bench/1': {
      const parsed = BenchSpecSchema.safeParse(value);
      if (!parsed.success) { r.error(14, id, `not a bench spec: ${parsed.error.message}`); return; }
      break;
    }
    case 'petri/verify/1': {
      const parsed = VerificationReportSchema.safeParse(value);
      if (!parsed.success) { r.error(14, id, `not a verification report: ${parsed.error.message}`); return; }
      break;
    }
    case 'petri/run/1':
    case 'petri/tests/1':
      // Both are content-addressed with no Zod schema of their own. The id check
      // below is the whole check: the bytes are the bytes the id names.
      break;
    default:
      r.error(14, id, `protocol "${protocol}" names no schema Petri declares.`);
      return;
  }
  const actual = contentId(value);
  if (actual !== id) r.error(14, id, `the object hashes to ${actual}, not to the id it is stored under.`);
}

/* ------------------------------------------------------------------ *
 * The command
 * ------------------------------------------------------------------ */

interface FsckOptions { rebuild?: boolean; strict?: boolean }

export function registerFsck(program: Command): void {
  program
    .command('fsck')
    .description('check every invariant of §19. It never deletes and never rewrites a node.')
    .option('--rebuild', 'regenerate .petri/index/ from nodes/ and objects/', false)
    .option('--strict', 'treat the diff warning of check 8 as an error', false)
    .action(async (opts: FsckOptions, cmd: Command) => {
      const g = globalOptions(cmd);
      const ctx = openCtx(cmd);
      const r = new Report();

      const ids = ctx.store.listNodeIds();
      const manifests = new Map<string, NodeManifest>();

      for (const id of ids) {
        const manifest = readManifestSafely(ctx, id, r);
        if (manifest === null) continue;
        manifests.set(id, manifest);
        checkEnvelope(ctx, id, manifest, r);
        checkHarness(ctx, id, manifest, r);
        const detail = checkDetail(ctx, id, manifest, r);
        checkVerifications(ctx, id, manifest, detail, r);
        checkDiff(ctx, id, manifest, r);
      }

      checkGraph(manifests, r);
      checkIdentity(ctx, r);
      checkObjects(ctx, r);

      // Check 10, and the log half of check 12. Reading the local log verifies
      // the chain and the sequence on every line, so a throw here IS check 10.
      const entries: LogEntry[] = [];
      try {
        for await (const entry of ctx.log().read()) entries.push(entry);
      } catch (err) {
        r.error(10, '', messageOf(err));
      }
      await ctx.closeLog();
      checkNothingDeleted(ctx, entries, manifests, r);

      // Check 11 needs the derived status, which needs a tree that loads. It is
      // attempted even after an earlier failure, so one broken node never hides
      // a stale cache on every other node.
      let view: TreeView | null = null;
      try {
        view = await loadTree(ctx);
        await ctx.closeLog();
      } catch (err) {
        r.error(11, '', `the tree could not be materialised: ${messageOf(err)}`);
      }
      const rebuilt = view === null ? null : indexEntriesOf(view);
      if (view !== null && rebuilt !== null) checkCachedStatus(ctx, rebuilt, r);

      if (opts.rebuild === true) {
        if (view === null || rebuilt === null) {
          r.error(11, '', 'the index was not rebuilt, because the tree does not load.');
        } else {
          const statuses = new Map<string, NodeStatus>(
            [...view.nodes].map(([id, n]) => [id, n.status]),
          );
          ctx.store.writeIndexFiles(rebuilt, ctx.store.treeIndex((id) => statuses.get(id) ?? 'pending'));
        }
      }

      emit(ctx, r, ids.length, opts, g.json);
    });
}

/** Check 12. Nothing was deleted: every referenced record is still on disk. */
function checkNothingDeleted(
  ctx: Ctx, entries: readonly LogEntry[], manifests: Map<string, NodeManifest>, r: Report,
): void {
  for (const [id, manifest] of manifests) {
    if (manifest.parent !== 'root' && !manifests.has(manifest.parent)) {
      r.error(12, id, `its parent ${shortId(manifest.parent)} was named but is not on disk.`);
    }
  }
  for (const entry of entries) {
    const body = entry.envelope.body;
    if (body.type === 'NodeSubmitted') {
      if (!manifests.has(body.node)) {
        r.error(
          12, body.node,
          `log sequence ${entry.seq} submitted this node, but it is not on this machine.`,
        );
      }
      continue;
    }
    if (body.type !== 'VerificationSigned') continue;
    if (!existsSync(verificationPath(body.node, body.report, ctx.root))) {
      r.error(
        12, body.node,
        `log sequence ${entry.seq} names report ${shortId(body.report)}, which is not on disk.`,
      );
    }
  }
}

/** The derived cache rows, exactly as `--rebuild` would write them. */
function indexEntriesOf(view: TreeView): Record<string, NodeIndexEntry> {
  const entries: Record<string, NodeIndexEntry> = {};
  for (const [id, node] of view.nodes) {
    entries[id] = {
      parent: node.manifest.parent,
      status: node.status,
      deltaBp: node.verifiedDeltaBp,
      seq: node.seq,
      reason: node.statusReason,
    };
  }
  return entries;
}

/** Check 11. A cache that contradicts the rule is worse than no cache. */
function checkCachedStatus(ctx: Ctx, rebuilt: Record<string, NodeIndexEntry>, r: Report): void {
  const cached = ctx.store.readNodeIndex();
  if (cached === null) return; // No cache is not a fault. `--rebuild` writes one.
  for (const [id, entry] of Object.entries(rebuilt)) {
    const was = cached[id];
    if (was === undefined) {
      r.error(11, id, 'the node is missing from index/nodes.json. Run `petri fsck --rebuild`.');
      continue;
    }
    if (was.status !== entry.status) {
      r.error(
        11, id,
        `index/nodes.json caches status "${was.status}" but the rule derives "${entry.status}" `
        + 'now. Run `petri fsck --rebuild`.',
      );
    }
  }
  for (const id of Object.keys(cached)) {
    if (rebuilt[id] === undefined) {
      r.error(11, id, 'index/nodes.json holds a node that is not on disk.');
    }
  }
}

function emit(ctx: Ctx, r: Report, nodeCount: number, opts: FsckOptions, json: boolean): void {
  const strict = opts.strict === true;
  const errors = r.errors;
  const warnings = r.warnings;

  if (json) {
    emitJson(ctx, {
      root: ctx.root,
      nodes: nodeCount,
      errors: errors.length,
      warnings: warnings.length,
      strict,
      findings: r.findings,
    });
  } else {
    out(`fsck ${ctx.root}`);
    out(`  nodes     ${nodeCount}`);
    out(`  errors    ${errors.length}`);
    out(`  warnings  ${warnings.length}${strict ? '  (--strict: warnings fail)' : ''}`);
    if (r.findings.length > 0) out('');
    for (const f of r.findings) {
      const where = f.where === '' ? 'repository' : shortId(f.where);
      out(`${f.level.toUpperCase().padEnd(7)} check ${String(f.check).padStart(2)}  ${where}`);
      out(`        ${CHECK_TITLES[f.check] ?? ''}`);
      out(`        ${f.message}`);
    }
    if (r.findings.length === 0) {
      out('');
      out('Every invariant of §19 holds. Nothing was deleted.');
    }
  }

  if (errors.length > 0 || (strict && warnings.length > 0)) {
    fail(
      EXIT.INTEGRITY,
      `${errors.length} error(s) and ${warnings.length} warning(s). `
      + 'Nothing was changed. A node is a record, so fsck never repairs one.',
    );
  }
}
