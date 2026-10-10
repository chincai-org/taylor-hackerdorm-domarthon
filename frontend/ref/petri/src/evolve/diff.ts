/**
 * Unified diff between two snapshots. Display only. See SPEC.md section 15.
 *
 * The algorithm lives in src/core/diff.ts, because src/core/ sits at the bottom
 * of the import graph and the node store needs the same function to regenerate
 * `diff.patch` for fsck check 8. This file is the import path the spec names.
 */
export {
  DEFAULT_CONTEXT_LINES,
  MAX_EDIT_DISTANCE,
  changedFiles,
  changedLineCount,
  diffLines,
  splitLines,
  unifiedDiff,
  unifiedDiffFile,
  unionPaths,
} from '../core/diff.js';
export type { Edit, Lines, Op, UnifiedDiffOptions } from '../core/diff.js';
