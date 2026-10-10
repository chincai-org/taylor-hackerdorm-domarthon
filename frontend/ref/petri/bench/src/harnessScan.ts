/**
 * The harness source scan. SPEC.md §11.1 rule 3 and §13.3.
 *
 * READ THIS FIRST: this file is NOT the boundary. It is a tripwire.
 *
 * A regex over source text can always be defeated, because the text that runs is
 * not the text that was scanned: a string can be assembled at run time, and the
 * Function constructor can be reached through any object's prototype chain. The
 * boundary that actually stops a harness from reading the tests is the child
 * process in `harnessJail.ts`, which runs under `--permission` with one read grant
 * over a directory the tests are not in.
 *
 * The scan stays for two reasons. It names the intent in plain English, so an
 * honest proposer is told what is out of bounds before it wastes a measurement.
 * And it is a second lock: defeating it AND the permission model takes two
 * unrelated breaks, not one.
 *
 * Scope. `scanHarnessSnapshot` scans the COMPLETE snapshot, every time. The older
 * scan ran over the changed files of one proposal, so a file inherited from a
 * parent was never looked at again, and the genesis snapshot was never looked at
 * at all. A tree could therefore start with a bad file and every descendant
 * inherited it unchecked.
 *
 * Layer L3. It imports L0 (`src/core/*`) and nothing else. `src/evolve/guards.ts`
 * sits at L4 and imports this file, so the rule has exactly one implementation.
 */
import type { HarnessSnapshot } from '../../src/core/schema.js';

/** Every harness path starts here. */
export const HARNESS_PREFIX = 'harness/';
/** SPEC.md §11.1 rule 1. The frozen entry point lives here. */
export const ENTRY_FILE = 'harness/index.ts';
/** SPEC.md §11.1 rule 2. This file is frozen, byte for byte, in every node. */
export const CONTRACT_FILE = 'harness/contract.ts';

/** A harness path, as SPEC.md §13.2 writes it. Flat, lower case, TypeScript. */
export const HARNESS_PATH_RE = /^harness\/[a-z0-9_-]+\.ts$/;

/** An `import … from '…'` specifier. */
const IMPORT_RE = /^\s*import\s+(?:type\s+)?[^'"]*from\s+['"]([^'"]+)['"]/gm;
/** An `export … from '…'` specifier. It is an import channel too. */
const EXPORT_FROM_RE = /^\s*export\s+(?:type\s+)?[^'"]*from\s+['"]([^'"]+)['"]/gm;
/** The only shape a harness specifier may take: a relative sibling. §11.1 rule 3. */
const SIBLING_RE = /^\.\/[a-z0-9_-]+\.js$/;

/** One banned construct, with the English reason the proposer is shown. */
export interface BannedConstruct {
  readonly re: RegExp;
  readonly what: string;
}

/**
 * The banned constructs.
 *
 * Each one is a way to reach the host from inside a harness file. The list grew
 * after an audit drove a real read of `test.mjs` through the AsyncFunction
 * constructor, which the first list did not name: it banned `new Function(` only,
 * and `Object.getPrototypeOf(async function () {}).constructor` is neither of
 * those words.
 */
export const BANNED: readonly BannedConstruct[] = Object.freeze([
  { re: /\brequire\b/, what: 'require' },
  { re: /\bimport\s*\(/, what: 'a dynamic import()' },
  { re: /\bimport\s*\.\s*meta\b/, what: 'import.meta' },
  { re: /\beval\s*\(/, what: 'eval()' },
  // `new Function(`, `Function(`, `AsyncFunction(`, `GeneratorFunction(` and the
  // async generator constructor. The word boundary sits before the whole group, so
  // an ordinary name such as `formatFunction(` does not match.
  {
    re: /\b(?:new\s+)?(?:Async|Generator|AsyncGenerator)?Function\s*\(/,
    what: 'a Function constructor',
  },
  // The prototype-chain route to those constructors.
  { re: /\.\s*constructor\b/, what: 'a .constructor lookup' },
  { re: /\[\s*(['"`])constructor\1\s*\]/, what: 'a ["constructor"] lookup' },
  { re: /\bgetPrototypeOf\b|\bsetPrototypeOf\b|__proto__/, what: 'a prototype walk' },
  { re: /\bReflect\s*\./, what: 'Reflect' },
  { re: /\bprocess\s*[.[]/, what: 'process' },
  { re: /\bglobalThis\b/, what: 'globalThis' },
  { re: /\bnode:[a-z]/, what: 'a node builtin specifier' },
  { re: /\breadFileSync\b|\breadFile\s*\(|\bcreateRequire\b/, what: 'a file read' },
  { re: /\bchild_process\b|\bworker_threads\b/, what: 'a second process' },
]);

/**
 * A harness file may import only relative siblings inside `harness/`, and it may
 * not name any construct on the banned list. SPEC.md §11.1 rule 3.
 *
 * It returns a plain English reason, or null when the file is clean.
 */
export function checkSandbox(path: string, contents: string): string | null {
  for (const banned of BANNED) {
    if (banned.re.test(contents)) return `banned construct in ${path}: ${banned.what}`;
  }
  for (const re of [IMPORT_RE, EXPORT_FROM_RE]) {
    // A global regex carries lastIndex between calls. Reset it, or every second
    // call over the same text starts half way through and misses a violation.
    re.lastIndex = 0;
    for (const m of contents.matchAll(re)) {
      const spec = m[1]!;
      if (!SIBLING_RE.test(spec)) return `illegal import "${spec}" in ${path}`;
    }
  }
  return null;
}

/** The shape of a harness path. It says nothing about which files may change. */
export function checkHarnessPathShape(path: string): string | null {
  if (!path.startsWith(HARNESS_PREFIX)) {
    return `path "${path}" is outside ${HARNESS_PREFIX}`;
  }
  if (!HARNESS_PATH_RE.test(path)) {
    return `path "${path}" is not a harness TypeScript file`;
  }
  return null;
}

/** One scan failure: the file that failed, and why. */
export interface ScanFailure {
  readonly path: string;
  readonly message: string;
}

/**
 * Scan a COMPLETE harness snapshot. Every file, every time.
 *
 * Paths are walked in sorted order, so the same snapshot always reports the same
 * first failure on every machine.
 */
export function scanHarnessSnapshot(snapshot: HarnessSnapshot): ScanFailure | null {
  const paths = Object.keys(snapshot).sort();
  for (const path of paths) {
    const shape = checkHarnessPathShape(path);
    if (shape !== null) return { path, message: shape };
  }
  for (const path of paths) {
    const bad = checkSandbox(path, snapshot[path]!);
    if (bad !== null) return { path, message: bad };
  }
  return null;
}
