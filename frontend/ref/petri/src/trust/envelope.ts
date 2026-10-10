/**
 * Domain-separated signing. SPEC.md section 5.2.
 *
 * One key signs both consensus messages and verification reports. Without a
 * prefix, an attacker could replay a signature from one context into the other.
 *
 * These are the ONLY bytes an ed25519 key ever signs. The body is serialised by
 * `canonicalBytes` from src/core/canonical.ts. There is no second serialiser.
 */

import { canonicalBytes, type Canon } from '../core/canonical.js';
import { HEX128_RE, HEX64_RE, verifyDetached, type Identity } from './identity.js';

export type Domain = 'msg' | 'report';

/** The exact bytes an ed25519 key signs. Nothing else is ever signed. */
export function signingBytes(domain: Domain, body: Canon): Buffer {
  return Buffer.concat([Buffer.from(`petri/v1/${domain}\n`, 'utf8'), canonicalBytes(body)]);
}

/**
 * Declared as a type alias, not an interface, on purpose.
 * An envelope is canonicalised (it goes inside a log line), so it must satisfy
 * `Canon`. TypeScript gives an implicit index signature to an object type alias
 * and NOT to an interface, so an interface here would fail `B extends Canon`.
 *
 *
 * The key order after sorting is `body, pub, sig, ver`. That is the wire order.
 */
export type SignedEnvelope<B extends Canon = Canon> = {
  body: B;
  pub: string;   // Hex64. The signer public key.
  sig: string;   // 128 hex. The 64-byte signature.
  ver: 1;
};

export function seal<B extends Canon>(domain: Domain, body: B, id: Identity): SignedEnvelope<B> {
  return { body, pub: id.publicKeyHex, sig: id.sign(signingBytes(domain, body)).toString('hex'), ver: 1 };
}

export type OpenResult<B> = { ok: true; body: B; pub: string } | { ok: false; reason: string };

/** Check the envelope shape, then the signature. Never throw on bad input. */
export function openEnvelope<B extends Canon>(domain: Domain, value: unknown): OpenResult<B> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, reason: 'not an object' };
  }
  const e = value as Partial<SignedEnvelope>;
  if (e.ver !== 1) return { ok: false, reason: `unsupported envelope version ${String(e.ver)}` };
  if (typeof e.pub !== 'string' || !HEX64_RE.test(e.pub)) return { ok: false, reason: 'bad pub' };
  if (typeof e.sig !== 'string' || !HEX128_RE.test(e.sig)) return { ok: false, reason: 'bad sig' };
  if (e.body === null || typeof e.body !== 'object' || Array.isArray(e.body)) {
    return { ok: false, reason: 'bad body' };
  }
  let bytes: Buffer;
  try { bytes = signingBytes(domain, e.body as Canon); }
  catch (err) { return { ok: false, reason: `body not canonical: ${(err as Error).message}` }; }
  if (!verifyDetached(e.pub, bytes, e.sig)) return { ok: false, reason: 'signature check failed' };
  return { ok: true, body: e.body as B, pub: e.pub };
}
