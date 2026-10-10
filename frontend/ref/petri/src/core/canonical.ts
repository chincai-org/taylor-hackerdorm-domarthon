/**
 * THE canonical serialiser. See SPEC.md section 2.
 *
 * This file produces the bytes that are hashed AND the bytes that are signed.
 * There is exactly one such function in Petri. Do not write a second one.
 *
 * Disk files are pretty-printed and are NEVER hashed. Every hash is recomputed
 * from the parsed value through canonicalJson. See src/store/json.ts.
 */
import { createHash } from 'node:crypto';

/** The only value shapes a hashed or signed Petri payload may contain. */
export type Canon = string | number | boolean | Canon[] | { [k: string]: Canon };

export class CanonError extends Error {
  constructor(message: string) {
    super(`canonical: ${message}`);
    this.name = 'CanonError';
  }
}

/**
 * Object keys are restricted to ASCII lowerCamelCase.
 * For this character set, UTF-8 byte order, Unicode code-point order and UTF-16
 * code-unit order are the same order. A port to Python, Go or Rust cannot disagree.
 */
const KEY_RE = /^[a-z][A-Za-z0-9]*$/;

/**
 * Compare two strings by their UTF-8 bytes.
 * KEY_RE already makes this equal to the default sort. We still sort by bytes.
 * If a later version widens KEY_RE, the sort order must not silently change.
 */
export function byteCompare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/** Reject lone surrogates. They are the one place JSON writers emit different bytes. */
function assertWellFormed(s: string, path: string): void {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new CanonError(`lone high surrogate at ${path}[${i}]`);
      }
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      throw new CanonError(`lone low surrogate at ${path}[${i}]`);
    }
  }
}

function enc(v: unknown, path: string): string {
  const t = typeof v;

  if (t === 'string') {
    assertWellFormed(v as string, path);
    // ECMA-262 QuoteJSONString is fully specified. Every engine agrees on these bytes.
    return JSON.stringify(v);
  }

  if (t === 'boolean') return v === true ? 'true' : 'false';

  if (t === 'number') {
    const n = v as number;
    if (!Number.isInteger(n)) throw new CanonError(`non-integer number at ${path}`);
    if (!Number.isSafeInteger(n)) throw new CanonError(`unsafe integer at ${path}`);
    return String(n === 0 ? 0 : n); // maps -0 to "0"
  }

  if (Array.isArray(v)) {
    return '[' + v.map((x, i) => enc(x, `${path}[${i}]`)).join(',') + ']';
  }

  if (v !== null && t === 'object') {
    const proto = Object.getPrototypeOf(v) as object | null;
    if (proto !== Object.prototype && proto !== null) {
      throw new CanonError(`not a plain object at ${path}`);
    }
    const keys = Object.keys(v as object).sort(byteCompare);
    const parts: string[] = [];
    for (const k of keys) {
      if (!KEY_RE.test(k)) throw new CanonError(`illegal key ${JSON.stringify(k)} at ${path}`);
      const child = (v as Record<string, unknown>)[k];
      if (child === undefined) throw new CanonError(`undefined value at ${path}.${k}`);
      if (child === null) throw new CanonError(`null value at ${path}.${k}`);
      // KEY_RE guarantees no escape is needed. The quoted key equals JSON.stringify(k).
      parts.push(`"${k}":` + enc(child, `${path}.${k}`));
    }
    return '{' + parts.join(',') + '}';
  }

  throw new CanonError(`unsupported ${v === null ? 'null' : t} at ${path}`);
}

/** RFC 8785 (JCS), restricted: integers only, no null, no floats, ASCII keys. */
export function canonicalJson(value: Canon): string {
  return enc(value, '$');
}

export function canonicalBytes(value: Canon): Buffer {
  return Buffer.from(canonicalJson(value), 'utf8');
}

export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256')
    .update(typeof data === 'string' ? Buffer.from(data, 'utf8') : data)
    .digest('hex');
}

/** The content id of any canonical value. This is how every id in Petri is made. */
export function contentId(value: Canon): string {
  return sha256Hex(canonicalBytes(value));
}
