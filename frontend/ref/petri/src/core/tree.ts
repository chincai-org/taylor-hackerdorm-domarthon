/**
 * Tree operations over the materialised node set.
 *
 * Pure functions. No I/O, no clock, no randomness. They back `petri tree`,
 * `petri tips`, `petri lineage` and `petri dead-ends`, and they build the
 * derived files under `.petri/index/`. Nothing here is ever authoritative:
 * deleting `.petri/index/` loses nothing. See SPEC.md section 7.
 *
 * Rejected branches stay in the tree forever. Design rule 3. No function here
 * removes a node for any reason.
 */
import { sha256Hex } from './canonical.js';
import { byteCompare } from './canonical.js';
import { integrityError, notFoundError } from './errors.js';
import { ROOT, type NodeStatus } from './schema.js';

/** The least a tree operation needs to know about a node. */
export interface TreeNodeView {
  id: string;
  /** A node id, or the literal "root". */
  parent: string;
  status: NodeStatus;
}

export interface TreeIndex {
  /** Every node, keyed by node id. */
  readonly byId: ReadonlyMap<string, TreeNodeView>;
  /** Parent id, or "root", mapped to its child ids in UTF-8 byte order. */
  readonly children: ReadonlyMap<string, readonly string[]>;
  /** The nodes whose parent is "root", in UTF-8 byte order. */
  readonly roots: readonly string[];
  /** A parent id that no node on disk carries. Design rule 3 says this must be empty. */
  readonly missingParents: readonly string[];
}

/**
 * Build the index. Later nodes with a duplicate id are ignored, because the
 * first NodeSubmitted for a node id wins.
 */
export function buildTreeIndex(nodes: Iterable<TreeNodeView>): TreeIndex {
  const byId = new Map<string, TreeNodeView>();
  for (const n of nodes) {
    if (!byId.has(n.id)) byId.set(n.id, n);
  }

  const children = new Map<string, string[]>();
  const missing = new Set<string>();
  for (const n of byId.values()) {
    const bucket = children.get(n.parent);
    if (bucket === undefined) children.set(n.parent, [n.id]);
    else bucket.push(n.id);
    if (n.parent !== ROOT && !byId.has(n.parent)) missing.add(n.parent);
  }
  for (const bucket of children.values()) bucket.sort(byteCompare);

  return {
    byId,
    children,
    roots: children.get(ROOT) ?? [],
    missingParents: [...missing].sort(byteCompare),
  };
}

export const hasNode = (index: TreeIndex, id: string): boolean => index.byId.has(id);

export function nodeOf(index: TreeIndex, id: string): TreeNodeView {
  const n = index.byId.get(id);
  if (n === undefined) throw notFoundError(`petri: no node ${id} in this tree.`);
  return n;
}

/** The direct children of a node, or of "root". Byte order. Never null. */
export function childrenOf(index: TreeIndex, id: string): string[] {
  return [...(index.children.get(id) ?? [])];
}

/**
 * The path from a node up to its root node, node first.
 * The "root" sentinel is not a node, so it never appears in the result.
 */
export function pathToRoot(index: TreeIndex, id: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let cursor = id;
  while (cursor !== ROOT) {
    const node = index.byId.get(cursor);
    if (node === undefined) {
      if (cursor === id) throw notFoundError(`petri: no node ${id} in this tree.`);
      throw integrityError(
        `petri: node ${out[out.length - 1]!} names parent ${cursor}, which is not on disk. `
        + 'Nothing may be deleted from a Petri tree.',
      );
    }
    if (seen.has(cursor)) {
      throw integrityError(`petri: the ancestry of ${id} contains a cycle at ${cursor}.`);
    }
    seen.add(cursor);
    out.push(cursor);
    cursor = node.parent;
  }
  return out;
}

/** The same path, root first. This is what `petri lineage` prints. */
export function lineage(index: TreeIndex, id: string): string[] {
  return pathToRoot(index, id).reverse();
}

/** The depth of a node. A root node has depth 0. */
export const depthOf = (index: TreeIndex, id: string): number => pathToRoot(index, id).length - 1;

/**
 * Every node under `id`, `id` excluded, in a deterministic pre-order walk.
 * Children are visited in UTF-8 byte order of their node id.
 */
export function descendants(index: TreeIndex, id: string): string[] {
  const out: string[] = [];
  const stack = [...childrenOf(index, id)].reverse();
  const seen = new Set<string>([id]);
  while (stack.length > 0) {
    const next = stack.pop()!;
    if (seen.has(next)) {
      throw integrityError(`petri: the subtree of ${id} contains a cycle at ${next}.`);
    }
    seen.add(next);
    out.push(next);
    const kids = childrenOf(index, next);
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]!);
  }
  return out;
}

/** Every node, root first, in the same deterministic pre-order walk. */
export function walk(index: TreeIndex): string[] {
  const out: string[] = [];
  for (const root of index.roots) {
    out.push(root);
    out.push(...descendants(index, root));
  }
  return out;
}

/** A node with no children at all, whatever its status. */
export function leaves(index: TreeIndex): string[] {
  return [...index.byId.keys()]
    .filter((id) => childrenOf(index, id).length === 0)
    .sort(byteCompare);
}

/**
 * The accepted leaves. These are the frontiers worth extending.
 *
 * A node is a tip when it is accepted and no accepted node names it as parent.
 * A pending or rejected child therefore never hides a tip, which is right:
 * a rejected branch must not close the frontier it grew from.
 */
export function tips(index: TreeIndex): string[] {
  const out: string[] = [];
  for (const [id, node] of index.byId) {
    if (node.status !== 'accepted') continue;
    const hasAcceptedChild = childrenOf(index, id)
      .some((c) => index.byId.get(c)?.status === 'accepted');
    if (!hasAcceptedChild) out.push(id);
  }
  return out.sort(byteCompare);
}

/** Every node with a given status, in UTF-8 byte order. `petri dead-ends` reads 'rejected'. */
export function withStatus(index: TreeIndex, status: NodeStatus): string[] {
  return [...index.byId.values()]
    .filter((n) => n.status === status)
    .map((n) => n.id)
    .sort(byteCompare);
}

/**
 * A stable fingerprint of one root-first path.
 *
 * It identifies the exact chain of nodes a tip was built from, so two machines
 * can compare lineages with one short string. It is NOT a content id and it
 * never enters a node id or a signature.
 */
export const lineageDigest = (rootFirstIds: readonly string[]): string =>
  sha256Hex(`petri/lineage/1|${rootFirstIds.join('|')}`);

/** The `children.json` shape of section 7: parent id mapped to its child ids. */
export function childrenIndex(index: TreeIndex): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const key of [...index.children.keys()].sort(byteCompare)) {
    out[key] = [...(index.children.get(key) ?? [])];
  }
  return out;
}
