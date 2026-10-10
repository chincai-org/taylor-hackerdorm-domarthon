/**
 * The pretty writer. See SPEC.md section 2.3.
 *
 * Files under `.petri/` are written pretty-printed, with two-space indent and a
 * trailing newline, for humans to read. THOSE BYTES ARE NEVER HASHED. Every
 * hash is recomputed from the parsed value through canonicalJson.
 *
 * Re-indenting a file can therefore never change an id. The cost is that you
 * cannot check an id with `sha256sum somefile.json`. Use `petri fsck` instead.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { byteCompare } from '../core/canonical.js';
import { integrityError, notFoundError } from '../core/errors.js';

function stableOrder(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stableOrder);
  if (v !== null && typeof v === 'object') {
    const src = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src).sort(byteCompare)) out[k] = stableOrder(src[k]);
    return out;
  }
  return v;
}

/** Atomic write. A crash never leaves a half-written record. NEVER hashed. */
export function writeJsonFile(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const text = `${JSON.stringify(stableOrder(value), null, 2)}\n`;
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o644 });
  renameSync(tmp, path);
}

/** Atomic write of plain text, for `diff.patch`. Never hashed either. */
export function writeTextFile(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o644 });
  renameSync(tmp, path);
}

/** Read and parse one JSON file. A missing file and bad JSON are different failures. */
export function readJsonFile(path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw notFoundError(`petri: no file at ${path}.`);
    throw e;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (e) {
    throw integrityError(`petri: ${path} is not valid JSON: ${(e as Error).message}`);
  }
}
