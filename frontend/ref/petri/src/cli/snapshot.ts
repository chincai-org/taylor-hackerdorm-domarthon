/**
 * Harness snapshots on disk, as the CLI sees them.
 *
 * A snapshot key carries the `harness/` prefix, because §12.1 classifies areas
 * by paths such as `harness/prompt.ts` and §13.2 accepts proposal paths matching
 * `^harness/[a-z0-9_-]+\.ts$`. A directory read returns paths relative to that
 * directory, so the prefix is added here and stripped again on write.
 *
 * The bytes are read and written by `src/store/snapshot.ts`. This file only
 * renames.
 */
import type { HarnessSnapshot } from '../core/schema.js';
import type { ChangedFile } from '../flatten/areas.js';
import { readSnapshot, writeSnapshot } from '../store/snapshot.js';

export const HARNESS_PREFIX = 'harness/';

export function readHarness(dir: string, prefix: string = HARNESS_PREFIX): HarnessSnapshot {
  const raw = readSnapshot(dir);
  const out: Record<string, string> = {};
  for (const [path, contents] of Object.entries(raw)) {
    out[path.startsWith(prefix) ? path : `${prefix}${path}`] = contents;
  }
  return out;
}

export function writeHarness(
  dir: string,
  snap: HarnessSnapshot,
  prefix: string = HARNESS_PREFIX,
): void {
  const out: Record<string, string> = {};
  for (const [path, contents] of Object.entries(snap)) {
    out[path.startsWith(prefix) ? path.slice(prefix.length) : path] = contents;
  }
  writeSnapshot(dir, out);
}

const lines = (text: string): string[] => text.split('\n');

/**
 * A deterministic line-level change set, for the area classifier.
 * It is not a minimal edit script. §12.1 weights by line count only.
 */
export function changedFiles(before: HarnessSnapshot, after: HarnessSnapshot): ChangedFile[] {
  const paths = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  const changed: ChangedFile[] = [];
  for (const path of paths) {
    const a = before[path];
    const b = after[path];
    if (a === b) continue;
    const beforeLines = a === undefined ? [] : lines(a);
    const afterLines = b === undefined ? [] : lines(b);
    const beforeSet = new Set(beforeLines);
    const afterSet = new Set(afterLines);
    changed.push({
      path,
      addedLines: afterLines.filter((l) => !beforeSet.has(l)),
      removedLines: beforeLines.filter((l) => !afterSet.has(l)),
    });
  }
  return changed;
}

/** Total changed lines, for the 120-line patch cap of §13.3. */
export function changedLineCount(changed: readonly ChangedFile[]): number {
  return changed.reduce((n, c) => n + c.addedLines.length + c.removedLines.length, 0);
}
