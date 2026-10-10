/**
 * Read a directory into a HarnessSnapshot, and write one back out.
 * See SPEC.md section 3.2.
 *
 * A snapshot maps a relative POSIX path to UTF-8 file content. Every rule below
 * exists because breaking it makes one tree hash to two values on two machines.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { integrityError, notFoundError, usageError } from '../core/errors.js';
import type { HarnessSnapshot } from '../core/schema.js';

/** A path is at most 512 UTF-8 bytes. */
export const MAX_PATH_BYTES = 512;

/** No segment of a snapshot path may be one of these. */
export const EXCLUDED_SEGMENTS: ReadonlySet<string> = new Set([
  '.git', '.petri', 'node_modules', 'dist',
]);

/**
 * Check one snapshot path and return it in Unicode NFC.
 *
 * macOS hands back NFD file names and Linux hands back NFC. Without this step
 * the same tree hashes to two different harness ids on two machines.
 */
export function normaliseSnapshotPath(path: string): string {
  if (path.length === 0) throw usageError('petri: a snapshot path may not be empty.');
  if (path.includes('\\')) {
    throw usageError(`petri: snapshot path "${path}" uses a backslash. Use "/".`);
  }
  if (path.startsWith('/')) {
    throw usageError(`petri: snapshot path "${path}" is absolute. It must be relative.`);
  }
  if (path.startsWith('./')) {
    throw usageError(`petri: snapshot path "${path}" starts with "./". Drop the prefix.`);
  }
  if (path.includes('\0')) {
    throw usageError(`petri: snapshot path "${path}" contains a NUL byte.`);
  }

  const normalised = path.normalize('NFC');
  const bytes = Buffer.byteLength(normalised, 'utf8');
  if (bytes > MAX_PATH_BYTES) {
    throw usageError(
      `petri: snapshot path "${normalised}" is ${bytes} UTF-8 bytes. The limit is ${MAX_PATH_BYTES}.`,
    );
  }

  for (const segment of normalised.split('/')) {
    if (segment === '') {
      throw usageError(`petri: snapshot path "${normalised}" has an empty segment.`);
    }
    if (segment === '.' || segment === '..') {
      throw usageError(`petri: snapshot path "${normalised}" contains a "${segment}" segment.`);
    }
    if (EXCLUDED_SEGMENTS.has(segment)) {
      throw usageError(`petri: snapshot path "${normalised}" contains the segment "${segment}".`);
    }
  }
  return normalised;
}

/**
 * Check one file's content.
 *
 * Binary is rejected, so a human can `cat` every object. A carriage return is
 * rejected because a Windows checkout rewrites "\n" to "\r\n", which changes
 * the hash in silence. Petri refuses the file instead, and names the path.
 */
export function assertSnapshotContent(path: string, content: string): void {
  if (content.includes('\r')) {
    throw usageError(
      `petri: ${path} contains a carriage return. A CRLF checkout changes the harness id `
      + 'in silence, so Petri refuses the file. Convert it to LF line endings.',
    );
  }
}

function decodeUtf8(path: string, bytes: Buffer): string {
  const text = bytes.toString('utf8');
  if (Buffer.compare(Buffer.from(text, 'utf8'), bytes) !== 0) {
    throw usageError(`petri: ${path} is not valid UTF-8. A harness snapshot holds text only.`);
  }
  return text;
}

/** Validate a path-to-content map that some other source produced. */
export function snapshotFrom(entries: Readonly<Record<string, string>>): HarnessSnapshot {
  const out: Record<string, string> = {};
  for (const rawPath of Object.keys(entries)) {
    const path = normaliseSnapshotPath(rawPath);
    if (Object.prototype.hasOwnProperty.call(out, path)) {
      throw integrityError(
        `petri: two snapshot entries normalise to the same path "${path}". `
        + 'One of them is in NFD form.',
      );
    }
    const content = entries[rawPath]!;
    assertSnapshotContent(path, content);
    out[path] = content;
  }
  return out;
}

function walkDir(dir: string, prefix: string, out: Record<string, string>): void {
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (EXCLUDED_SEGMENTS.has(entry.name)) continue;
    const abs = join(dir, entry.name);
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      walkDir(abs, rel, out);
      continue;
    }
    // A symlink, a socket or a device is not a source file. Skip it in silence,
    // so a stray editor artefact never changes a harness id.
    if (!entry.isFile()) continue;
    const path = normaliseSnapshotPath(rel);
    const content = decodeUtf8(path, readFileSync(abs));
    assertSnapshotContent(path, content);
    out[path] = content;
  }
}

/**
 * Read a directory tree into a snapshot.
 * Paths are relative to `dir` and use "/" on every platform.
 */
export function readSnapshot(dir: string): HarnessSnapshot {
  if (!existsSync(dir)) throw notFoundError(`petri: no directory at ${dir}.`);
  if (!statSync(dir).isDirectory()) throw usageError(`petri: ${dir} is not a directory.`);
  const out: Record<string, string> = {};
  walkDir(dir, '', out);
  return out;
}

export interface WriteSnapshotOptions {
  /** Refuse to overwrite a file that is already there. Default false. */
  failIfExists?: boolean;
}

/**
 * Materialise a snapshot into a directory.
 * It creates parent directories. It never deletes anything.
 */
export function writeSnapshot(
  dir: string,
  snapshot: HarnessSnapshot,
  options: WriteSnapshotOptions = {},
): void {
  const checked = snapshotFrom(snapshot);
  mkdirSync(dir, { recursive: true });
  for (const path of Object.keys(checked).sort()) {
    const abs = join(dir, ...path.split('/'));
    if (options.failIfExists === true && existsSync(abs)) {
      throw usageError(`petri: refusing to overwrite ${abs}.`);
    }
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, checked[path]!, { encoding: 'utf8', mode: 0o644 });
  }
}

/** Turn a platform path into the POSIX form a snapshot key uses. */
export const toPosixPath = (p: string): string => (sep === '/' ? p : p.split(sep).join('/'));
