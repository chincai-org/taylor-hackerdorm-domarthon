/**
 * The repo root. SPEC.md sections 3.5 and 14.2.
 *
 * The root is DERIVED from the location of this file. It is never a literal
 * path. A literal path binds the tool to one machine: a clone in any other
 * directory then reads a config it does not own and appends to a log that
 * belongs to a different tree.
 *
 * The value is the checkout that ships this CLI. `src/core/root.ts` and the
 * compiled `dist/core/root.js` both sit two directories below it, so the same
 * expression works before and after a build.
 *
 * This is a DEFAULT, not a rule. Every command takes `--root <dir>`, and every
 * path helper takes a root argument. Nothing under `.petri/` is ever reached
 * through this constant when the caller named a root.
 *
 * This file sits at layer L0 of section 16, so every layer may import it.
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The directory that holds `.petri/`, `bench/` and `harness/`. */
export const REPO_ROOT: string = resolve(fileURLToPath(new URL('../../', import.meta.url)));
