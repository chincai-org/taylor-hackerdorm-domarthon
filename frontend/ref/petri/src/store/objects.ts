/**
 * The content-addressed object store. See SPEC.md section 7.8.
 *
 * Every object in Petri is a canonical JSON value, so the interface takes
 * `Canon` and not `Buffer`: a byte interface would let a caller store bytes
 * whose hash nothing can recompute. Every call is a small local file, so the
 * interface is synchronous; an async boundary here would infect every caller
 * for no gain.
 *
 * Objects live at objects/<aa>/<rest>.json, pretty-printed. The disk bytes are
 * never hashed. `get` re-derives the content id from the parsed value.
 */
import { existsSync } from 'node:fs';
import { contentId, type Canon } from '../core/canonical.js';
import { integrityError, notFoundError } from '../core/errors.js';
import { readJsonFile, writeJsonFile } from './json.js';
import { REPO_ROOT, assertHex64, objectPath } from './paths.js';

export interface ObjectStore {
  /** Store a canonical value. Return its content id. Writing twice is a no-op. */
  put(value: Canon): string;
  /** Read an object by content id. Throw when it is absent or its hash is wrong. */
  get(id: string): Canon;
  has(id: string): boolean;
  /**
   * Store a value at an id that some OTHER rule produced.
   *
   * Two objects are addressed by a rule that is not `contentId` of the stored
   * bytes, and both are documented exceptions:
   *   - a HarnessObject, whose id comes from harnessDigestInput(files);
   *   - a NodeDetail, whose id is taken with the `node` back-reference blanked.
   * Nothing else may use this. Read them back with `getUnder`, then re-derive
   * the id with the matching rule.
   */
  putUnder(id: string, value: Canon): string;
  /** Read an object without the content-id check. The caller re-derives the id. */
  getUnder(id: string): Canon;
}

export class FileObjectStore implements ObjectStore {
  constructor(readonly root: string = REPO_ROOT) {}

  put(value: Canon): string {
    const id = contentId(value);
    const path = objectPath(id, this.root);
    if (!existsSync(path)) writeJsonFile(path, value);
    return id;
  }

  putUnder(id: string, value: Canon): string {
    assertHex64(id, 'object id');
    const path = objectPath(id, this.root);
    if (!existsSync(path)) writeJsonFile(path, value);
    return id;
  }

  get(id: string): Canon {
    const value = this.getUnder(id);
    const actual = contentId(value);
    if (actual !== id) {
      throw integrityError(
        `petri: object ${id} hashes to ${actual}. The stored bytes are not the bytes it names.`,
      );
    }
    return value;
  }

  getUnder(id: string): Canon {
    assertHex64(id, 'object id');
    const path = objectPath(id, this.root);
    if (!existsSync(path)) throw notFoundError(`petri: no object ${id} at ${path}.`);
    return readJsonFile(path) as Canon;
  }

  has(id: string): boolean {
    assertHex64(id, 'object id');
    return existsSync(objectPath(id, this.root));
  }
}

export const openObjectStore = (root: string = REPO_ROOT): ObjectStore => new FileObjectStore(root);
