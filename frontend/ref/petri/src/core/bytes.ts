/**
 * Byte helpers for the harness snapshot digest. See SPEC.md section 3.3.
 * This is the ONLY second serialiser in Petri. It hashes file trees, nothing else.
 */

export const utf8 = (s: string): Buffer => Buffer.from(s, 'utf8');

/**
 * Write one length-prefixed field: `<tag> <byteLength>\n<payload>\n`
 *
 * The length fixes the payload boundary, so the reader never scans for a tag.
 * No payload can therefore imitate a tag line. Without a length prefix,
 * { "ab": "c" } and { "a": "bc" } can serialise to the same bytes, and an author
 * could hide one harness behind another's hash.
 */
export const frame = (tag: string, payload: Buffer): Buffer =>
  Buffer.concat([utf8(`${tag} ${payload.length}\n`), payload, utf8('\n')]);
