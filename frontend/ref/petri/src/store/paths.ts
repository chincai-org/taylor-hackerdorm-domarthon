/**
 * Every path computation under `.petri/`. See SPEC.md section 3.5 and section 7.
 *
 * No other module builds a path under `.petri/` by string concatenation.
 * A content id shards on its first two characters: id a3572a8d…f2a4 lives at
 * objects/a3/572a8d…f2a4.json, and node a3572a8d…f2a4 at nodes/a3/572a8d…f2a4/.
 * A flat directory of 64-character names is slow on some filesystems and the
 * shard costs nothing.
 */
import { join } from 'node:path';
import { integrityError } from '../core/errors.js';
import { REPO_ROOT } from '../core/root.js';

/**
 * The repo root that holds `.petri/`. The `--root` flag overrides it.
 * It is derived in src/core/root.ts, so no path here names one machine.
 */
export { REPO_ROOT };
export const PETRI_DIRNAME = '.petri';

const HEX64_RE = /^[0-9a-f]{64}$/;

/** One regex validates every id in the system. Section 1.1. */
export function assertHex64(id: string, what = 'id'): string {
  if (!HEX64_RE.test(id)) {
    throw integrityError(`petri: ${what} "${id}" is not 64 lowercase hex characters.`);
  }
  return id;
}

export interface Shard { aa: string; rest: string }

export function shardOf(id: string, what = 'id'): Shard {
  assertHex64(id, what);
  return { aa: id.slice(0, 2), rest: id.slice(2) };
}

export const petriDir = (root: string = REPO_ROOT): string => join(root, PETRI_DIRNAME);

export const configPath = (root: string = REPO_ROOT): string => join(petriDir(root), 'config.json');

/**
 * The private key of this runner.
 *
 * `PETRI_HOME` moves this ONE file, and nothing else. Set it to give a second
 * process on this machine a second identity against the SAME tree. That is how a
 * multi-machine protocol is demonstrated on one box: two runners, two keys, one
 * shared log. The tree, the objects and the log stay under `--root`.
 *
 * This is the only environment variable that changes a path under `.petri/`.
 */
export const identityPath = (root: string = REPO_ROOT): string => {
  const home = process.env['PETRI_HOME'];
  if (home !== undefined && home.trim() !== '') return join(home, 'identity.json');
  return join(petriDir(root), 'identity.json');
};
export const logPath = (root: string = REPO_ROOT): string => join(petriDir(root), 'log.jsonl');
export const lockPath = (root: string = REPO_ROOT): string => join(petriDir(root), 'log.lock');
export const cursorPath = (root: string = REPO_ROOT): string => join(petriDir(root), 'cursor.json');

/** The Hedera topic that holds a copy of every log line. See src/consensus/anchor.ts. */
export const anchorConfigPath = (root: string = REPO_ROOT): string => join(petriDir(root), 'anchor.json');
/** One receipt per line that reached the Hedera topic. */
export const anchorsPath = (root: string = REPO_ROOT): string => join(petriDir(root), 'anchors.jsonl');
/** Consensus time and running hash per topic message, read back from the mirror node. Derived. */
export const anchorTimesPath = (root: string = REPO_ROOT): string => join(petriDir(root), 'anchor-times.json');
/** One World ID check per verification, written only when the check is on. */
export const worldChecksPath = (root: string = REPO_ROOT): string =>
  join(petriDir(root), 'world-checks.jsonl');
export const mirrorCachePath = (root: string = REPO_ROOT): string =>
  join(petriDir(root), 'mirror-cache.jsonl');

/* ---------------------------------------------------------------- objects */

export const objectsDir = (root: string = REPO_ROOT): string => join(petriDir(root), 'objects');

export function objectPath(id: string, root: string = REPO_ROOT): string {
  const { aa, rest } = shardOf(id, 'object id');
  return join(objectsDir(root), aa, `${rest}.json`);
}

/* ------------------------------------------------------------------ nodes */

export const nodesDir = (root: string = REPO_ROOT): string => join(petriDir(root), 'nodes');

export function nodeDir(id: string, root: string = REPO_ROOT): string {
  const { aa, rest } = shardOf(id, 'node id');
  return join(nodesDir(root), aa, rest);
}

export const manifestPath = (id: string, root: string = REPO_ROOT): string =>
  join(nodeDir(id, root), 'manifest.json');
export const envelopePath = (id: string, root: string = REPO_ROOT): string =>
  join(nodeDir(id, root), 'envelope.json');
export const diffPath = (id: string, root: string = REPO_ROOT): string =>
  join(nodeDir(id, root), 'diff.patch');
export const verificationsDir = (id: string, root: string = REPO_ROOT): string =>
  join(nodeDir(id, root), 'verifications');

export function verificationPath(
  nodeId: string, reportId: string, root: string = REPO_ROOT,
): string {
  assertHex64(reportId, 'report id');
  return join(verificationsDir(nodeId, root), `${reportId}.json`);
}

/* ------------------------------------------------------------------ index */

/** Everything under index/ is DERIVED. Deleting it loses nothing. */
export const indexDir = (root: string = REPO_ROOT): string => join(petriDir(root), 'index');
export const nodesIndexPath = (root: string = REPO_ROOT): string => join(indexDir(root), 'nodes.json');
export const childrenIndexPath = (root: string = REPO_ROOT): string =>
  join(indexDir(root), 'children.json');
export const tipsIndexPath = (root: string = REPO_ROOT): string => join(indexDir(root), 'tips.json');

/* ---------------------------------------------------------------- scratch */

const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

function assertRunId(runId: string): string {
  if (!RUN_ID_RE.test(runId)) throw integrityError(`petri: bad run id "${runId}".`);
  return runId;
}

export const scratchRoot = (root: string = REPO_ROOT): string => join(petriDir(root), 'scratch');
export const scratchDir = (runId: string, root: string = REPO_ROOT): string =>
  join(scratchRoot(root), assertRunId(runId));
export const scratchHarnessDir = (runId: string, root: string = REPO_ROOT): string =>
  join(scratchDir(runId, root), 'harness');
export const scratchTsconfigPath = (runId: string, root: string = REPO_ROOT): string =>
  join(scratchDir(runId, root), 'tsconfig.json');
export const scratchProposalPath = (runId: string, root: string = REPO_ROOT): string =>
  join(scratchDir(runId, root), 'proposal.json');

/**
 * Where a stored harness snapshot is materialised so it can be imported and run.
 * It is keyed by the harness id, so the same snapshot is written once and two
 * measurements of one harness share the directory. `harness/` hangs off it.
 */
export const scratchHarnessRoot = (harnessId: string, root: string = REPO_ROOT): string =>
  join(scratchRoot(root), 'harness', assertHex64(harnessId, 'harness id'));
