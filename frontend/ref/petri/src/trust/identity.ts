/**
 * ed25519 identity. SPEC.md section 5.1.
 *
 * The key IS the identity. There is no registry. A runner id is the 32-byte
 * ed25519 public key, written as 64 lowercase hexadecimal characters.
 *
 * The private seed lives in .petri/identity.json at mode 0600. It never leaves
 * this machine. See SPEC.md section 18.6 for what mode 0600 does NOT stop.
 */

import {
  createPrivateKey, createPublicKey, generateKeyPairSync,
  sign as edSign, verify as edVerify, type KeyObject,
} from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { REPO_ROOT } from '../core/root.js';

/**
 * The `.petri/` of the checkout that ships this CLI. Both are fallbacks only.
 * Every command passes `identityPath(--root)` from src/store/paths.ts instead.
 */
export const PETRI_DIR = join(REPO_ROOT, '.petri');
export const IDENTITY_PATH = join(PETRI_DIR, 'identity.json');

/** An ed25519 SPKI is 44 bytes: this 12-byte prefix plus 32 raw bytes. */
export const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
/** An ed25519 PKCS8 is 48 bytes: this 16-byte prefix plus a 32-byte seed. */
export const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export const HEX64_RE = /^[0-9a-f]{64}$/;
export const HEX128_RE = /^[0-9a-f]{128}$/;

export interface IdentityFile {
  algo: 'ed25519';
  createdAt: string;   // ISO 8601. Informational. Never signed.
  label: string;       // A human name for this machine.
  privateKey: string;  // Hex64. The ed25519 seed. It NEVER leaves this machine.
  publicKey: string;   // Hex64.
  runnerId: string;    // Equals publicKey.
  version: 1;
}

export interface Identity {
  readonly runnerId: string;
  readonly publicKeyHex: string;
  readonly label: string;
  sign(message: Buffer): Buffer;   // A 64-byte detached ed25519 signature.
}

const rawPublic = (k: KeyObject): Buffer =>
  Buffer.from((k.export({ format: 'jwk' }) as { x: string }).x, 'base64url');
const rawSeed = (k: KeyObject): Buffer =>
  Buffer.from((k.export({ format: 'jwk' }) as { d: string }).d, 'base64url');

export function publicKeyFromHex(hex: string): KeyObject {
  if (!HEX64_RE.test(hex)) throw new Error(`bad ed25519 public key: ${hex}`);
  return createPublicKey({
    key: Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(hex, 'hex')]),
    format: 'der', type: 'spki',
  });
}

export function privateKeyFromSeedHex(hex: string): KeyObject {
  if (!HEX64_RE.test(hex)) throw new Error('bad ed25519 seed');
  return createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(hex, 'hex')]),
    format: 'der', type: 'pkcs8',
  });
}

/** Create the key pair. Fail if a key file exists. Never overwrite a key. */
export function createIdentity(path = IDENTITY_PATH, label = hostname()): IdentityFile {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pub = rawPublic(publicKey).toString('hex');
  const file: IdentityFile = {
    algo: 'ed25519',
    createdAt: new Date().toISOString(),
    label,
    privateKey: rawSeed(privateKey).toString('hex'),
    publicKey: pub,
    runnerId: pub,
    version: 1,
  };
  try {
    // 'wx' fails when the file exists. This stops an accidental key overwrite.
    writeFileSync(path, JSON.stringify(file, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(
        `petri: an identity already exists at ${path}. Petri never overwrites a key.\n` +
        `Move that file aside if you really want a new one.`,
      );
    }
    throw err;
  }
  chmodSync(path, 0o600); // The umask applies to the mode above. Set it again.
  return file;
}

/** Load the identity. Refuse to run when other users can read the key file. */
export function loadIdentity(path = IDENTITY_PATH): Identity {
  if (!existsSync(path)) {
    throw new Error(`petri: no identity at ${path}. Run \`petri id create\` first.`);
  }
  if (process.platform !== 'win32') {
    const mode = statSync(path).mode & 0o777;
    if ((mode & 0o077) !== 0) {
      throw new Error(
        `petri: ${path} has mode 0${mode.toString(8)}. Other users can read your private key.\n` +
        `Fix it:  chmod 600 ${path}`,
      );
    }
  }
  const file = JSON.parse(readFileSync(path, 'utf8')) as IdentityFile;
  if (file.version !== 1 || file.algo !== 'ed25519') throw new Error('petri: unsupported identity file');
  if (!HEX64_RE.test(file.privateKey) || !HEX64_RE.test(file.publicKey)) {
    throw new Error('petri: malformed identity file');
  }
  const priv = privateKeyFromSeedHex(file.privateKey);
  const derived = rawPublic(createPublicKey(priv)).toString('hex');
  if (derived !== file.publicKey) {
    throw new Error('petri: the public key does not match the private key');
  }
  return {
    runnerId: file.publicKey,
    publicKeyHex: file.publicKey,
    label: file.label,
    sign: (message: Buffer) => edSign(null, message, priv), // ed25519 takes a null algorithm
  };
}

/**
 * Build an Identity straight from a 32-byte seed, with no file.
 * The golden vectors of SPEC.md section 17.1 are built from fixed seeds, and a
 * test that needs a second verifier key takes one from here.
 */
export function identityFromSeedHex(seedHex: string, label = 'ephemeral'): Identity {
  const priv = privateKeyFromSeedHex(seedHex);
  const pub = rawPublic(createPublicKey(priv)).toString('hex');
  return {
    runnerId: pub,
    publicKeyHex: pub,
    label,
    sign: (message: Buffer) => edSign(null, message, priv),
  };
}

/** Verify a detached signature. Return false on any malformed input. Never throw. */
export function verifyDetached(publicKeyHex: string, message: Buffer, signatureHex: string): boolean {
  if (!HEX64_RE.test(publicKeyHex) || !HEX128_RE.test(signatureHex)) return false;
  try {
    return edVerify(null, message, publicKeyFromHex(publicKeyHex), Buffer.from(signatureHex, 'hex'));
  } catch {
    return false; // A bad key throws ERR_OSSL_ASN1_TOO_LONG. Treat it as a failed check.
  }
}
