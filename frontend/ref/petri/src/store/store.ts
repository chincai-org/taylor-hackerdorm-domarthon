/**
 * PetriStore. The only class that touches disk outside `.petri/scratch/`.
 * See SPEC.md section 7.
 *
 * The store keeps evidence. The consensus log keeps commitments. A hash in the
 * log lets anyone check that the bytes they fetched here are the bytes the
 * author signed.
 *
 * The store NEVER writes a status. Status is derived from the evidence on every
 * load, so a stale cache can never contradict the evidence. `.petri/index/` may
 * cache it for speed, and `petri fsck` recomputes and compares.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import type { Canon } from '../core/canonical.js';
import { integrityError, notFoundError } from '../core/errors.js';
import {
  EMPTY_HARNESS_ID, benchIdOf, detailIdOf, harnessId, nodeIdOf, toCanon,
} from '../core/ids.js';
import {
  BenchSpecSchema, HarnessObjectSchema, NodeDetailSchema, NodeManifestSchema,
  type BenchSpec, type HarnessObject, type HarnessSnapshot, type NodeDetail,
  type NodeManifest, type NodeStatus, type SealedEnvelope, type SignedReport,
} from '../core/schema.js';
import { buildTreeIndex, childrenIndex, tips, type TreeIndex, type TreeNodeView } from '../core/tree.js';
import { byteCompare } from '../core/canonical.js';
import { FileObjectStore, type ObjectStore } from './objects.js';
import { readJsonFile, writeJsonFile, writeTextFile } from './json.js';
import {
  REPO_ROOT, assertHex64, childrenIndexPath, diffPath, envelopePath, indexDir, manifestPath,
  nodeDir, nodesDir, nodesIndexPath, objectsDir, petriDir, tipsIndexPath, verificationPath,
  verificationsDir,
} from './paths.js';

/** Everything stored for one node. The status is NOT part of it. */
export interface NodeRecord {
  id: string;
  manifest: NodeManifest;
  detail: NodeDetail;
  /** Display only. NEVER hashed. Empty when no patch file was written. */
  diff: string;
  /** The sealed NodeSubmitted, byte-identical to the one in the log. */
  envelope: SealedEnvelope<Canon> | null;
  verifications: SignedReport[];
}

export interface WriteNodeInput {
  manifest: NodeManifest;
  /** `node` may be "" or the node id. The store fills it in before writing. */
  detail: NodeDetail;
  /** Unified diff against the parent snapshot. Display only. */
  diff: string;
  /** The sealed NodeSubmitted. Store it so a reader can check authorship with no log. */
  envelope?: SealedEnvelope<Canon>;
  /** The harness snapshot this node runs. Written to the object store when given. */
  harness?: HarnessSnapshot;
}

/** One row of the derived `.petri/index/nodes.json`. Never authoritative. */
export interface NodeIndexEntry {
  parent: string;
  status: NodeStatus;
  deltaBp: number | null;
  seq: number;
  reason: string;
}

export class PetriStore {
  readonly root: string;
  readonly objects: ObjectStore;

  constructor(root: string = REPO_ROOT) {
    this.root = root;
    this.objects = new FileObjectStore(root);
  }

  /**
   * Create the directory skeleton under `.petri/`. `petri init` calls it.
   *
   * It creates and never deletes, so running it on a live tree is safe and
   * design rule 3 holds. The directory mode is 0700, because `identity.json`
   * lives beside these directories and holds a private key.
   */
  init(): void {
    mkdirSync(petriDir(this.root), { recursive: true, mode: 0o700 });
    for (const dir of [objectsDir(this.root), nodesDir(this.root), indexDir(this.root)]) {
      mkdirSync(dir, { recursive: true });
    }
  }

  /* ---------------------------------------------------------- harness */

  /**
   * Store a harness snapshot and return its harness id.
   *
   * The id is harnessId(files), through the framing of section 3.4. It is NOT
   * contentId(HarnessObject). The wrapper exists only so the file on disk says
   * what it is.
   */
  putHarness(snapshot: HarnessSnapshot): string {
    const id = harnessId(snapshot);
    const object: HarnessObject = { protocol: 'petri/harness/1', files: { ...snapshot } };
    this.objects.putUnder(id, toCanon(object));
    return id;
  }

  getHarness(id: string): HarnessSnapshot {
    assertHex64(id, 'harness id');
    if (id === EMPTY_HARNESS_ID && !this.objects.has(id)) return {};
    const parsed = HarnessObjectSchema.safeParse(this.objects.getUnder(id));
    if (!parsed.success) {
      throw integrityError(`petri: object ${id} is not a harness object: ${parsed.error.message}`);
    }
    const actual = harnessId(parsed.data.files);
    if (actual !== id) {
      throw integrityError(
        `petri: harness object ${id} rehashes to ${actual}. The stored files are not the files it names.`,
      );
    }
    return parsed.data.files;
  }

  hasHarness(id: string): boolean {
    return id === EMPTY_HARNESS_ID || this.objects.has(id);
  }

  /* ------------------------------------------------------------ bench */

  putBench(spec: BenchSpec): string {
    const id = benchIdOf(spec);
    this.objects.putUnder(id, toCanon(spec));
    return id;
  }

  getBench(id: string): BenchSpec {
    const parsed = BenchSpecSchema.safeParse(this.objects.get(id));
    if (!parsed.success) {
      throw integrityError(`petri: object ${id} is not a bench spec: ${parsed.error.message}`);
    }
    return parsed.data;
  }

  /* ----------------------------------------------------------- detail */

  /**
   * Store a NodeDetail and return the id the manifest must carry.
   *
   * The id is taken with the `node` back-reference blanked, so the stored file
   * does not hash to its own address. That is the one deliberate exception in
   * Petri, and `petri fsck` check 5 verifies it.
   */
  putDetail(detail: NodeDetail): string {
    const id = detailIdOf(detail);
    this.objects.putUnder(id, toCanon(detail));
    return id;
  }

  getDetail(id: string): NodeDetail {
    const parsed = NodeDetailSchema.safeParse(this.objects.getUnder(id));
    if (!parsed.success) {
      throw integrityError(`petri: object ${id} is not a node detail: ${parsed.error.message}`);
    }
    const actual = detailIdOf(parsed.data);
    if (actual !== id) {
      throw integrityError(
        `petri: detail ${id} rehashes to ${actual} once the node back-reference is blanked.`,
      );
    }
    return parsed.data;
  }

  /* ------------------------------------------------------------ nodes */

  hasNode(id: string): boolean {
    return existsSync(manifestPath(id, this.root));
  }

  /** Every node id on disk, in UTF-8 byte order. */
  listNodeIds(): string[] {
    const base = nodesDir(this.root);
    if (!existsSync(base)) return [];
    const out: string[] = [];
    for (const shard of readdirSync(base, { withFileTypes: true })) {
      if (!shard.isDirectory() || !/^[0-9a-f]{2}$/.test(shard.name)) continue;
      const shardDir = `${base}/${shard.name}`;
      for (const rest of readdirSync(shardDir, { withFileTypes: true })) {
        if (!rest.isDirectory()) continue;
        const id = shard.name + rest.name;
        if (/^[0-9a-f]{64}$/.test(id)) out.push(id);
      }
    }
    return out.sort(byteCompare);
  }

  /**
   * Write one node. Returns the node id.
   *
   * It writes no status, because Petri stores none. A node whose measured delta
   * is negative and a node that failed to typecheck are written the same way.
   * Design rule 3: nothing is ever deleted, and a failed experiment is a record.
   */
  writeNode(input: WriteNodeInput): string {
    const manifest = NodeManifestSchema.parse(input.manifest) as NodeManifest;
    const id = nodeIdOf(manifest);

    const detailId = detailIdOf(input.detail);
    if (detailId !== manifest.detail) {
      throw integrityError(
        `petri: the detail hashes to ${detailId} but the manifest names ${manifest.detail}.`,
      );
    }

    if (input.harness !== undefined) {
      const harness = this.putHarness(input.harness);
      if (harness !== manifest.harness) {
        throw integrityError(
          `petri: the snapshot hashes to ${harness} but the manifest names ${manifest.harness}.`,
        );
      }
    }

    const detail: NodeDetail = { ...input.detail, node: id };
    NodeDetailSchema.parse(detail);
    this.objects.putUnder(detailId, toCanon(detail));

    writeJsonFile(manifestPath(id, this.root), manifest);
    writeTextFile(diffPath(id, this.root), input.diff);
    if (input.envelope !== undefined) {
      writeJsonFile(envelopePath(id, this.root), input.envelope);
    }
    return id;
  }

  readManifest(id: string): NodeManifest {
    const path = manifestPath(id, this.root);
    if (!existsSync(path)) throw notFoundError(`petri: no node ${id}.`);
    const parsed = NodeManifestSchema.safeParse(readJsonFile(path));
    if (!parsed.success) {
      throw integrityError(`petri: ${path} is not a node manifest: ${parsed.error.message}`);
    }
    const manifest = parsed.data as NodeManifest;
    const actual = nodeIdOf(manifest);
    if (actual !== id) {
      throw integrityError(`petri: node ${id} hashes to ${actual}. The manifest was edited.`);
    }
    return manifest;
  }

  readDetail(id: string): NodeDetail {
    return this.getDetail(this.readManifest(id).detail);
  }

  /** The stored patch text. Display only. Empty when the file is absent. */
  readDiff(id: string): string {
    const path = diffPath(id, this.root);
    return existsSync(path) ? readFileSync(path, 'utf8') : '';
  }

  /**
   * The sealed NodeSubmitted stored beside the node, or null when absent.
   * The signature is NOT checked here. src/trust/envelope.ts owns that check.
   */
  readEnvelope(id: string): SealedEnvelope<Canon> | null {
    const path = envelopePath(id, this.root);
    if (!existsSync(path)) return null;
    const value = readJsonFile(path);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw integrityError(`petri: ${path} is not an envelope object.`);
    }
    const e = value as Record<string, unknown>;
    if (e['ver'] !== 1 || typeof e['pub'] !== 'string' || typeof e['sig'] !== 'string') {
      throw integrityError(`petri: ${path} is not a version 1 signed envelope.`);
    }
    return value as SealedEnvelope<Canon>;
  }

  readNode(id: string): NodeRecord {
    const manifest = this.readManifest(id);
    return {
      id,
      manifest,
      detail: this.getDetail(manifest.detail),
      diff: this.readDiff(id),
      envelope: this.readEnvelope(id),
      verifications: this.readVerifications(id),
    };
  }

  /** The snapshot this node's parent ran. A root node compares against the empty harness. */
  parentSnapshotOf(id: string): HarnessSnapshot {
    const manifest = this.readManifest(id);
    if (manifest.parent === 'root') return {};
    return this.getHarness(this.readManifest(manifest.parent).harness);
  }

  /** Regenerate the display diff from the two content-addressed snapshots. */
  snapshotOf(id: string): HarnessSnapshot {
    return this.getHarness(this.readManifest(id).harness);
  }

  /* ---------------------------------------------------- verifications */

  /**
   * Store one signed verification report under a node.
   * `reportId` is contentId(report.body), so the file name names the report.
   */
  addVerification(nodeId: string, reportId: string, report: SignedReport): void {
    if (!this.hasNode(nodeId)) throw notFoundError(`petri: no node ${nodeId}.`);
    writeJsonFile(verificationPath(nodeId, reportId, this.root), report);
  }

  listVerificationIds(nodeId: string): string[] {
    const dir = verificationsDir(nodeId, this.root);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => /^[0-9a-f]{64}\.json$/.test(f))
      .map((f) => f.slice(0, 64))
      .sort(byteCompare);
  }

  /**
   * Every stored verification for a node, in report-id order so two machines
   * read them in the same sequence. Signatures are NOT checked here; use
   * checkReport from src/trust/report.ts.
   */
  readVerifications(nodeId: string): SignedReport[] {
    const out: SignedReport[] = [];
    for (const reportId of this.listVerificationIds(nodeId)) {
      const value = readJsonFile(verificationPath(nodeId, reportId, this.root));
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw integrityError(`petri: verification ${reportId} of node ${nodeId} is not an object.`);
      }
      out.push(value as SignedReport);
    }
    return out;
  }

  /* ------------------------------------------------------------- tree */

  /**
   * Build the tree index from the manifests on disk.
   * `statusOf` supplies the derived status. Without it every node reads
   * 'pending', which is what a caller that only needs the shape wants.
   */
  treeIndex(statusOf?: (id: string, manifest: NodeManifest) => NodeStatus): TreeIndex {
    const views: TreeNodeView[] = [];
    for (const id of this.listNodeIds()) {
      const manifest = this.readManifest(id);
      views.push({
        id,
        parent: manifest.parent,
        status: statusOf === undefined ? 'pending' : statusOf(id, manifest),
      });
    }
    return buildTreeIndex(views);
  }

  /* ------------------------------------------------------------ index */

  /** Write the derived cache. Everything here is rebuildable from nodes/ and objects/. */
  writeIndexFiles(entries: Record<string, NodeIndexEntry>, index: TreeIndex): void {
    writeJsonFile(nodesIndexPath(this.root), entries);
    writeJsonFile(childrenIndexPath(this.root), childrenIndex(index));
    writeJsonFile(tipsIndexPath(this.root), tips(index));
  }

  /** Read the derived cache, or null when it was never written or was deleted. */
  readNodeIndex(): Record<string, NodeIndexEntry> | null {
    const path = nodesIndexPath(this.root);
    if (!existsSync(path)) return null;
    return readJsonFile(path) as Record<string, NodeIndexEntry>;
  }

  /** The directory one node lives in. `petri show` prints it. */
  dirOf(id: string): string {
    return nodeDir(id, this.root);
  }
}

export const openStore = (root: string = REPO_ROOT): PetriStore => new PetriStore(root);
