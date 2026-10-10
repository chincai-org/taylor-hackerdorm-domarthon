/**
 * The unified diff between two harness snapshots. DISPLAY ONLY.
 *
 * This text is NEVER hashed and it is never inside a node id. A diff depends on
 * the algorithm and the context-line count, so hashing it would make the node id
 * implementation-dependent. The node manifest commits to `harness` and `detail`
 * instead, and the diff is fully derivable from two content-addressed snapshots.
 * See SPEC.md section 8.3 and fsck check 8.
 *
 * The algorithm is Myers, so the output is deterministic on every machine.
 * src/evolve/diff.ts re-exports `unifiedDiff` at the path the spec names.
 */
import { byteCompare } from './canonical.js';
import type { ChangedFile, HarnessSnapshot } from './schema.js';

export const DEFAULT_CONTEXT_LINES = 3;

/**
 * Above this edit distance the file is treated as a rewrite: every old line is
 * removed and every new line is added. Myers is O(ND), and a huge D on a pair of
 * unrelated files buys nothing a reader can use.
 */
export const MAX_EDIT_DISTANCE = 4096;

export interface UnifiedDiffOptions {
  /** Context lines around each hunk. Default 3. */
  context?: number;
}

/** A context line, a removal, or an addition. The three unified-diff markers. */
export type Op = ' ' | '-' | '+';
export interface Edit { op: Op; text: string }

/* ------------------------------------------------------------------ *
 * Line handling
 * ------------------------------------------------------------------ */

export interface Lines { lines: string[]; endsWithNewline: boolean }

/** Split text into lines. A trailing newline is recorded, not kept as a line. */
export function splitLines(text: string): Lines {
  if (text === '') return { lines: [], endsWithNewline: true };
  const endsWithNewline = text.endsWith('\n');
  const body = endsWithNewline ? text.slice(0, -1) : text;
  return { lines: body.split('\n'), endsWithNewline };
}

/* ------------------------------------------------------------------ *
 * Myers diff over lines
 * ------------------------------------------------------------------ */

function rewriteEdits(a: readonly string[], b: readonly string[]): Edit[] {
  const out: Edit[] = [];
  for (const text of a) out.push({ op: '-', text });
  for (const text of b) out.push({ op: '+', text });
  return out;
}

/**
 * The shortest edit script between two line arrays.
 * Ties break the same way on every machine, because the search order is fixed.
 */
export function diffLines(a: readonly string[], b: readonly string[]): Edit[] {
  const n = a.length;
  const m = b.length;
  if (n === 0 && m === 0) return [];
  if (n === 0) return b.map((text) => ({ op: '+' as const, text }));
  if (m === 0) return a.map((text) => ({ op: '-' as const, text }));

  const max = Math.min(n + m, MAX_EDIT_DISTANCE);
  const offset = max;
  const v = new Int32Array(2 * max + 1);
  const trace: Int32Array[] = [];

  let found = false;
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)) {
        x = v[offset + k + 1]!;
      } else {
        x = v[offset + k - 1]! + 1;
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[offset + k] = x;
      if (x >= n && y >= m) { found = true; break; }
    }
    if (found) break;
  }
  if (!found) return rewriteEdits(a, b);

  // Walk the trace backwards, then reverse. Every step is forced, so the script
  // is unique for a given trace.
  const reversed: Edit[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const vd = trace[d]!;
    const k = x - y;
    let prevK: number;
    if (k === -d || (k !== d && vd[offset + k - 1]! < vd[offset + k + 1]!)) {
      prevK = k + 1;
    } else {
      prevK = k - 1;
    }
    const prevX = d === 0 ? 0 : vd[offset + prevK]!;
    const prevY = prevX - prevK;

    while (x > prevX && y > prevY) {
      reversed.push({ op: ' ', text: a[x - 1]! });
      x--; y--;
    }
    if (d > 0) {
      if (x === prevX) {
        reversed.push({ op: '+', text: b[prevY]! });
      } else {
        reversed.push({ op: '-', text: a[prevX]! });
      }
      x = prevX;
      y = prevY;
    }
  }
  reversed.reverse();
  return reversed;
}

/* ------------------------------------------------------------------ *
 * Hunks
 * ------------------------------------------------------------------ */

interface Numbered { edit: Edit; oldNo: number; newNo: number }

function number(edits: readonly Edit[]): Numbered[] {
  const out: Numbered[] = [];
  let oldLine = 1;
  let newLine = 1;
  for (const edit of edits) {
    out.push({ edit, oldNo: oldLine, newNo: newLine });
    if (edit.op === ' ') { oldLine++; newLine++; }
    else if (edit.op === '-') { oldLine++; }
    else { newLine++; }
  }
  return out;
}

interface Range { start: number; end: number }

function hunkRanges(items: readonly Numbered[], context: number): Range[] {
  const ranges: Range[] = [];
  for (let i = 0; i < items.length; i++) {
    if (items[i]!.edit.op === ' ') continue;
    const start = Math.max(0, i - context);
    const end = Math.min(items.length - 1, i + context);
    const last = ranges[ranges.length - 1];
    if (last !== undefined && start <= last.end + 1) {
      last.end = Math.max(last.end, end);
    } else {
      ranges.push({ start, end });
    }
  }
  return ranges;
}

/* ------------------------------------------------------------------ *
 * One file
 * ------------------------------------------------------------------ */

const NO_NEWLINE = '\\ No newline at end of file';

/**
 * The unified diff of one file. `before` or `after` may be null, which renders
 * /dev/null on that side.
 */
export function unifiedDiffFile(
  path: string,
  before: string | null,
  after: string | null,
  context: number = DEFAULT_CONTEXT_LINES,
): string {
  if (before === after) return '';
  const oldSide = splitLines(before ?? '');
  const newSide = splitLines(after ?? '');
  const edits = diffLines(oldSide.lines, newSide.lines);

  // One side ends with a newline and the other does not, but the final line
  // reads the same. Split that context line, so the two terminators are visible.
  const last = edits[edits.length - 1];
  if (oldSide.endsWithNewline !== newSide.endsWithNewline
      && last !== undefined && last.op === ' ') {
    edits.pop();
    edits.push({ op: '-', text: last.text }, { op: '+', text: last.text });
  }

  if (edits.every((e) => e.op === ' ')) return '';

  const out: string[] = [];
  out.push(before === null ? '--- /dev/null' : `--- a/${path}`);
  out.push(after === null ? '+++ /dev/null' : `+++ b/${path}`);

  const items = number(edits);
  for (const range of hunkRanges(items, context)) {
    const slice = items.slice(range.start, range.end + 1);
    let oldCount = 0;
    let newCount = 0;
    for (const it of slice) {
      if (it.edit.op !== '+') oldCount++;
      if (it.edit.op !== '-') newCount++;
    }
    const first = slice[0]!;
    const oldStart = oldCount === 0 ? first.oldNo - 1 : first.oldNo;
    const newStart = newCount === 0 ? first.newNo - 1 : first.newNo;
    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);

    for (const it of slice) {
      out.push(`${it.edit.op}${it.edit.text}`);
      const lastOld = it.edit.op !== '+' && it.oldNo === oldSide.lines.length;
      const lastNew = it.edit.op !== '-' && it.newNo === newSide.lines.length;
      const missingOld = lastOld && !oldSide.endsWithNewline;
      const missingNew = lastNew && !newSide.endsWithNewline;
      if (missingOld || missingNew) out.push(NO_NEWLINE);
    }
  }
  return `${out.join('\n')}\n`;
}

/* ------------------------------------------------------------------ *
 * Two snapshots
 * ------------------------------------------------------------------ */

/** Every path in either snapshot, in UTF-8 byte order. */
export function unionPaths(before: HarnessSnapshot, after: HarnessSnapshot): string[] {
  const all = new Set<string>([...Object.keys(before), ...Object.keys(after)]);
  return [...all].sort(byteCompare);
}

/**
 * The unified diff between two harness snapshots.
 * Files appear in UTF-8 byte order of the path, so the text is stable.
 */
export function unifiedDiff(
  before: HarnessSnapshot,
  after: HarnessSnapshot,
  options: UnifiedDiffOptions = {},
): string {
  const context = options.context ?? DEFAULT_CONTEXT_LINES;
  if (!Number.isInteger(context) || context < 0) {
    throw new Error(`bad context line count: ${String(context)}`);
  }
  const parts: string[] = [];
  for (const path of unionPaths(before, after)) {
    const a = Object.prototype.hasOwnProperty.call(before, path) ? before[path]! : null;
    const b = Object.prototype.hasOwnProperty.call(after, path) ? after[path]! : null;
    const text = unifiedDiffFile(path, a, b, context);
    if (text !== '') parts.push(text);
  }
  return parts.join('');
}

/**
 * The changed lines per file, for the area classifier of section 12.1.
 * A file that only moved lines still reports both sides, which is correct:
 * the classifier weighs what the author wrote, not the net effect.
 */
export function changedFiles(before: HarnessSnapshot, after: HarnessSnapshot): ChangedFile[] {
  const out: ChangedFile[] = [];
  for (const path of unionPaths(before, after)) {
    const a = Object.prototype.hasOwnProperty.call(before, path) ? before[path]! : null;
    const b = Object.prototype.hasOwnProperty.call(after, path) ? after[path]! : null;
    if (a === b) continue;
    const edits = diffLines(splitLines(a ?? '').lines, splitLines(b ?? '').lines);
    const addedLines: string[] = [];
    const removedLines: string[] = [];
    for (const e of edits) {
      if (e.op === '+') addedLines.push(e.text);
      else if (e.op === '-') removedLines.push(e.text);
    }
    if (addedLines.length === 0 && removedLines.length === 0) continue;
    out.push({ path, addedLines, removedLines });
  }
  return out;
}

/** The number of changed lines in a patch. The 120-line guard of section 13.3 reads this. */
export function changedLineCount(before: HarnessSnapshot, after: HarnessSnapshot): number {
  let n = 0;
  for (const f of changedFiles(before, after)) n += f.addedLines.length + f.removedLines.length;
  return n;
}
