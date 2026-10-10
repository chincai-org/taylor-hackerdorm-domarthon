# Petri — Binding Contract v1

**Repo root:** `<repo>`
**Status:** binding. Every path, name, number and byte in this document is final.
**Audience:** the implementers of each module. You will not see the four design specs
this document reconciles. Anything absent from here is absent from Petri.

---

## 0. How to read this document

Three laws govern every section.

1. **This document wins.** If code disagrees with this document, the code is wrong.
2. **One mechanism per job.** Where two designs did the same job, one was removed.
   The removal is recorded in a `> **Reconciled.**` note.
3. **Measured, not guessed.** Every byte count and every hash in this document was
   produced by running the code. Section 17 holds the frozen vectors.

Notation: `Hex64` means 64 lowercase hexadecimal characters, `/^[0-9a-f]{64}$/`.

### 0.1 What Petri is

Petri is a tree of agent-harness versions. Each node carries a hypothesis in plain
English, a harness snapshot, a measured result, and signatures from independent
machines that re-ran it. Rejected branches stay in the tree forever. An agent reads
the whole tree before it proposes the next change.

### 0.2 The six design rules

These rules are not negotiable. Each section says how it enforces them.

| # | Rule | Enforced in |
|---|---|---|
| 1 | A contributor can never accept their own node. Acceptance needs 2 independent verifications. | §9.4, §5.3, §9.6 |
| 2 | Every candidate runs N times (default 5) and the MEDIAN is used. | §9.2, §10.6 |
| 3 | Rejected nodes are first-class records. Nothing is ever deleted. | §7, §9.5, §13.5, §19 |
| 4 | Every node states a HYPOTHESIS in plain English. | §6.3, §8.3 |
| 5 | The benchmark is deterministic to score. Unit tests pass or fail. No LLM judge. | §10 |
| 6 | It runs end to end with NO API key and NO Hedera account. | §4.3, §8.6, §10.10, §14.7 |

---

## 1. Vocabulary, and the two mode axes

Four designs used four different words for the same two ideas. Petri uses two axes.
They are orthogonal. Never conflate them.

| Axis | Field name | Values | Question it answers |
|---|---|---|---|
| Measurement | `mode` | `'live'` \| `'replay'` | Did the harness call a real model? |
| Ledger | `ledger` | `'hcs'` \| `'local'` | Where does the consensus log live? |

> **Reconciled.** The `sim`/`real` pair and the `live`/`replay` pair named one axis.
> The `hedera`/`offline` pair named a different axis. Petri keeps `mode` for the
> first and `ledger` for the second. Reason: a judge can run `mode: replay` with
> `ledger: local`, or `mode: live` with `ledger: hcs`, or either cross pair. One
> combined word cannot express four states.

Other terms, fixed:

| Term | Meaning |
|---|---|
| **runner id** | A 32-byte ed25519 public key, as Hex64. The key IS the identity. There is no registry. |
| **tree id** | A short name for one Petri tree. `/^[a-z0-9][a-z0-9-]{0,63}$/`. |
| **content id** | `sha256Hex(canonicalBytes(value))`. Always Hex64. |
| **node id** | The content id of a `NodeManifest`. |
| **harness id** | The content id of a harness snapshot, through `harnessDigestInput`. §3.4. |
| **bench id** | The content id of a `BenchSpec`. §10.3. |
| **report id** | The content id of a `VerificationReport`. |
| **bp** | Basis points. One bp is 1/10000. A score of 12 tasks out of 20 is 6000 bp. |
| **candidate** | A node that is not yet accepted or rejected. Its status is `pending`. |

### 1.1 Every id is bare hexadecimal

An id on disk, in a record, or on the wire is **bare Hex64**. There is no
`sha256:`, `petri1:`, `petriv1:` or `ed25519:` prefix in any stored byte.

A prefix may appear in terminal output only, to help a human read it. `petri show`
may print `node petri1:a3572a8d…`. The bytes it read carried `a3572a8d…`.

> **Reconciled.** One design prefixed every id. Another used bare hex everywhere.
> Petri takes bare hex. Reasons: one regex `^[0-9a-f]{64}$` validates every id in
> the system; the ed25519 public key is already bare hex, so a prefixed id and a
> bare key would need two rules; and prefixes cost 28 to 63 bytes in a Hedera
> message that has a hard 1024-byte limit. The cost is that you cannot tell a node
> id from a bench id by looking. The field name tells you instead.

### 1.2 The root sentinel

A node with no parent sets `parent: 'root'`. The string `'root'` is the only
non-hex value any id field ever takes.

> **Reconciled.** One design used `parent: null`. The canonical encoder in §2
> rejects `null`, because JSON writers in other languages disagree on whether to
> emit a null key or drop it. The literal `'root'` removes the question.

---

## 2. Canonical JSON — the one function

**There is exactly one canonical serialiser in Petri.** It produces the bytes that
are hashed and the bytes that are signed. Both. No module may write a second one.

`<repo>/src/core/canonical.ts`

```ts
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
    return JSON.stringify(v); // ECMA-262 QuoteJSONString. Fully specified. Every engine agrees.
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
    const proto = Object.getPrototypeOf(v);
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
```

### 2.1 The four rules, and why each exists

| Rule | What goes wrong without it |
|---|---|
| Integers only. No floats. | `0.1 + 0.2` prints different digits in different languages. |
| No `null`, no `undefined`. | Some writers drop a null key. Some keep it. Absent means absent. |
| Keys sorted, ASCII lowerCamelCase. | Object key order is insertion order in JS and arbitrary elsewhere. |
| Lone surrogates rejected. | JavaScript escapes them. Python emits raw bytes. |

### 2.2 The property that makes nesting safe

`canonicalJson(JSON.parse(canonicalJson(x))) === canonicalJson(x)`. Verified true.

The function depends only on the value. It does not depend on where the value sits
in a document. So a body nested inside an envelope canonicalises to the same bytes
as that body alone. A verifier can therefore hash a body it found inside a wrapper.

### 2.3 Disk bytes are never hashed bytes

Files under `.petri/` are written pretty-printed, with two-space indent and a
trailing newline, for humans to read. **Those bytes are never hashed.** Every hash
is recomputed from the parsed value through `canonicalJson`.

Re-indenting a file can therefore never change an id. The cost is that you cannot
check an id with `sha256sum somefile.json`. Use `petri fsck` instead.

The pretty writer lives in `<repo>/src/store/json.ts`.

```ts
import { writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { byteCompare } from '../core/canonical.js';

function stableOrder(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stableOrder);
  if (v !== null && typeof v === 'object') {
    const src = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src).sort(byteCompare)) out[k] = stableOrder(src[k]);
    return out;
  }
  return v;
}

/** Atomic write. A crash never leaves a half-written record. NEVER hashed. */
export function writeJsonFile(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const text = `${JSON.stringify(stableOrder(value), null, 2)}\n`;
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o644 });
  renameSync(tmp, path);
}
```

---

## 3. Content addressing

### 3.1 Four id makers, one hash

| Id | How it is made | Defined in |
|---|---|---|
| content id | `contentId(value)` | `src/core/canonical.ts` |
| node id | `contentId(manifest)` where `manifest.protocol === 'petri/node/1'` | `src/core/ids.ts` |
| report id | `contentId(report)` where `report.protocol === 'petri/verify/1'` | `src/core/ids.ts` |
| bench id | `contentId(spec)` where `spec.protocol === 'petri/bench/1'` | `src/core/ids.ts` |
| harness id | `sha256Hex(harnessDigestInput(snapshot))` | `src/core/ids.ts` |

> **Reconciled.** One design separated domains with a hash prefix, such as
> `sha256("petri.node.v1\n" + bytes)`. Another put a `protocol` field inside the
> object. Petri keeps the in-band `protocol` field for content ids. Reason: a
> content id must be recomputable by anybody from the stored bytes, with one
> function and no side table of domain strings. The `protocol` field is inside the
> hash, so it separates domains just as well and it is visible in the file.
> The hash prefix survives in one place only: signing. See §5.2.

### 3.2 A harness snapshot

```ts
/** A harness snapshot maps a relative POSIX path to UTF-8 file content. */
export type HarnessSnapshot = Readonly<Record<string, string>>;
```

The snapshot builder rejects a path that breaks any rule.

1. It uses `/` as the separator. A backslash is rejected.
2. It is relative. A leading `/`, a leading `./`, or any `..` segment is rejected.
3. It is Unicode NFC normalised. macOS gives NFD names. Linux gives NFC.
   Normalise on read, or one tree hashes to two values on two machines.
4. It is not empty. It is at most 512 UTF-8 bytes.
5. No segment is `.git`, `.petri`, `node_modules` or `dist`.

Content rules:

- Content must be valid UTF-8. Binary is rejected, so a human can `cat` every object.
- Content must not contain a carriage return, `0x0D`. A Windows checkout rewrites
  `\n` to `\r\n`. That changes the hash in silence. Petri refuses the file instead,
  and names the path in the error.

### 3.3 Framing helpers

`<repo>/src/core/bytes.ts`

```ts
export const utf8 = (s: string): Buffer => Buffer.from(s, 'utf8');

/**
 * Write one length-prefixed field: `<tag> <byteLength>\n<payload>\n`
 * The length fixes the payload boundary. The reader never scans for a tag.
 * No payload can therefore imitate a tag line.
 */
export const frame = (tag: string, payload: Buffer): Buffer =>
  Buffer.concat([utf8(`${tag} ${payload.length}\n`), payload, utf8('\n')]);
```

### 3.4 The exact bytes hashed for a harness snapshot

`<repo>/src/core/ids.ts`

```ts
import { sha256Hex, byteCompare } from './canonical.js';
import { utf8, frame } from './bytes.js';
import type { HarnessSnapshot } from './schema.js';

export const HARNESS_DOMAIN = 'petri.harness.v1\n';

/**
 * Grammar. Every literal is ASCII.
 *
 *   input = "petri.harness.v1\n" "count " N "\n" entry*
 *   entry = "path " len "\n" pathUtf8    "\n"
 *           "data " len "\n" contentUtf8 "\n"
 *
 * N and len are decimal. No sign, no leading zeros, no padding.
 * Entries appear in UTF-8 byte order of the path.
 * The insertion order of the input object does not matter.
 */
export function harnessDigestInput(snapshot: HarnessSnapshot): Buffer {
  const paths = Object.keys(snapshot).sort(byteCompare);
  const parts: Buffer[] = [utf8(HARNESS_DOMAIN), utf8(`count ${paths.length}\n`)];
  for (const p of paths) {
    parts.push(frame('path', utf8(p)));
    parts.push(frame('data', utf8(snapshot[p]!)));
  }
  return Buffer.concat(parts);
}

export const harnessId = (snapshot: HarnessSnapshot): string =>
  sha256Hex(harnessDigestInput(snapshot));

/** The harness id of the empty snapshot. It is the parent baseline of every root. */
export const EMPTY_HARNESS_ID =
  '5894095975556df34aedf9a9be1228f959515821141de45e140f46890fe83a59';
```

**Why a second serialiser exists.** File content is arbitrary text. Canonical JSON
would work, but the length prefix removes a whole class of attack that JSON cannot.
Without a length prefix, `{ "ab": "c" }` and `{ "a": "bc" }` can serialise to the
same bytes, so an author could hide one harness behind another's hash.

This is the only second serialiser in Petri. It hashes file trees and nothing else.
It is domain-separated by its first line, so its output can never collide with a
canonical JSON document.

**Two objects are hashed through a rule, not from their whole stored bytes.** A
`HarnessObject` is hashed through `harnessDigestInput(files)` above. A `NodeDetail`
is hashed through `detailIdOf`, which blanks the back-reference of §6.4 and drops
the observation fields of §6.4a. Each rule is one exported function in
`src/core/ids.ts`, each is written out in this document, and each is recomputable
by anybody from the stored bytes. Nothing else may be addressed this way.

### 3.5 Paths on disk

A content id shards on its first two characters. Id `a3572a8d…f2a4` lives at
`objects/a3/572a8d…f2a4`. Node `a3572a8d…f2a4` lives at `nodes/a3/572a8d…f2a4/`.

`<repo>/src/store/paths.ts` owns every path
computation. No other module builds a path under `.petri/` by string concatenation.

---

## 4. Configuration

`<repo>/src/config.ts`

```ts
import { z } from 'zod';

export const Hex64 = z.string().regex(/^[0-9a-f]{64}$/);
export const TreeId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
export const AccountId = z.string().regex(/^\d+\.\d+\.\d+$/);

export const PolicySchema = z.strictObject({
  maxRunSpreadBp: z.int().min(0).max(10000).default(3000),
  maxRunnerDisagreementBp: z.int().min(0).max(10000).default(1000),
  minDeltaBp: z.int().min(1).max(10000).default(1000),
  minRuns: z.int().min(3).max(99).default(5),
  minVerifications: z.int().min(2).max(8).default(2),
  trustedRunners: z.array(Hex64).max(64).default([]),
});
export type Policy = z.infer<typeof PolicySchema>;

export const PetriConfigSchema = z.strictObject({
  bench: z.strictObject({ id: Hex64, name: z.string().min(1).max(64) }),
  hedera: z.strictObject({
    mirrorRest: z.array(z.url()).min(1),
    network: z.enum(['testnet', 'mainnet', 'previewnet']),
    operatorId: AccountId,
    topicId: AccountId,
  }).optional(),
  ledger: z.enum(['hcs', 'local']),
  mode: z.enum(['live', 'replay']),
  policy: PolicySchema,
  runsPerVerification: z.int().min(3).max(99).default(5),
  treeId: TreeId,
  version: z.literal(1),
});
export type PetriConfig = z.infer<typeof PetriConfigSchema>;

export const CONFIG_PATH = '<repo>/.petri/config.json';
```

`runsPerVerification` must be odd. `loadConfig` throws when it is even.

### 4.1 The acceptance constants, and where they came from

| Constant | Value | Meaning |
|---|---|---|
| `minVerifications` | 2 | Independent non-author runners needed. Design rule 1. |
| `minRuns` | 5 | Runs per side per verification. Must be odd. Design rule 2. |
| `minDeltaBp` | **1000** | The win margin. 1000 bp is 10 points, or 2 tasks out of 20. |
| `maxRunSpreadBp` | 3000 | Above this, one verifier's runs are too noisy to judge. 6 tasks of 20. |
| `maxRunnerDisagreementBp` | 1000 | Above this, two verifiers disagree about the same change. |

**Why the margin is 1000 bp.** A 400,000-trial simulation measured the chance that
a candidate identical to its parent still clears the margin.

| Margin | False accept, 4 flaky tasks | False accept, 8 flaky | Power at a true +2 | Power at a true +3 |
|---|---|---|---|---|
| 500 bp (1 task) | 24.3% | 29.9% | 98.7% | 100% |
| **1000 bp (2 tasks)** | **1.4%** | **5.3%** | **75.8%** | **98.7%** |
| 1500 bp (3 tasks) | 0.01% | 0.4% | 24.2% | 75.6% |

A 500 bp margin is the intuitive choice and it is ruinous. About one accepted node
in four would be pure noise. A 1500 bp margin refuses three quarters of genuine
two-task improvements, so the tree stops growing. 1000 bp sits between them.

> **Reconciled.** One design set `minDeltaBp: 1` — any positive delta accepts.
> Another simulated the margin and set it at 2 tasks out of 20. Petri takes the
> mechanism from the first design (basis points, paired deltas) and the number from
> the second (2 tasks, which is 1000 bp). A margin of 1 bp cannot survive the
> measured 24% false-accept rate at a one-task margin.

The cost is honest and stated: about 24% of genuine two-task wins are labelled
`WITHIN_NOISE`. Such a node stays in the tree, and its reason string says plainly
that this was a tie and not a regression.

### 4.2 The spread guard

Measured range across 5 runs, 60,000 trials.

| Noise regime | Mean spread | p95 | P(spread > 6 tasks) |
|---|---|---|---|
| 4 flaky tasks | 2.24 | 4 | 0.00% |
| 8 flaky tasks | 3.22 | 5 | 0.54% |
| all 20 flaky | 5.16 | 9 | 23.5% |

A threshold of 3000 bp never fires in the realistic regime. It fires often in the
regime where no margin can work, because the benchmark carries no signal there.
When it fires, the node stays `pending`, not `rejected`. The measurement is
unusable, so Petri refuses to judge and asks for more runs.

### 4.3 The offline default

`petri init` with no `ANTHROPIC_API_KEY` writes `mode: 'replay'`.
`petri init` with no `HEDERA_OPERATOR_KEY` writes `ledger: 'local'`.
Both defaults are correct with zero setup. Design rule 6 holds.

---

## 5. Identity and signing

### 5.1 `src/trust/identity.ts`

```ts
import {
  createPrivateKey, createPublicKey, generateKeyPairSync,
  sign as edSign, verify as edVerify, type KeyObject,
} from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname } from 'node:path';

export const PETRI_DIR = '<repo>/.petri';
export const IDENTITY_PATH = `${PETRI_DIR}/identity.json`;

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
  // 'wx' fails when the file exists. This stops an accidental key overwrite.
  writeFileSync(path, JSON.stringify(file, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
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

/** Verify a detached signature. Return false on any malformed input. Never throw. */
export function verifyDetached(publicKeyHex: string, message: Buffer, signatureHex: string): boolean {
  if (!HEX64_RE.test(publicKeyHex) || !HEX128_RE.test(signatureHex)) return false;
  try {
    return edVerify(null, message, publicKeyFromHex(publicKeyHex), Buffer.from(signatureHex, 'hex'));
  } catch {
    return false; // A bad key throws ERR_OSSL_ASN1_TOO_LONG. Treat it as a failed check.
  }
}
```

ed25519 signatures are deterministic per RFC 8032. Signing the same bytes twice
gives the same 64 bytes.

### 5.2 `src/trust/envelope.ts` — domain separation

One key signs both consensus messages and verification reports. Without a prefix,
an attacker could replay a signature from one context into the other.

```ts
import { canonicalBytes, type Canon } from '../core/canonical.js';
import { HEX128_RE, HEX64_RE, verifyDetached, type Identity } from './identity.js';

export type Domain = 'msg' | 'report';

/** The exact bytes an ed25519 key signs. Nothing else is ever signed. */
export function signingBytes(domain: Domain, body: Canon): Buffer {
  return Buffer.concat([Buffer.from(`petri/v1/${domain}\n`, 'utf8'), canonicalBytes(body)]);
}

export interface SignedEnvelope<B extends Canon = Canon> {
  body: B;
  pub: string;   // Hex64. The signer public key.
  sig: string;   // 128 hex. The 64-byte signature.
  ver: 1;
}

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
```

The envelope key order after sorting is `body, pub, sig, ver`. That is the wire order.

### 5.3 The signer is read from the envelope, never from the body

Every module that needs to know who signed something reads `envelope.pub`, which
the signature check covers. No module ever reads a `runner` or `author` field from
a body to decide who signed it. The signer controls the body. The signer does not
control the signature check.

`VerificationReport.runner` exists for readers. `checkReport` asserts that it
equals `envelope.pub` and fails otherwise.

---

## 6. The records

`<repo>/src/core/schema.ts` holds every shared
interface and every shared Zod schema. Other modules import from here. No module
declares a second copy of a shared type.

```ts
import { z } from 'zod';

export const Hex64 = z.string().regex(/^[0-9a-f]{64}$/);
export const Hex128 = z.string().regex(/^[0-9a-f]{128}$/);
export const TreeId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
/** A parent is a node id, or the literal "root" for the first node of a tree. */
export const ParentRef = z.union([Hex64, z.literal('root')]);
/** A side of a paired report names a node id, or "root". */
export const SideRef = ParentRef;

export type Mode = 'live' | 'replay';
export const ModeSchema = z.enum(['live', 'replay']);

/** Count the escaped JSON bytes, not the characters. The wire limit is bytes. */
export const byteLen = (max: number) => (s: string) =>
  Buffer.byteLength(JSON.stringify(s), 'utf8') <= max;
```

### 6.1 Harness snapshot

```ts
export type HarnessSnapshot = Readonly<Record<string, string>>;

export const HarnessSnapshotSchema = z.record(
  z.string().min(1).max(512),
  z.string(),
);

/** A harness snapshot as stored in the object store. */
export interface HarnessObject {
  protocol: 'petri/harness/1';
  files: Record<string, string>;
}
export const HarnessObjectSchema = z.strictObject({
  protocol: z.literal('petri/harness/1'),
  files: HarnessSnapshotSchema,
});
```

The harness id is **not** `contentId(HarnessObject)`. It is
`harnessId(object.files)`, through the framing in §3.4. The wrapper exists only so
the file on disk says what it is.

### 6.2 Benchmark reference

```ts
/** One task in the benchmark. `testsId` is the content id of test.mjs. */
export interface BenchTask { id: string; testCount: number; testsId: string; }

export const BenchTaskSchema = z.strictObject({
  id: z.string().regex(/^\d{2}-[a-z0-9-]+$/),
  testCount: z.int().min(1).max(1000),
  testsId: Hex64,
});

/** The benchmark spec. Its content id is the bench id. */
export interface BenchSpec {
  protocol: 'petri/bench/1';
  id: string;            // A stable human name, e.g. "petri-bench-v1".
  tasks: BenchTask[];    // Ordered by task id, ascending.
  total: number;         // tasks.length. Stored so a reader never has to count.
}
export const BenchSpecSchema = z.strictObject({
  protocol: z.literal('petri/bench/1'),
  id: z.string().min(1).max(64),
  tasks: z.array(BenchTaskSchema).min(1).max(1000),
  total: z.int().min(1).max(1000),
}).refine((s) => s.total === s.tasks.length, 'total must equal tasks.length');
```

### 6.3 `NodeManifest` — the hashed core of a node

```ts
/**
 * The node id is contentId(NodeManifest). Nothing else.
 * This object is immutable. Every field here is inside the node id.
 */
export interface NodeManifest {
  protocol: 'petri/node/1';
  tree: string;
  parent: string;      // A node id, or "root".
  author: string;      // The author ed25519 public key, Hex64.
  harness: string;     // The harness id of the snapshot this node runs.
  bench: string;       // The bench id this node is measured against.
  detail: string;      // The content id of the NodeDetail. §6.4.
  hypothesis: string;  // Plain English. Design rule 4. At most 240 escaped bytes.
  nonce: string;       // Lets one author re-propose an identical node. Usually "".
}

export const NodeManifestSchema = z.strictObject({
  protocol: z.literal('petri/node/1'),
  tree: TreeId,
  parent: ParentRef,
  author: Hex64,
  harness: Hex64,
  bench: Hex64,
  detail: Hex64,
  hypothesis: z.string().min(12)
    .refine(byteLen(240), 'hypothesis is over 240 escaped bytes')
    .refine((s) => s.trim() === s && !/\s{2,}/.test(s) && !/[\r\n]/.test(s),
      'hypothesis must be one trimmed line with single spaces, so the hash is stable'),
  nonce: z.string().regex(/^([0-9a-f]{2})*$/).max(64),
});
```

### 6.4 `NodeDetail` — the evidence bundle

`NodeDetail` is a separate object because it is large and because the wire message
must stay small. `NodeManifest.detail` commits to it, so it is tamper-evident.

```ts
/** `wallMs` is OBSERVATION. The other three are IDENTITY. See §6.4a. */
export interface ClaimedRun { passed: number; scoreBp: number; tokens: number; wallMs: number; }

export const ClaimedRunSchema = z.strictObject({
  passed: z.int().min(0),
  scoreBp: z.int().min(0).max(10000),
  tokens: z.int().min(0),
  wallMs: z.int().min(0),   // OBSERVATION. Never hashed.
});

/**
 * The author's own measurement and the reasoning behind the change.
 * The claimed runs NEVER count toward acceptance. They are a claim, not a vote.
 */
export interface NodeDetail {
  protocol: 'petri/detail/1';
  node: string;              // The node id. Set after the manifest is built. See note.
  mode: Mode;
  proposal: Proposal;        // §13.2.
  derivedAreas: string[];    // From the diff classifier. §12.1.
  areaMismatch: boolean;     // True when the declared area differs from the derived one.
  claimedRuns: ClaimedRun[]; // Odd length, at least 3. May be empty for a mechanical rejection.
  claimedMedianBp: number;   // medianInt over claimedRuns[].scoreBp, or 0 when empty.
  parentHarness: string;     // The parent harness id, or EMPTY_HARNESS_ID for a root.
  provenance: Provenance;    // §13.4.
  mechanical: MechanicalResult; // §13.5. 'ok', or the machine rejection that stopped the run.
}
```

**The `node` field is a back-reference and must be `""` when the detail is hashed.**
Build order: build `NodeDetail` with `node: ""`, take its content id, put that id in
the manifest, take the node id, then write the detail file with `node` filled in.
The stored file therefore does **not** hash to `manifest.detail`.

> `petri fsck` check 5 verifies it by blanking `node` before it rehashes. The
> alternative, leaving the back-reference out, forces every reader of a detail file
> to already know which node it belongs to. The exception is cheap and the check is
> one line. The second reason the stored file does not hash to its own address is
> §6.4a: the file also carries observation fields, and none of them is hashed.

```ts
export const NodeDetailSchema = z.strictObject({
  protocol: z.literal('petri/detail/1'),
  node: z.union([Hex64, z.literal('')]),
  mode: ModeSchema,
  proposal: ProposalSchema,
  derivedAreas: z.array(AreaSchema).min(1),
  areaMismatch: z.boolean(),
  claimedRuns: z.array(ClaimedRunSchema).max(99)
    .refine((a) => a.length === 0 || (a.length >= 3 && a.length % 2 === 1),
      'claimed run count must be 0, or odd and at least 3'),
  claimedMedianBp: z.int().min(0).max(10000),
  parentHarness: Hex64,
  provenance: ProvenanceSchema,
  mechanical: MechanicalResultSchema,
});
```

### 6.4a Identity and observation — what a node id may depend on

**A node id depends ONLY on what the experiment IS. It never depends on where or
when the experiment ran.** Two machines that run one patch must compute one node
id. Without that, no reader can recompute an id from the stored bytes, every
parent link is a guess, and §6.8 gives two honest verifiers two seed sets.

Every field of a `NodeDetail` is therefore one of two kinds.

| Kind | What it is | Hashed |
|---|---|---|
| **IDENTITY** | It describes the experiment. | yes |
| **OBSERVATION** | It describes this one execution. | **never** |

The full classification. Nothing is in neither column.

| Field | Kind | Why |
|---|---|---|
| `protocol`, `mode`, `parentHarness` | identity | What was run, and against what. |
| `proposal` | identity | The patch, the hypothesis, the motif, the full file contents. |
| `derivedAreas`, `areaMismatch` | identity | Derived from the patch by a pure function. |
| `claimedRuns[].passed`, `.scoreBp`, `.tokens` | identity | The measurement. It is what the experiment found. |
| `claimedMedianBp` | identity | The median of those scores. |
| `provenance.source`, `.model`, `.seed` | identity | Who proposed the change, and with which seed. |
| `mechanical.cls` | identity | The machine verdict on the patch. |
| `mechanical.evidence` | **reduced** | Only its ordered `TS####` diagnostics, each with a workspace-relative path. §6.4b. |
| `node` | blanked | The back-reference of §6.4. |
| `claimedRuns[].wallMs` | observation | Wall time. Different on every machine and on every second run. |
| `provenance.promptHash` | observation | The prompt embeds the local digest. |
| `provenance.digestHash` | observation | The digest covers nodes that exist on one disk and in no log. |
| `mechanical.command` | observation | An absolute tsconfig path, and whichever compiler could be started. |
| `mechanical.exitCode` | observation | `2` from a compiler, `127` from a machine with none. Same patch, same class. |

An observation is stored, printed and read like any other field. It is display
data, exactly as `diff.patch` is display data. `detailObservation()` in
`<repo>/src/core/ids.ts` returns all of it in one
record, and `detailToCanon()` in the same file is the ONE place the split is
applied. That function names every key of `NodeDetail`, so a field added later
fails the build until an author puts it in one column or the other. The Zod types
`ClaimedRunIdentity`, `ProvenanceIdentity` and `MechanicalObservation` in
`src/core/schema.ts` carry compile-time guards that no field is in neither.

`VerificationReport.startedAt`, `RunRecord.wallMs` and `EnvDescriptor` are
observations of a different record. A report is itself the record of one
execution, so its id is allowed to name that execution.

> **Reconciled.** The first version of this document hashed the whole detail. That
> made a node id a function of wall time, of the user's home directory, of a fresh
> UUID per run and of which nodes happened to sit on one disk, so the same patch
> got a new id on every machine and on every second run of one machine. The rule
> above replaces it. The cost is a protocol break: a node written under the old
> rule does not rehash, and `petri fsck` says so in checks 5 and 14. A tree built
> before this section must be rebuilt.

### 6.4b The mechanical evidence is kept, and summarised

`mechanical.evidence` holds the **verbatim** tool output, so a reader sees what the
compiler really said. It is not hashed as it stands, because a compiler prints the
path it was given and that path carries `/Users/<name>/…/.petri/scratch/<uuid>/`.

What the id sees is the ordered list of diagnostics:

```
harness/loop.ts(12,3) TS2345
harness/prompt.ts(4,18) TS2322
```

`diagnosticsOf(evidence)` in `src/core/ids.ts` builds it. Each line keeps the
error code and the workspace-relative location. It drops everything before
`harness/`, the message prose, the summary table and the clip marker. A
diagnostic with no file, such as `error TS18003`, reduces to its code alone.
Evidence with no diagnostic in it, such as a model reply that would not parse,
reduces to the empty list, and the class alone then carries the outcome.

Two defences keep the input stable before the reduction ever runs. §13.6 gives the
compiler the **scratch workspace** as its working directory, so it prints relative
paths. The reduction then removes whatever a different tool version still adds.

### 6.5 `VerificationReport` — the paired measurement

`<repo>/src/trust/report.ts`

**Why one report covers both sides.** A verifier who runs only the candidate proves
nothing. Four things move an absolute score: the machine, test flakiness, model
drift, and baseline drift. So an absolute candidate score is not comparable to
anything. **Only a delta measured on one machine, in one session, with one seed set,
is comparable.**

This also blocks one attack. A dishonest author measures the parent on a slow
machine and the candidate on a fast one, then claims a large gain. A paired report
makes that impossible, because the verifier produces both numbers.

```ts
export const REPORT_PROTOCOL = 'petri/verify/1';

/** One benchmark run. Every number is an integer. */
export interface RunRecord {
  passed: number;    // Tasks whose tests all passed.
  resultId: string;  // Hex64. The content id of the raw RunResult in the object store.
  scoreBp: number;   // floor(10000 * passed / total)
  seed: string;      // Hex64. seedFor(candidateNodeId, i).
  tokens: number;    // Total model tokens. 0 in replay mode.
  wallMs: number;    // Observational only. The accept rule never reads it.
}

/** One side of the paired measurement. */
export interface SideSummary {
  medianBp: number;  // medianInt over runs[].scoreBp
  node: string;      // A node id, or "root".
  runs: RunRecord[]; // In run order. Length equals report.runs.
  total: number;     // The task count. It MUST be equal on both sides.
}

/** The machine the measurement ran on. Descriptive. The accept rule never reads it. */
export interface EnvDescriptor {
  arch: string;        // process.arch
  benchId: string;     // Hex64.
  ledger: string;      // 'hcs' | 'local'
  mode: string;        // 'live' | 'replay'
  model: string;       // 'claude-sonnet-5', or 'none' in replay mode.
  nodeVersion: string; // process.version
  petriCommit: string; // The git commit of this checkout, 40 hex, or 'unknown'.
  platform: string;    // process.platform
}

export interface VerificationReport {
  protocol: 'petri/verify/1';
  tree: string;
  bench: string;         // Hex64. The bench id.
  mode: Mode;            // Inside the signature. A replay report can never pass as live.
  runner: string;        // Hex64. It MUST equal the envelope pub.
  runs: number;          // N. Odd, at least 3.
  parent: SideSummary;
  candidate: SideSummary;
  deltaMedianBp: number; // medianInt over i of (candidate.runs[i].scoreBp - parent.runs[i].scoreBp)
  seedBase: string;      // Hex64.
  startedAt: number;     // Unix milliseconds. Observational.
  env: EnvDescriptor;
}

export type SignedReport = SignedEnvelope<VerificationReport>;
```

Zod:

```ts
export const RunRecordSchema = z.strictObject({
  passed: z.int().min(0), resultId: Hex64, scoreBp: z.int().min(0).max(10000),
  seed: Hex64, tokens: z.int().min(0), wallMs: z.int().min(0),
});
export const SideSummarySchema = z.strictObject({
  medianBp: z.int().min(0).max(10000), node: SideRef,
  runs: z.array(RunRecordSchema).min(3).max(99), total: z.int().min(1).max(1000),
});
export const EnvDescriptorSchema = z.strictObject({
  arch: z.string().min(1).max(32), benchId: Hex64,
  ledger: z.enum(['hcs', 'local']), mode: ModeSchema,
  model: z.string().min(1).max(64), nodeVersion: z.string().min(1).max(32),
  petriCommit: z.union([z.string().regex(/^[0-9a-f]{40}$/), z.literal('unknown')]),
  platform: z.string().min(1).max(32),
});
export const VerificationReportSchema = z.strictObject({
  protocol: z.literal(REPORT_PROTOCOL), tree: TreeId, bench: Hex64, mode: ModeSchema,
  runner: Hex64, runs: z.int().min(3).max(99),
  parent: SideSummarySchema, candidate: SideSummarySchema,
  deltaMedianBp: z.int().min(-10000).max(10000), seedBase: Hex64,
  startedAt: z.int().min(0), env: EnvDescriptorSchema,
});
```

### 6.6 Median, score and seeds

```ts
/** Median of an odd-length integer list. An even length is a protocol error. */
export function medianInt(xs: readonly number[]): number {
  if (xs.length === 0) throw new Error('median of an empty list');
  if (xs.length % 2 === 0) throw new Error(`run count must be odd, got ${xs.length}`);
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[(sorted.length - 1) / 2]!;
}

export function scoreBp(passed: number, total: number): number {
  if (!Number.isInteger(passed) || !Number.isInteger(total)
      || total <= 0 || passed < 0 || passed > total) {
    throw new Error(`bad score inputs passed=${passed} total=${total}`);
  }
  return Math.floor((10000 * passed) / total);
}

export const seedFor = (candidateNodeId: string, i: number): string =>
  sha256Hex(`petri/seed/1|${candidateNodeId}|${i}`);
export const seedBaseFor = (candidateNodeId: string): string =>
  sha256Hex(`petri/seed/1|${candidateNodeId}`);
export const reportId = (report: VerificationReport): string => contentId(report);
```

> **Reconciled.** Three designs proposed three score types: integer task counts, a
> rational `{n, d}`, and basis points. Petri takes **basis points**, with `passed`
> and `total` carried beside every score so the exact fraction is recoverable. The
> rational needs its own comparison rule and its own median rule, which is a third
> arithmetic to get wrong. Basis points compare with `<`.

> **Reconciled.** One design used the lower median and one used the textbook median
> for even counts. Petri makes an even run count a **hard error**, so the two
> definitions become the same definition: the middle element. All three designs
> already required an odd count somewhere. Petri requires it everywhere.

> **Reconciled.** One design pooled every run from every verifier into one median.
> Another took the median of paired deltas per verifier. Petri takes **paired
> deltas per verifier**, and §9 then requires every counted verifier to clear the
> margin on its own. Pooling assumed the machines are exchangeable, which is the
> assumption the disagreement guard exists to doubt. Per-verifier deltas need no
> such assumption. Pairing also removes the `PARENT_UNVERIFIED` case entirely,
> because each verifier measures the parent itself.

### 6.7 `checkReport`

```ts
export type CheckReport =
  | { ok: true; report: VerificationReport; id: string }
  | { ok: false; reason: string };

/** Full structural and cryptographic check of a stored report. */
export function checkReport(value: unknown, expectedId?: string): CheckReport {
  const opened = openEnvelope<VerificationReport>('report', value);
  if (!opened.ok) return { ok: false, reason: opened.reason };
  const parsed = VerificationReportSchema.safeParse(opened.body);
  if (!parsed.success) return { ok: false, reason: `schema: ${parsed.error.message}` };
  const r = parsed.data;

  if (r.runner !== opened.pub) return { ok: false, reason: 'report.runner is not the signer' };
  if (r.runs % 2 === 0) return { ok: false, reason: `even run count ${r.runs}` };
  if (r.parent.runs.length !== r.runs || r.candidate.runs.length !== r.runs) {
    return { ok: false, reason: 'the run count does not match the run arrays' };
  }
  if (r.parent.total !== r.candidate.total) {
    return { ok: false, reason: 'the test totals differ between the two sides' };
  }
  if (r.env.mode !== r.mode) return { ok: false, reason: 'env.mode differs from report.mode' };
  if (r.env.benchId !== r.bench) return { ok: false, reason: 'env.benchId differs from report.bench' };
  if (r.seedBase !== seedBaseFor(r.candidate.node)) {
    return { ok: false, reason: 'seedBase is not derived from the candidate node id' };
  }

  // Recompute every derived number. A signature proves authorship, not arithmetic.
  if (medianInt(r.parent.runs.map((x) => x.scoreBp)) !== r.parent.medianBp) {
    return { ok: false, reason: 'the parent median is wrong' };
  }
  if (medianInt(r.candidate.runs.map((x) => x.scoreBp)) !== r.candidate.medianBp) {
    return { ok: false, reason: 'the candidate median is wrong' };
  }
  const deltas = r.candidate.runs.map((c, i) => c.scoreBp - r.parent.runs[i]!.scoreBp);
  if (medianInt(deltas) !== r.deltaMedianBp) return { ok: false, reason: 'the delta median is wrong' };

  for (let i = 0; i < r.runs; i++) {
    if (scoreBp(r.parent.runs[i]!.passed, r.parent.total) !== r.parent.runs[i]!.scoreBp) {
      return { ok: false, reason: `parent run ${i}: scoreBp does not match passed/total` };
    }
    if (scoreBp(r.candidate.runs[i]!.passed, r.candidate.total) !== r.candidate.runs[i]!.scoreBp) {
      return { ok: false, reason: `candidate run ${i}: scoreBp does not match passed/total` };
    }
    const want = seedFor(r.candidate.node, i);
    if (r.parent.runs[i]!.seed !== want || r.candidate.runs[i]!.seed !== want) {
      return { ok: false, reason: `run ${i}: the seed is not the derived seed` };
    }
  }

  const id = reportId(r);
  if (expectedId !== undefined && id !== expectedId) {
    return { ok: false, reason: `report id mismatch: ${id} != ${expectedId}` };
  }
  return { ok: true, report: r, id };
}
```

### 6.8 Paired seeds

Run `i` of the parent and run `i` of the candidate use the same seed. The seed
controls task order and any sampling.

```
seedBase = sha256Hex("petri/seed/1|" + candidateNodeId)
seed_i   = sha256Hex("petri/seed/1|" + candidateNodeId + "|" + i)
```

The seed derives from the node id, so **every honest verifier uses the same seeds**.
In `mode: replay` the benchmark is fully deterministic, so two honest verifiers must
produce identical `resultId` values for each run. A mismatch is then evidence.
`petri replay --audit` reports it. This is a real, partial defence against the lazy
verifier of §18.1.

### 6.9 The root baseline

A root node has no parent. Its verifier still produces a paired report. The parent
side is **the empty harness**, `EMPTY_HARNESS_ID`, which exports no `solve` and
therefore scores 0 on every task by construction.

`report.parent.node` is the literal `'root'`. `report.parent.runs` hold the real
measured runs of the empty harness.

This keeps one report shape with no special case. It also doubles as a per-report
sandbox canary: if the empty harness scores above 0, the sandbox is broken and the
report is refused.

### 6.10 The materialised view

This is what the CLI and the agent read. It is never stored. It is rebuilt on load.

```ts
export type NodeStatus =
  | 'pending' | 'accepted' | 'rejected' | 'contested' | 'withdrawn' | 'superseded';

export interface PetriNode {
  id: string;
  manifest: NodeManifest;
  detail: NodeDetail;
  /** Unified diff against the parent snapshot. Display only. NEVER hashed. */
  diff: string;
  verifications: SignedReport[];
  status: NodeStatus;
  statusCode: DecisionCode;     // §9.3
  statusReason: string;         // Plain English. Safe to print to a terminal.
  verifiedDeltaBp: number | null;
  disputed: boolean;            // A StatusChanged claim disagreed with the computed status.
  mode: Mode;
  trust: 'hcs' | 'local-unverified';
  seq: number;                  // The log sequence number of its NodeSubmitted.
  consensusNanos: string;
}
```

> **Reconciled.** One design cached `status` inside `node.json`. Petri never stores
> a status. Status is derived from the evidence on every load. Reason: there is then
> exactly one source of truth, and a stale cache can never contradict the evidence.
> `.petri/index/` may cache it for speed, and `petri fsck` recomputes and compares.

### 6.11 The compile-time drift guard

Put this in `src/core/schema.ts`. It fails the build when an interface and its Zod
schema drift apart.

```ts
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const _manifest: Exact<NodeManifest, z.infer<typeof NodeManifestSchema>> = true;
const _detail: Exact<NodeDetail, z.infer<typeof NodeDetailSchema>> = true;
const _report: Exact<VerificationReport, z.infer<typeof VerificationReportSchema>> = true;
const _bench: Exact<BenchSpec, z.infer<typeof BenchSpecSchema>> = true;
```

---

## 7. The on-disk layout

```
<repo>/.petri/
├── config.json                  PetriConfig.               §7.1
├── identity.json                mode 0600. NEVER commit.   §7.2
├── log.jsonl                    The local consensus log.   §7.3
├── log.lock                     Transient. A write lock.
├── cursor.json                  The last log seq consumed. §7.4
├── mirror-cache.jsonl           Cached mirror entries. ledger: hcs only.
├── objects/
│   └── <aa>/<rest>.json         Content-addressed. HarnessObject, NodeDetail,
│                                BenchSpec, SignedReport, RunResult.
├── nodes/
│   └── <aa>/<rest>/
│       ├── manifest.json        NodeManifest, unwrapped.   §7.5
│       ├── envelope.json        The sealed NodeSubmitted.  §7.6
│       ├── diff.patch           Display only. Never hashed.
│       └── verifications/
│           └── <reportId>.json  SignedReport.              §7.7
├── index/                       ALL DERIVED. Deleting it loses nothing.
│   ├── nodes.json               id -> {parent, status, deltaBp, seq, reason}
│   ├── children.json            parentId -> [childId]
│   └── tips.json                Accepted leaves.
└── scratch/
    └── <runId>/                 An evolve workspace. Kept after a failure.
        ├── harness/             The candidate harness tree.
        ├── tsconfig.json        §13.6
        └── proposal.json        Proposal, for `petri submit`.
```

`petri fsck --rebuild` regenerates everything under `index/` from `nodes/` and
`objects/`. Nothing under `index/` is ever authoritative.

> **Reconciled.** Three designs proposed three layouts: `.petri/{objects,nodes,…}`,
> `.petri/{identity,config,log.jsonl,objects}`, and `.petri/{ledger,scratch}`. The
> tree above is their union with one name per thing. `ledger/nodes/<id>.json`
> became `nodes/<aa>/<rest>/manifest.json`, because a flat directory of 64-character
> names is slow on some filesystems and the shard costs nothing.

### 7.1 `.petri/config.json`

```json
{
  "bench": {
    "id": "aa80a75294768bd3bc81ed688e6fd0b4ea2741b68c3508fa37b023f1d70b5cb8",
    "name": "petri-bench-v1"
  },
  "ledger": "local",
  "mode": "replay",
  "policy": {
    "maxRunSpreadBp": 3000,
    "maxRunnerDisagreementBp": 1000,
    "minDeltaBp": 1000,
    "minRuns": 5,
    "minVerifications": 2,
    "trustedRunners": []
  },
  "runsPerVerification": 5,
  "treeId": "petri-main",
  "version": 1
}
```

With `ledger: "hcs"` the file also carries:

```json
  "hedera": {
    "mirrorRest": ["https://testnet.mirrornode.hedera.com"],
    "network": "testnet",
    "operatorId": "0.0.98765",
    "topicId": "0.0.5551234"
  },
```

`HEDERA_OPERATOR_KEY` is an environment variable. It is **never** written here.

### 7.2 `.petri/identity.json`, mode 0600

```json
{
  "algo": "ed25519",
  "createdAt": "2026-09-12T08:00:00.000Z",
  "label": "jingyuan-macbook",
  "privateKey": "1111111111111111111111111111111111111111111111111111111111111111",
  "publicKey": "d04ab232742bb4ab3a1368bd4615e4e6d0224ab71a016baf8520a332c9778737",
  "runnerId": "d04ab232742bb4ab3a1368bd4615e4e6d0224ab71a016baf8520a332c9778737",
  "version": 1
}
```

### 7.3 `.petri/log.jsonl`, one canonical JSON object per line

```json
{"chain":"bd79f478865074e46bb76eaf75a6311afd4c63850d62c53413af31710a2e4a2c","consensusNanos":"1789200000000000000","envelope":{"body":{"bench":"aa80a75294768bd3bc81ed688e6fd0b4ea2741b68c3508fa37b023f1d70b5cb8","hyp":"Because the prompt sends only symbol names, sending full signatures will raise the median by at least 500bp.","node":"a3572a8d3168357ad34c4afbebc65a4f55ccfa2c0bc5f157d4f65391dea75fa4","parent":"a5966c17a7d5ee36571983655df9c4c7e168b7602b90ae0b373d10b6b51e78a6","tree":"petri-main","type":"NodeSubmitted"},"pub":"d04ab232742bb4ab3a1368bd4615e4e6d0224ab71a016baf8520a332c9778737","sig":"38ce1b0a46fe537a42956f6c31421679faa238e18dc1b935ba2373b1f11ecdf36b529b149682ddd71bb81f9976310e906734618e5bd3fe97f8e70dcac889610e","ver":1},"payer":"local","seq":1,"source":"local","topic":"local:petri-main"}
```

This is the one file written with `canonicalJson`, not with the pretty writer. The
reason is the hash chain: `chain` covers the envelope, so the line must be stable.

### 7.4 `.petri/cursor.json`

```json
{ "lastSeq": 42, "topic": "local:petri-main", "updatedAt": "2026-09-12T08:10:00.000Z" }
```

### 7.5 `.petri/nodes/a3/572a8d…/manifest.json`

```json
{
  "author": "d04ab232742bb4ab3a1368bd4615e4e6d0224ab71a016baf8520a332c9778737",
  "bench": "aa80a75294768bd3bc81ed688e6fd0b4ea2741b68c3508fa37b023f1d70b5cb8",
  "detail": "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
  "harness": "88658e3e002e3c34a8a83b4d9f4fce37c5686015e38a373578cc74747ce8701d",
  "hypothesis": "Because the prompt sends only symbol names, sending full signatures will raise the median by at least 500bp.",
  "nonce": "",
  "parent": "a5966c17a7d5ee36571983655df9c4c7e168b7602b90ae0b373d10b6b51e78a6",
  "protocol": "petri/node/1",
  "tree": "petri-main"
}
```

Its content id is `a3572a8d3168357ad34c4afbebc65a4f55ccfa2c0bc5f157d4f65391dea75fa4`.
That is the node id. Verified. See §17, vector G6.

### 7.6 `.petri/nodes/<aa>/<rest>/envelope.json`

The sealed `NodeSubmitted` message, byte-identical to the one in the log. It is
stored beside the node so a reader can check authorship with no log access.

### 7.7 `.petri/nodes/<aa>/<rest>/verifications/<reportId>.json`

A `SignedReport`: `{ body: VerificationReport, pub, sig, ver: 1 }`, pretty-printed.

### 7.8 `.petri/objects/<aa>/<rest>.json`

Every object carries a `protocol` field naming its type. `ObjectStore` is the only
writer.

```ts
// <repo>/src/store/objects.ts
export interface ObjectStore {
  /** Store a canonical value. Return its content id. Writing twice is a no-op. */
  put(value: Canon): string;
  /** Read an object by content id. Throw when it is absent or its hash is wrong. */
  get(id: string): Canon;
  has(id: string): boolean;
}
```

> **Reconciled.** One design gave the object store a `Buffer` interface,
> `put(bytes): Promise<string>`. Petri gives it a `Canon` interface and makes it
> synchronous. Reason: every object in Petri is a canonical JSON value, and a
> `Buffer` interface would let a caller store bytes whose hash nothing can
> recompute. Synchronous, because every call is a small local file and an async
> boundary here infects every caller for no gain.

---

## 8. The consensus log

### 8.1 `src/consensus/log.ts`

```ts
import type { SignedEnvelope } from '../trust/envelope.js';
import type { PetriMessage } from './messages.js';

/**
 * One entry in the consensus log. The shape is identical for Hedera and for the
 * local file. Replay cannot tell the two apart, except through `source`.
 */
export interface LogEntry {
  chain: string;           // hcs: the running hash, as hex. local: our own sha256 chain.
  consensusNanos: string;  // Decimal nanoseconds since the epoch. Exactly 19 digits.
  envelope: SignedEnvelope<PetriMessage>;
  payer: string;           // hcs: the payer account id. local: "local".
  seq: number;             // A per-topic sequence number. 1-based. Gap-free.
  source: 'hcs' | 'local';
  topic: string;           // hcs: "0.0.5551234". local: "local:<treeId>".
}

export interface PublishReceipt {
  seq: number; source: 'hcs' | 'local'; topic: string; txId: string;
}

export interface ConsensusLog {
  readonly kind: 'hcs' | 'local';
  readonly topic: string;
  publish(body: PetriMessage): Promise<PublishReceipt>;
  read(afterSeq?: number): AsyncIterable<LogEntry>;
  /** The honest one-line trust label. The CLI MUST print this. */
  trustLabel(): string;
  close(): Promise<void>;
}

/** Inside one topic, `seq` IS the total order. Hedera assigns it in consensus order. */
export const orderKey = (e: LogEntry): string =>
  `${e.topic}:${String(e.seq).padStart(12, '0')}`;

/** Parse "1789201331.867291917" with no loss. NEVER use parseFloat here. */
export function parseConsensusTimestamp(ts: string): string {
  const m = /^(\d+)\.(\d{1,9})$/.exec(ts);
  if (!m) throw new Error(`bad consensus timestamp: ${ts}`);
  const nanos = BigInt(m[1]!) * 1_000_000_000n + BigInt(m[2]!.padEnd(9, '0'));
  return nanos.toString().padStart(19, '0'); // Width 19 keeps a lexical sort valid to 2262.
}

export function formatConsensusTimestamp(nanos: string): string {
  const n = BigInt(nanos);
  return `${n / 1_000_000_000n}.${String(n % 1_000_000_000n).padStart(9, '0')}`;
}

export function openLog(cfg: PetriConfig, identity: Identity): ConsensusLog {
  if (cfg.ledger === 'local' || !cfg.hedera) return new LocalLog(cfg.treeId, identity);
  return new HederaLog(cfg.hedera.topicId, cfg.hedera.network,
    makeClient(cfg.hedera.network, cfg.hedera.operatorId), identity);
}
```

`parseFloat` is banned here, and the reason is measured.
`parseFloat("1757656789.123456789")` gives `1757656789.1234567`. Two digits are
gone. Two messages in the same 100 nanoseconds would then collide.

> **Reconciled.** One design added a second ordering key, a fixed-width string with
> a `c` prefix for anchored events and an `l` prefix for pending ones, plus an epoch
> counter. Petri removes it. The local log already assigns gap-free sequence numbers
> in both modes, so there is no pending state that needs a second key space. One
> ordering mechanism, `LogEntry.seq`, with `consensusNanos` to merge across topics.

### 8.2 What goes on-chain, and what stays local

HCS caps one chunk at 1024 bytes. The SDK splits a longer message into chunks, and
each chunk is a separate paid transaction. Petri never sends a diff.

| On the chain | In the local object store |
|---|---|
| Node id, parent id, bench id | The manifest bytes, the detail bytes |
| The hypothesis, at most 240 escaped bytes | The harness snapshot, the patch, the diff |
| Report id, both medians, the delta, the run count | The full verification report |
| The spread, the clean flag, the env hash | Every per-run raw result |
| A status claim and its reason, at most 200 bytes | Logs, traces, token counts |

**The chain holds commitments. The store holds evidence.** A hash on the chain lets
anyone check that the bytes they fetched are the bytes the author signed.

The hypothesis is the exception. Design rule 4 says every node must state a
hypothesis in plain English, so the hypothesis goes on the chain in full. One text,
one place, no chance of two versions.

### 8.3 `src/consensus/messages.ts` — the exact HCS schemas

```ts
import { z } from 'zod';
import { Hex64, ParentRef, TreeId, ModeSchema, byteLen } from '../core/schema.js';

export const NodeSubmitted = z.strictObject({
  bench:  Hex64,
  hyp:    z.string().min(12).refine(byteLen(240), 'hypothesis over 240 escaped bytes'),
  node:   Hex64,     // The node id. It equals contentId(manifest).
  parent: ParentRef,
  tree:   TreeId,
  type:   z.literal('NodeSubmitted'),
});

export const VerificationSigned = z.strictObject({
  candMedianBp:   z.int().min(0).max(10000),
  clean:          z.boolean(),      // No run was tampered, timed out as infra, or discarded short.
  deltaMedianBp:  z.int().min(-10000).max(10000),
  envHash:        Hex64,            // contentId(report.env)
  mode:           ModeSchema,
  node:           Hex64,
  parent:         ParentRef,
  parentMedianBp: z.int().min(0).max(10000),
  report:         Hex64,            // contentId(report)
  runs:           z.int().min(3).max(99),
  spreadBp:       z.int().min(0).max(10000),  // max minus min of candidate.runs[].scoreBp
  tree:           TreeId,
  type:           z.literal('VerificationSigned'),
});

export const StatusChanged = z.strictObject({
  node:      Hex64,
  reason:    z.string().min(1).refine(byteLen(200), 'reason over 200 escaped bytes'),
  status:    z.enum(['accepted', 'rejected', 'contested', 'withdrawn', 'superseded']),
  tree:      TreeId,
  type:      z.literal('StatusChanged'),
  verifiers: z.array(Hex64).max(4),   // The keys the publisher counted.
});

export const PetriMessage = z.discriminatedUnion('type',
  [NodeSubmitted, VerificationSigned, StatusChanged]);

export type NodeSubmitted = z.infer<typeof NodeSubmitted>;
export type VerificationSigned = z.infer<typeof VerificationSigned>;
export type StatusChanged = z.infer<typeof StatusChanged>;
export type PetriMessage = z.infer<typeof PetriMessage>;
```

`z.strictObject` rejects unknown keys. An unknown key would change the signed bytes,
so it must be a hard error.

**Measured worst-case envelope sizes**, with a 64-character tree id, every hex field
full, the hypothesis at its 240-byte cap and the reason at its 200-byte cap:

| Message | Bytes | Headroom under 1024 |
|---|---|---|
| `NodeSubmitted` | **797** | 227 |
| `VerificationSigned` | **749** | 275 |
| `StatusChanged`, 4 verifiers | **911** | 113 |

`HederaLog.publish` asserts the 1024-byte limit and refuses to send anything larger.

> **Reconciled.** One design put `diff` (a hash of the patch bytes) inside the node
> id and on the wire. Petri removes it from both. Reason: a diff depends on the
> algorithm and the context-line count, so hashing it would make the node id
> implementation-dependent. That is the exact failure this whole project exists to
> prevent. The diff is fully derivable from two content-addressed harness snapshots,
> and `petri fsck` check 8 regenerates it and warns on a mismatch. The manifest
> commits to `harness` and `detail` instead.

> **Reconciled.** The same design capped `verifiers` at 8 in `StatusChanged`. That
> measures 1125 bytes and **does not fit one chunk**. Petri caps it at 4, which
> measures 911. The cap is on the advisory message only, not on how many
> verifications a node may hold.

> **Reconciled.** `NodeSubmitted` does not carry `harness` or `detail`. Both live
> inside the manifest, which `node` already commits to. Adding them measured 896 to
> 950 bytes, which left too little headroom for a future field.

### 8.4 Wire examples

**`NodeSubmitted`**, the body, canonicalised:

```json
{"bench":"aa80a75294768bd3bc81ed688e6fd0b4ea2741b68c3508fa37b023f1d70b5cb8","hyp":"Because the prompt sends only symbol names, sending full signatures will raise the median by at least 500bp.","node":"a3572a8d3168357ad34c4afbebc65a4f55ccfa2c0bc5f157d4f65391dea75fa4","parent":"a5966c17a7d5ee36571983655df9c4c7e168b7602b90ae0b373d10b6b51e78a6","tree":"petri-main","type":"NodeSubmitted"}
```

**`VerificationSigned`**:

```json
{"candMedianBp":7500,"clean":true,"deltaMedianBp":1500,"envHash":"c41e…","mode":"replay","node":"a3572a8d…","parent":"a5966c17…","parentMedianBp":6000,"report":"ee768526…","runs":5,"spreadBp":500,"tree":"petri-main","type":"VerificationSigned"}
```

**`StatusChanged`**:

```json
{"node":"a3572a8d…","reason":"2 independent verifications, both at or above +1000bp","status":"accepted","tree":"petri-main","type":"StatusChanged","verifiers":["a09aa5f4…","17cb79fb…"]}
```

Each goes on the wire inside the envelope:

```json
{"body":{ … },"pub":"d04ab232…","sig":"38ce1b0a…","ver":1}
```

### 8.5 `StatusChanged` is advisory

Replay recomputes every status from `NodeSubmitted` and `VerificationSigned` alone.
When a `StatusChanged` disagrees with the computed status, replay keeps the computed
value and flags the node `disputed`.

Two statuses are exceptions, because nobody can derive them. `withdrawn` and
`superseded` are statements by the author. Replay honours those two only when the
envelope `pub` equals the node author key.

### 8.6 The local log

`<repo>/src/consensus/local.ts`

The log path is NEVER a constant in this file. A hard-coded path sends every tree on
the machine to one log. `LocalLog` takes `path` and `lockPath` as required arguments,
and `openLog()` derives both from `--root` through `logPath(root)` and `lockPath(root)`
in `src/store/paths.ts`. Error messages name the log file in full, because two trees on
one machine both hold a `.petri/log.jsonl`.

```ts
/** The local analogue of the Hedera running hash. It makes a deletion detectable. */
const chainSeed = (treeId: string): string => sha256Hex(`petri/chain/1|${treeId}`);

const nextChain = (prevChain: string, seq: number, consensusNanos: string, envelope: Canon): string =>
  sha256Hex(Buffer.concat([
    Buffer.from(prevChain, 'hex'),
    canonicalBytes({ consensusNanos, envelope, seq }),
  ]));
```

`LocalLog.publish` takes an exclusive lock on `log.lock`, appends one canonical JSON
line, and calls `fsyncSync`. It forces `consensusNanos` to increase, even when the
wall clock moves backwards.

`LocalLog.read` checks three things on every entry, and throws on any failure:

1. `seq` increases by exactly 1. A gap means lines were removed.
2. `chain` reproduces. A mismatch means the file was edited.
3. The envelope signature verifies.

Error text, exactly:

```
petri: .petri/log.jsonl jumps from sequence 13 to 15. Lines were removed.
petri: .petri/log.jsonl hash chain breaks at sequence 14. The log was edited.
petri: .petri/log.jsonl sequence 14 has a bad signature.
```

### 8.7 The Hedera log

`<repo>/src/consensus/hedera.ts`

```ts
export const HCS_CHUNK_BYTES = 1024;
export type HederaNetwork = 'testnet' | 'mainnet' | 'previewnet';
export const MIRROR_REST: Record<HederaNetwork, string> = {
  mainnet: 'https://mainnet.mirrornode.hedera.com',
  previewnet: 'https://previewnet.mirrornode.hedera.com',
  testnet: 'https://testnet.mirrornode.hedera.com',
};
```

**The topic is created with NO admin key and NO submit key.** Anyone may post, so
verification is permissionless. Nobody can delete or edit the topic, including the
person who created it. That makes design rule 3 a property of the network, not a
policy. The topic memo is `petri/v1 tree=<treeId>`, which must stay under 100 bytes.

`publish` returns only a receipt: `seq` and `txId`. **Every read goes through the
mirror node, including the author's own.** The local view and a stranger's view can
therefore never drift apart. The cost is a delay of a few seconds before a new
message appears in `petri replay`.

`operatorKeyFromEnv()` reads `HEDERA_OPERATOR_KEY` and tries DER, then ED25519, then
ECDSA parsing. The key is never written to `config.json`.

### 8.8 The mirror reader

```
GET {mirrorRest}/api/v1/topics/{topicId}/messages?limit=100&order=asc&sequencenumber=gt:{lastSeq}
```

Measured facts about the live mirror API:

- `message` is standard base64 with padding.
- `chunk_info` is `null` for a single-chunk message.
- `sequencenumber=gt:N` works and combines with `order=asc`.
- `limit` maxes out at 100. A request for 101 silently returns 100.
- `links.next` is a relative path, not an absolute URL.

Petri drives pagination with `sequencenumber=gt:` and ignores `links.next`. A
sequence number is a cursor Petri can persist in `cursor.json`. A path is not.

**The mirror reader never throws on bad content.** The topic is permissionless, so
anyone can post garbage. Garbage is counted in `MirrorStats` and skipped. Only a
network or HTTP failure throws. A replay that crashes on one bad message is a
denial-of-service hole.

```ts
export interface MirrorStats {
  accepted: number;
  badSignature: number;
  malformed: number;  // Not UTF-8, not JSON, or not a Petri message.
  oversized: number;  // It arrived in more than one chunk.
  pending: number;    // Chunks still waiting for their siblings.
}
```

The reader reassembles a multi-chunk message by
`chunk_info.initial_transaction_id`. Petri never writes one, but the topic is
permissionless, so somebody else can.

### 8.9 The trust banner

`src/cli/banner.ts` prints this before every result. There is no flag to hide it.

`ledger: local`:

```
TRUST  local log <repo>/.petri/log.jsonl  —  UNVERIFIED
  This log is on this machine only. It proves nothing about independence.
  One person can hold every key in it. The file can be edited or deleted.
  Only a Hedera topic proves order, time and non-deletion to a stranger.
  Run `petri topic create` to publish to a real topic.
```

`ledger: hcs`:

```
TRUST  hedera topic 0.0.5551234 (testnet)  —  PUBLIC
  Anyone can rebuild this tree:
    pnpm petri replay --topic 0.0.5551234 --network testnet
  A topic proves order, time and non-deletion. It does not prove that two keys
  are two people, and it does not prove a verifier ran the benchmark.
```

`mode: replay` adds one more block:

```
MODE   replay  —  this is NOT a new measurement
  Replay re-runs recorded harness outputs through the real sandbox.
  The tests genuinely execute. The harness does not call a model.
  A replay number can never be compared against a live number.
```

Every status line carries the same label, so a screenshot cannot hide it:

```
a3572a8d  accepted   delta +1500bp   verifiers 2   mode replay   trust local-unverified
7b30eec1  contested  delta +1500/-900bp  verifiers 2  mode live  trust hcs
```

Machine-readable exports carry `"trust"` and `"mode"` at the top level.

### 8.10 What the local log proves, and what it does not

| Property | Local log | Hedera topic |
|---|---|---|
| **Authorship** — a key signed this | Yes. The signature is real. | Yes |
| **Integrity** — the bytes did not change | Yes, through the hash chain | Yes |
| **Non-deletion** — nothing was removed | **No.** Delete the file and the chain restarts. | **Yes** |
| **Time** — when this happened | **No.** The clock is yours to set. | **Yes** |
| **Independence** — two keys are two people | **No** | **No.** See §18.2. |

---

## 9. The acceptance rule

`<repo>/src/policy/acceptance.ts`

This is a pure function. It does no I/O. It reads no clock. It uses no randomness.
The same inputs give the same decision on every machine, forever.

### 9.1 Inputs

```ts
import type { VerificationSigned } from '../consensus/messages.js';
import type { Policy } from '../config.js';
import type { Mode, NodeStatus } from '../core/schema.js';

export interface CountedVerification {
  /** The VERIFIER public key, taken from the envelope. NEVER from the body. */
  pub: string;
  msg: VerificationSigned;
  seq: number;
}

export interface NodeFacts {
  nodeId: string;
  /** The pub of the FIRST NodeSubmitted for this node. */
  author: string;
  bench: string;
  mode: Mode;
  parent: string;
  /** Keyed by verifier public key. The FIRST message from a key wins. */
  verifications: Map<string, CountedVerification>;
  withdrawn: boolean;   // Set only by a StatusChanged signed by `author`.
  superseded: boolean;  // Set only by a StatusChanged signed by `author`.
}
```

### 9.2 Output

```ts
export type DecisionCode =
  | 'ROOT_BASELINE' | 'WIN'
  | 'REGRESSION' | 'WITHIN_NOISE'
  | 'INSUFFICIENT_VERIFICATIONS' | 'RUNS_TOO_NOISY' | 'RUNNERS_DISAGREE'
  | 'CONTESTED' | 'NOT_CLEAN'
  | 'WITHDRAWN' | 'SUPERSEDED';

export interface Verdict {
  status: NodeStatus;
  code: DecisionCode;
  /** Plain English. Safe to print straight to a terminal. */
  reason: string;
  /** The agreed delta in basis points, or null when it could not be computed. */
  deltaBp: number | null;
  /** The public keys that counted. */
  counted: string[];
  /** Every verification that did not count, and why. */
  ignored: { pub: string; why: string }[];
}
```

### 9.3 The function

```ts
const fmtBp = (bp: number): string => `${bp >= 0 ? '+' : ''}${bp}bp`;
const short = (k: string): string => k.slice(0, 8);

export function evaluate(node: NodeFacts, policy: Policy): Verdict {
  const none = { counted: [], ignored: [], deltaBp: null };
  if (node.withdrawn) {
    return { ...none, status: 'withdrawn', code: 'WITHDRAWN', reason: 'Withdrawn by the author.' };
  }
  if (node.superseded) {
    return { ...none, status: 'superseded', code: 'SUPERSEDED', reason: 'Superseded by the author.' };
  }

  // 1. Keep only the verifications that count.
  const counted: CountedVerification[] = [];
  const ignored: { pub: string; why: string }[] = [];

  for (const v of node.verifications.values()) {
    // Design rule 1. The author can never accept their own node.
    if (v.pub === node.author) {
      ignored.push({ pub: v.pub, why: 'self-verification: the signer is the node author' }); continue;
    }
    if (v.msg.node !== node.nodeId) {
      ignored.push({ pub: v.pub, why: 'the report is for another node' }); continue;
    }
    if (v.msg.parent !== node.parent) {
      ignored.push({ pub: v.pub, why: 'the verifier re-ran the wrong parent' }); continue;
    }
    if (v.msg.mode !== node.mode) {
      ignored.push({ pub: v.pub, why: `mode ${v.msg.mode} cannot support a ${node.mode} node` }); continue;
    }
    if (v.msg.runs < policy.minRuns) {
      ignored.push({ pub: v.pub, why: `only ${v.msg.runs} runs, the minimum is ${policy.minRuns}` }); continue;
    }
    if (v.msg.runs % 2 === 0) {
      ignored.push({ pub: v.pub, why: 'an even run count has no unique median' }); continue;
    }
    if (policy.trustedRunners.length > 0 && !policy.trustedRunners.includes(v.pub)) {
      ignored.push({ pub: v.pub, why: 'the runner is not on the trusted list for this tree' }); continue;
    }
    counted.push(v);
  }
  // Two verifications from ONE key already collapse: `verifications` is a Map keyed by
  // public key, and replay inserts only the first message from each key, by sequence.

  const keys = counted.map((v) => v.pub);

  // 2. A dirty batch disqualifies the node. Tampering is not a score.
  const dirty = counted.filter((v) => !v.msg.clean);
  if (dirty.length > 0) {
    return {
      status: 'rejected', code: 'NOT_CLEAN', deltaBp: null, counted: keys, ignored,
      reason: `${dirty.length} verification(s) reported an unclean batch. A tampered or `
        + `incomplete run cannot support a node. Runners: ${dirty.map((v) => short(v.pub)).join(', ')}.`,
    };
  }

  if (counted.length < policy.minVerifications) {
    return {
      status: 'pending', code: 'INSUFFICIENT_VERIFICATIONS', deltaBp: null, counted: keys, ignored,
      reason: `${counted.length} of ${policy.minVerifications} independent verifications. `
        + `The author's own runs never count.`,
    };
  }

  // 3. Refuse to judge a measurement that is too noisy to mean anything.
  for (const v of counted) {
    if (v.msg.spreadBp > policy.maxRunSpreadBp) {
      return {
        status: 'pending', code: 'RUNS_TOO_NOISY', deltaBp: null, counted: keys, ignored,
        reason: `Runner ${short(v.pub)} scored a spread of ${v.msg.spreadBp}bp over ${v.msg.runs} `
          + `runs, above the limit of ${policy.maxRunSpreadBp}bp. The median is not trustworthy. `
          + `Raise the run count and verify again.`,
      };
    }
  }

  // 4. Compare the verifiers with each other.
  const deltas = counted.map((v) => v.msg.deltaMedianBp);
  const lo = Math.min(...deltas);
  const hi = Math.max(...deltas);
  const span = hi - lo;

  const anyWin = hi >= policy.minDeltaBp;
  const anyLoss = lo <= -policy.minDeltaBp;

  if (anyWin && anyLoss) {
    return {
      status: 'contested', code: 'CONTESTED', deltaBp: null, counted: keys, ignored,
      reason: `The verifiers disagree on the sign. Deltas: `
        + `${counted.map((v) => `${short(v.pub)} ${fmtBp(v.msg.deltaMedianBp)}`).join(', ')}. `
        + `This node is neither accepted nor rejected. The disagreement is on the record.`,
    };
  }

  if (span > policy.maxRunnerDisagreementBp) {
    return {
      status: 'pending', code: 'RUNNERS_DISAGREE', deltaBp: null, counted: keys, ignored,
      reason: `The verifier deltas span ${span}bp (${deltas.join(', ')}), above the limit of `
        + `${policy.maxRunnerDisagreementBp}bp. One machine differs from the others. `
        + `A further independent verification is required.`,
    };
  }

  // 5. Decide. Every counted verifier must clear the margin on its own.
  //    The reported delta is the most conservative one.
  const isRoot = node.parent === 'root';

  if (lo >= policy.minDeltaBp) {
    return {
      status: 'accepted', code: isRoot ? 'ROOT_BASELINE' : 'WIN', deltaBp: lo, counted: keys, ignored,
      reason: isRoot
        ? `Root baseline set at ${fmtBp(lo)} over the empty harness, by ${counted.length} `
          + `independent runners. Every runner cleared the ${policy.minDeltaBp}bp margin.`
        : `${counted.length} independent verifications, every one at or above `
          + `+${policy.minDeltaBp}bp. Worst delta ${fmtBp(lo)}. This is a real improvement.`,
    };
  }

  if (hi <= -policy.minDeltaBp) {
    return {
      status: 'rejected', code: 'REGRESSION', deltaBp: hi, counted: keys, ignored,
      reason: `${counted.length} independent verifications, every one at or below `
        + `-${policy.minDeltaBp}bp. Best delta ${fmtBp(hi)}. This is a measured regression. `
        + `The change makes the harness worse.`,
    };
  }

  return {
    status: 'rejected', code: 'WITHIN_NOISE', deltaBp: lo, counted: keys, ignored,
    reason: `Deltas ${deltas.map(fmtBp).join(', ')} sit inside the ${policy.minDeltaBp}bp noise `
      + `band. That is a tie, not a regression. The change showed no measurable effect. `
      + `The node stays in the tree so nobody retries it.`,
  };
}
```

### 9.4 Rule 1 is enforced three times

1. **At signing time.** `petri verify` refuses to run when `manifest.author`
   equals your own runner id. It prints:
   `petri: you are the author of a3572a8d. You cannot verify your own node.`
   It exits 4.
2. **At counting time.** `evaluate` drops any verification whose signer equals the
   author, and records it in `ignored`.
3. **At replay time.** The verifier key comes from the envelope, which the signature
   check covers. It is never read from the message body.

Duplicate keys collapse because `verifications` is a `Map` keyed by public key,
filled first-wins by sequence number. **One key is one vote, forever**, no matter
how many messages it sends.

### 9.5 Ties are rejected, not hidden

A delta strictly inside the band is `rejected` with code `WITHIN_NOISE`. The status
enum does not grow a fourth value for it. The nuance lives in the machine-readable
`DecisionCode` and in a reason string that says plainly it is a tie.

A tie is not a failure of the idea. It is a measurement that found nothing. Design
rule 3 keeps it in the tree so nobody retries it.

### 9.6 Replay nodes can be accepted, inside a replay tree

> **Reconciled.** One design made `accepted` unreachable for any node measured in
> replay mode, on the ground that replay re-runs recorded harness outputs and
> therefore measures nothing new. That is true, and Petri keeps every one of its
> safeguards: `mode` is a required field on every record; `mode` is inside the
> signed report, so editing it breaks every signature; and `evaluate` refuses to
> count a verification whose mode differs from the node's mode, in both directions.
>
> Petri still lets a replay node reach `accepted`. Reason: design rule 6 says a
> judge must clone the repo and run the whole machine with no keys. A demonstration
> in which acceptance can never fire does not demonstrate the acceptance rule, which
> is the centre of the project. The honest framing is carried by the banner in §8.9
> and by the `mode` label on every status line and every export, not by crippling
> the rule.
>
> A replay number and a live number can never be compared. That ban is absolute and
> it is enforced in `evaluate`, in `checkReport` and in the digest header.

### 9.7 Verified case table

Parent median is 6000 bp, which is 12 tasks out of 20. Margin is 1000 bp.

| Case | Result |
|---|---|
| no verifications | `pending` INSUFFICIENT_VERIFICATIONS |
| the author verifies their own node twice | `pending` INSUFFICIENT_VERIFICATIONS, 0 counted |
| one independent verifier only | `pending` INSUFFICIENT_VERIFICATIONS |
| one runner submits twice | `pending` INSUFFICIENT_VERIFICATIONS, 1 counted |
| two verifiers, deltas +1500 and +1500 | `accepted` WIN at +1500bp |
| two verifiers, deltas +1000 and +1200 | `accepted` WIN at +1000bp, the boundary |
| two verifiers, deltas +1500 and +500 | `pending` RUNNERS_DISAGREE, span 1000 is not over 1000 → `rejected` WITHIN_NOISE at +500 |
| two verifiers, deltas +500 and +500 | `rejected` WITHIN_NOISE |
| two verifiers, deltas 0 and 0 | `rejected` WITHIN_NOISE |
| two verifiers, deltas -2000 and -1500 | `rejected` REGRESSION at -1500bp |
| two verifiers, deltas +1500 and -1500 | `contested` CONTESTED |
| two verifiers, deltas +1500 and +200 | `pending` RUNNERS_DISAGREE, span 1300 |
| one verifier reports spreadBp 7000 | `pending` RUNS_TOO_NOISY |
| one verifier reports clean: false | `rejected` NOT_CLEAN |
| a third verification on a different bench | ignored; the decision stands on the other two |
| a verification in the wrong mode | ignored, with the reason recorded |
| a root node, two verifiers at +6000 | `accepted` ROOT_BASELINE |

Note row 7: span is exactly 1000, which is not greater than
`maxRunnerDisagreementBp`, so the guard does not fire. `lo` is 500, below the
margin, so the node is `rejected` WITHIN_NOISE. **The most conservative verifier
decides.** This is intended.

### 9.8 Replay, the reducer

`<repo>/src/consensus/replay.ts`

```ts
export interface ReplayNode extends NodeFacts {
  claims: { pub: string; seq: number; status: string }[]; // StatusChanged. Advisory.
  disputed: boolean;
  hypothesis: string;
  submittedNanos: string;
  submittedSeq: number;
  verdict: Verdict;
}

export interface ReplayResult {
  lastSeq: number;
  nodes: Map<string, ReplayNode>;
  skipped: { reason: string; seq: number }[];
  treeId: string;
}

export async function replay(
  entries: AsyncIterable<LogEntry>, treeId: string, policy: Policy,
): Promise<ReplayResult>;
```

Rules the reducer follows, in order:

1. An entry whose `body.tree` is not `treeId` is skipped and counted.
2. **The first `NodeSubmitted` for a node id wins.** A later duplicate is skipped.
   A front-runner cannot steal authorship of a node they did submit first, which is
   the residual risk in §18.7.
3. A `VerificationSigned` whose node is unknown is skipped and counted.
4. **The first `VerificationSigned` from one key wins.** A second is skipped.
5. A `StatusChanged` is appended to `claims`. It never sets a status. Only a
   `StatusChanged` signed by the node author can set `withdrawn` or `superseded`.
6. After the loop, `evaluate` runs on every node. `disputed` is true when a claim
   named a status other than the computed one, `withdrawn` and `superseded` aside.

The reducer is pure and deterministic. The same entries in the same order always
give the same result. It never throws on unexpected content.

---

## 10. The benchmark

Root: `<repo>/bench/`

Design rule 5: the benchmark is deterministic to score. Unit tests pass or fail.
There is no LLM judge.

### 10.1 Two different properties

1. **The harness must not see the tests when it writes the solution.** This is
   guaranteed by a type signature, not by a sandbox. `TaskView` carries no path and
   no directory handle. Nothing ever hands the harness a test.
2. **The solution must not read the tests when it runs.** This is a sandbox problem.
   A solution that reads `test.mjs` would pass every task.

Three approaches to the second property were tried and rejected:

| Attempt | Result |
|---|---|
| `node --test file.mjs` with `--permission` | **Fails.** The test runner spawns one child per file. The permission model denies it: `ERR_ACCESS_DENIED … Use --allow-child-process`. |
| Put `test.mjs` outside `--allow-fs-read` and pass it as the entry point | **Fails in silence.** Node grants the entry point an implicit read. A solution reads its own spec with `fs.readFileSync(import.meta.filename)`. |
| `process.permission.deny()` at runtime | **Does not exist.** Node 26 exposes only `process.permission.has`. |

**The design that works: the test source is never written to disk.** The runner
reads `test.mjs` into memory in the parent, embeds it in a bootstrap program, and
pipes that program to the child over **stdin**. A `module.registerHooks` load hook
serves the test source at a *virtual* `file://` URL inside the solution directory.
A relative import such as `./solution.mjs` resolves normally, but the spec file does
not exist on disk.

### 10.2 Directory layout

```
<repo>/bench/
├── tasks/
│   ├── 01-chunk-array/
│   │   ├── task.json        TaskMeta.               §10.3
│   │   ├── PROMPT.md        The ONLY text the harness sees.
│   │   ├── test.mjs         NEVER reaches the harness. NEVER written to disk at run time.
│   │   ├── starter/         Optional. Read-only context files for TaskView.starterFiles.
│   │   └── answers/         Graded answers for the replay model client. §11.5
│   │       ├── correct.mjs
│   │       ├── off_by_one.mjs
│   │       ├── missing_edge_case.mjs
│   │       ├── wrong_api.mjs
│   │       └── syntax_error.mjs
│   └── … 20 task directories in total
├── RULES.md                 What the replay model client rewards. Published on purpose.
├── fixtures/
│   ├── index.json
│   └── <harnessId>/<taskId>/<attemptIndex>.json
└── src/                     §15
```

### 10.3 `task.json`

```ts
// <repo>/bench/src/schema.ts
import { z } from 'zod';

export const TaskMetaSchema = z.strictObject({
  specVersion: z.literal(1),
  id: z.string().regex(/^\d{2}-[a-z0-9-]+$/),
  title: z.string().min(8).max(90),
  difficulty: z.enum(['easy', 'medium', 'hard']),
  entry: z.string().regex(/^[a-z0-9-]+\.mjs$/),
  exports: z.array(z.string().regex(/^[A-Za-z_$][\w$]*$/)).min(1),
  signatures: z.array(z.string().min(3).max(300)).min(1),
  timeoutMs: z.int().min(1000).max(60000),
  testCount: z.int().min(1),
  tags: z.array(z.string()).default([]),
});
export type TaskMeta = z.infer<typeof TaskMetaSchema>;
```

Two invariants that `taskLoader.ts` enforces, throwing on failure:

- `id` must equal the directory name.
- `testCount` must equal the number of top-level `test(…)` calls in `test.mjs`.
  Deleting a test would otherwise weaken the benchmark in silence.

`signatures` and `exports` are the same length and in the same order.

The bench id is `contentId(BenchSpec)`, where `BenchSpec.tasks[i].testsId` is
`contentId({ protocol: 'petri/tests/1', source: <test.mjs text> })`. Editing one
test therefore changes the bench id, and every older node then names a benchmark
that no longer exists. **Treat tasks as append-only after the first accepted node.**

### 10.4 Worked example, complete

**`<repo>/bench/tasks/01-chunk-array/task.json`**

```json
{
  "specVersion": 1,
  "id": "01-chunk-array",
  "title": "Chunk an array into fixed-size groups",
  "difficulty": "easy",
  "entry": "solution.mjs",
  "exports": ["chunk"],
  "signatures": ["export function chunk(input: unknown[], size: number): unknown[][]"],
  "timeoutMs": 5000,
  "testCount": 10,
  "tags": ["arrays", "validation", "edge-cases"]
}
```

**`<repo>/bench/tasks/01-chunk-array/PROMPT.md`**

````markdown
# Chunk an array into fixed-size groups

Write a file named `solution.mjs`. Export one named function, `chunk`.

## Signature

```js
export function chunk(input, size) { /* ... */ }
```

## Behaviour

`chunk` splits `input` into consecutive groups of `size` elements.
It returns an array of arrays. The last group holds the remainder.
It may be shorter than `size`.

```js
chunk([1, 2, 3, 4], 2)     // [[1, 2], [3, 4]]
chunk([1, 2, 3, 4, 5], 2)  // [[1, 2], [3, 4], [5]]
chunk([1, 2], 5)           // [[1, 2]]
chunk([], 3)               // []
```

## Rules

1. Do not change `input`. The caller keeps using it.
2. Return new arrays. Do not return views into `input`.
3. If `input` is not an array, throw a `TypeError`.
4. If `size` is not an integer, or is less than 1, throw a `RangeError`.
5. Use no imports. Use no I/O.

## Output format

Write only the file `solution.mjs`. Use ESM syntax. Export the symbol `chunk`.
````

**`<repo>/bench/tasks/01-chunk-array/test.mjs`**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { chunk } from './solution.mjs';

test('splits evenly', () => {
  assert.deepEqual(chunk([1, 2, 3, 4], 2), [[1, 2], [3, 4]]);
});

test('keeps a short final group', () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
});

test('size larger than the array', () => {
  assert.deepEqual(chunk([1, 2], 5), [[1, 2]]);
});

test('empty input gives an empty array', () => {
  assert.deepEqual(chunk([], 3), []);
});

test('does not mutate the input', () => {
  const src = [1, 2, 3];
  chunk(src, 2);
  assert.deepEqual(src, [1, 2, 3]);
});

test('groups are copies, not views', () => {
  const src = [{ a: 1 }];
  const out = chunk(src, 1);
  out[0].push({ a: 2 });
  assert.equal(src.length, 1);
});

test('rejects a size of zero', () => {
  assert.throws(() => chunk([1, 2], 0), RangeError);
});

test('rejects a negative size', () => {
  assert.throws(() => chunk([1, 2], -1), RangeError);
});

test('rejects a non-integer size', () => {
  assert.throws(() => chunk([1, 2], 1.5), RangeError);
});

test('rejects a non-array input', () => {
  assert.throws(() => chunk('abc', 2), TypeError);
});
```

`test.mjs` imports `./solution.mjs` as a plain relative path. A human can copy the
directory, drop in a solution, and run `node --test`. The sandbox does not change
how the file is authored.

**This example separates harnesses.** Three solutions were run through the real
runner:

| Solution | Outcome | Tests |
|---|---|---|
| Full validation | `pass` | 10 / 10 |
| Throws a plain `Error`, not `TypeError` or `RangeError` | `fail` | 6 / 10 |
| No validation at all | `crash`, SIGABRT | `size=0` loops forever, then V8 runs out of heap |

### 10.5 Solutions are JavaScript, not TypeScript

> **Reconciled.** One design wrote the benchmark tasks in TypeScript with a
> `task.yaml` and a `tests/` directory. Another wrote them in JavaScript with a
> `task.json` and a single `test.mjs`. Petri takes the **JavaScript** layout.
> Reason: the sandbox runs the solution directly under `node --permission` with no
> build step and no `node_modules`. Adding `tsx` inside the sandbox would need
> `--allow-child-process` and a wide `--allow-fs-read`, which destroys the sandbox.
> Petri's own source stays TypeScript. The benchmark's solutions are JavaScript.
> `TaskView.language` is therefore `'javascript'`.

### 10.6 The sandbox

`<repo>/bench/src/sandbox.ts`

```ts
export type Outcome =
  | 'pass' | 'fail' | 'timeout' | 'crash' | 'tampered' | 'no_attestation';

export interface SandboxResult {
  outcome: Outcome;
  passed: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  assertions: { pass: number; fail: number } | null;
  wallMs: number;
  stderrTail: string;
}

export function runInSandbox(opts: {
  solutionSource: string;
  entry: string;
  specSource: string;
  timeoutMs: number;
}): Promise<SandboxResult>;
```

**The exact child invocation:**

```
<node> --input-type=module
       --permission
       --allow-fs-read=<realpath(workdir)>/sol/*
       --no-warnings
       --disable-proto=throw
       --max-old-space-size=512
```

- `cwd` is `<workdir>/sol`.
- `env` is `{ PATH: '', HOME: <solDir>, NODE_OPTIONS: '', TZ: 'UTC', LANG: 'C' }`.
  `ANTHROPIC_API_KEY` is never in the test process.
- `stdio` is `['pipe', 'pipe', 'pipe', 'pipe']`. File descriptor 3 carries the
  attestation.
- `timeout` is `task.timeoutMs`. `killSignal` is `SIGKILL`.
- **The program itself is written to stdin.** It is never a file and never in `argv`.

Two traps, both closed, both load-bearing:

- **The macOS symlink.** `os.tmpdir()` returns `/var/…`, which resolves to
  `/private/var/…`. Node matches the permission scope against the **resolved** path.
  The runner calls `realpathSync` on the workdir. Without it every task fails with
  `ERR_ACCESS_DENIED`, which reads like a bad harness rather than a broken sandbox.
- **The stdin cwd grant.** A program read from stdin gets an implicit read grant
  over the **cwd subtree**. With the default cwd that leaks the whole repo. Setting
  `cwd` to the solution directory makes the implicit grant equal the intended scope.

**What `--permission` denies by default:** `--allow-net`, `--allow-child-process`,
`--allow-worker`, `--allow-addons`, `--allow-inspector` and `--allow-fs-write` are
all absent, so all are denied. Only `fs.read` under `<solDir>/*` is granted.

| Probe from inside a solution | Result |
|---|---|
| `fs.readFileSync('/etc/hosts')` | `ERR_ACCESS_DENIED` |
| `fs.readdirSync('/')` | `ERR_ACCESS_DENIED` |
| `fs.writeFileSync(<solDir>/evil.txt)` | `ERR_ACCESS_DENIED` |
| `child_process.execSync('cat /etc/hosts')` | `ERR_ACCESS_DENIED` |
| `net.createConnection(443, '1.1.1.1')` | `ERR_ACCESS_DENIED` on connect |
| read the spec at its virtual path | `ENOENT`. It is not on disk at all. |

**The bootstrap program**, built by `buildBootstrap(specSource, virtPath, nonce)`,
does five things before the solution loads:

1. It registers a resolve and load hook that serves `specSource` at `virtPath`.
2. It removes `process.exit`, `reallyExit`, `abort`, `kill` and `_kill`, so the
   solution cannot forge the exit code.
3. It freezes `Math.random` to a seeded LCG and `Date`, `Date.now` and
   `performance.now` to `1735689600000`, which is `2025-01-01T00:00:00.000Z`.
4. It runs the tests with `run({ files: [VPATH], isolation: 'none', concurrency: 1 })`
   and counts `test:pass` and `test:fail` events.
5. It writes one attestation line to file descriptor 3:
   `<nonce> {"pass":N,"fail":M}\n`, then exits through a saved `reallyExit`.

Three separate processes produced an identical RNG sequence and timestamp. A
solution that reaches for randomness or the clock therefore behaves the same on
every machine. It cannot pass by luck.

### 10.7 How pass and fail are read

**The exit code is the primary signal. stdout is drained and never parsed.**

The exit code alone is **not sufficient**, and this was proved. A solution that
contains `process.exit(0)` plus `process.reallyExit(0)` turns a failing run into
exit code 0.

So the verdict needs two channels that agree:

1. The child **exit code**.
2. The **attestation** on file descriptor 3. The nonce is a fresh UUID per task run.
   It exists only inside the bootstrap, which arrives over stdin. It is never on
   disk, never in `argv`, and never in `env`. The solution cannot learn it. The
   counts come from the `node:test` event stream, not from `process.exitCode`, so
   the solution cannot edit them.

A run counts as `pass` only when the exit code is 0 **and** the attestation is
present **and** `fail === 0` **and** `pass > 0`. Any disagreement between the two
channels is `tampered`.

| Solution | outcome | exit | signal | attestation |
|---|---|---|---|---|
| correct | `pass` | 0 | – | `{"pass":2,"fail":0}` |
| wrong answer | `fail` | 1 | – | `{"pass":0,"fail":2}` |
| throws at import | `fail` | 1 | – | `{"pass":0,"fail":1}` |
| syntax error | `fail` | 1 | – | `{"pass":0,"fail":1}` |
| infinite loop | `timeout` | – | SIGKILL | none |
| out of memory | `crash` | – | SIGABRT | none |
| **forges `process.exit(0)`** | **`fail`** | **1** | – | `{"pass":0,"fail":2}` |

Every one of these scores the task 0. None triggers a retry. They are all the
harness's fault.

`tampered` is special. It is evidence of an attempt to cheat. It sets
`RunResult.tampered`, the CLI prints a loud warning, and a batch containing any
`tampered` outcome publishes `clean: false`, which §9.3 turns into `NOT_CLEAN`.

> **Reconciled.** One design said to use the exit code alone and never parse
> stdout. Petri keeps both halves of that instruction: stdout is drained and never
> parsed, and the exit code is the primary signal. It adds the fd-3 attestation as
> a second channel, because a forged exit code was demonstrated. The added channel
> never touches stdout.

### 10.8 Scoring one run

```ts
// <repo>/bench/src/schema.ts
export interface TaskOutcome {
  taskId: string;
  outcome: Outcome;
  passed: boolean;
  exitCode: number | null;
  signal: string | null;
  assertions: { pass: number; fail: number } | null;
  wallMs: number;       // The sandbox child only.
  harnessMs: number;    // The time the harness took to write the file.
  tokens: number;       // Model tokens the harness spent on this task. 0 in replay.
}

export interface RunResult {
  protocol: 'petri/run/1';
  runId: string;          // uuid v4
  node: string;           // The node under measurement, or "root".
  harness: string;        // Hex64. The harness id.
  bench: string;          // Hex64. The bench id.
  mode: Mode;             // Required. No default.
  attemptIndex: number;   // 0-based, inside one median batch.
  seed: string;           // Hex64. seedFor(candidateNodeId, attemptIndex).
  startedAt: number;      // Unix milliseconds.
  passed: number;         // Tasks whose tests all passed.
  total: number;          // The task count.
  scoreBp: number;        // scoreBp(passed, total)
  tasks: TaskOutcome[];   // Length equals total. Ordered by taskId.
  tokens: number;         // The sum over tasks.
  wallMs: number;         // The whole run, harness time included.
  tampered: boolean;      // True when any task outcome was `tampered`.
  env: EnvDescriptor;
}
```

`RunResult` is stored in the object store. `RunRecord.resultId` is its content id.

`scoreDecimal` and the rational `{n, d}` are **not** part of any record. A decimal
may appear in terminal output. It is never compared and never hashed.

### 10.9 Repeats, the median, and crashes

Default `repeats` is 5. Set it with `--runs`. It must be odd.

**Score, tokens and wall time are each medianed on their own. Nothing is summed.**
Summing tokens would reward a harness for crashing early. The median describes one
typical run.

A crash is classified, and the two classes are handled differently.

**Class A — the harness's fault. It scores 0. It is never retried.**
The harness produced a bad solution, or the harness code itself threw. This covers
every sandbox outcome other than `pass`, a harness that returns an empty string, a
harness that returns non-ESM text, and any exception thrown inside `solve()`.

**Class B — infrastructure below the harness. It is discarded and retried.**
Only a closed list qualifies.

```ts
// <repo>/bench/src/runner.ts
const INFRA = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN',
  'EPIPE', 'ENOSPC', 'ENOMEM', 'EMFILE',
]);
export function isInfrastructure(e: unknown): boolean {
  const err = e as { status?: number; code?: string };
  if (typeof err?.status === 'number' && (err.status === 429 || err.status >= 500)) return true;
  return typeof err?.code === 'string' && INFRA.has(err.code);
}
```

**Anything not on the list is Class A. Uncertainty resolves to Class A.** This
biases against inflating a score, which is the correct direction for a benchmark
whose only asset is trust.

Rules:

- Class A scores 0. It is not retried and it is not discarded.
- Class B is discarded and retried, up to `maxRetries = 3` extra attempts per batch.
- Every discard is recorded permanently in `MedianResult.discarded[]`, with its reason.
- If fewer than `repeats` clean runs are collected, `incomplete` is true, the
  verification publishes `clean: false`, and the node cannot be accepted.

Scoring an HTTP 500 as zero would measure a provider's uptime, not harness design.
But silently discarding failures would hide real instability. A harness that trips
rate limits because it fans out to forty sub-agents **is** worse, and that must stay
visible. Recording every discard keeps both facts true at once.

```ts
// <repo>/bench/src/median.ts
export interface MedianResult {
  protocol: 'petri/median/1';
  node: string;
  harness: string;
  bench: string;
  mode: Mode;
  repeats: number;      // Clean runs used. Odd.
  attempted: number;    // Runs launched, retries included.
  runIds: string[];     // The clean runs, in attempt order.
  discarded: { attemptIndex: number; reason: string; runId: string | null }[];
  incomplete: boolean;
  tampered: boolean;
  medianBp: number;     // medianInt over the per-run scoreBp.
  spreadBp: number;     // max minus min of the per-run scoreBp.
  perTask: Record<string, { passed: number; of: number }>;
  medianTokens: number;
  medianWallMs: number;
  unstableTasks: string[];   // Tasks that did not give the same outcome in every repeat.
}
```

`unstableTasks` is the honest noise report. A node whose score rests on an unstable
task is visibly weaker than one whose tasks are all stable.

### 10.10 Replay mode

**Replay does not measure anything. It replays a measurement someone already took.**

Replay proves the protocol runs: the tree, the tasks, the sandbox, the median, the
signatures and the acceptance rule. It proves a judge can clone the repo and see the
whole machine work with no API key and no Hedera account.

It does **not** prove a harness is good.

Fixtures are keyed by `(harnessId, taskId, attemptIndex)`.

**`bench/fixtures/<harnessId>/01-chunk-array/0.json`**

```json
{
  "protocol": "petri/fixture/1",
  "harness": "88658e3e002e3c34a8a83b4d9f4fce37c5686015e38a373578cc74747ce8701d",
  "taskId": "01-chunk-array",
  "attemptIndex": 0,
  "source": "export function chunk(input, size) {\n  if (!Array.isArray(input)) throw new TypeError('input must be an array');\n  if (!Number.isInteger(size) || size < 1) throw new RangeError('size must be a positive integer');\n  const out = [];\n  for (let i = 0; i < input.length; i += size) out.push(input.slice(i, i + size));\n  return out;\n}\n",
  "tokens": 4599,
  "harnessMs": 5120,
  "recordedAt": "2026-09-12T10:04:11.000Z",
  "recordedFrom": { "runId": "0f2c…", "model": "claude-sonnet-5", "bench": "aa80a752…" },
  "contentHash": "1f0c…"
}
```

**`bench/fixtures/index.json`**

```json
{
  "protocol": "petri/fixtures.index/1",
  "generatedAt": "2026-09-12T10:30:00.000Z",
  "bench": "aa80a75294768bd3bc81ed688e6fd0b4ea2741b68c3508fa37b023f1d70b5cb8",
  "entries": [
    { "harness": "88658e3e…", "taskId": "01-chunk-array", "attempts": 5,
      "contentHashes": ["1f0c…", "4b7e…", "1f0c…", "9d02…", "1f0c…"] }
  ]
}
```

Five replay rules:

1. A fixture miss is a **hard error**. It never falls back to a live call. A silent
   fallback would let a replay batch borrow real numbers.
2. Each fixture's `contentHash` is checked against `source` on load. A mismatch
   aborts the run.
3. The recorded `tokens` and `harnessMs` are used as the cost and the harness time.
   They are not zeroed. Replay reproduces the recorded measurement faithfully.
4. **The sandbox runs for real.** Replay replaces only the harness call. The
   solution is written to a scratch directory, sandboxed, tested and attested.
5. If `index.json.bench` differs from the current bench id, the fixtures were
   recorded against different tasks. The run is refused for anything but display.

### 10.11 `petri bench doctor`

No measurement runs until all five checks pass.

1. `process.version` major is 26 or higher. The sandbox needs `--permission`,
   `module.registerHooks` and `run({ isolation: 'none' })`.
2. All 20 task directories parse against `TaskMetaSchema`, and `id` equals the
   directory name.
3. Each `test.mjs` has exactly `task.json.testCount` top-level `test(…)` calls.
4. A canary solution known to be correct scores 20/20. A canary known to be wrong
   scores 0/20. This catches a sandbox that silently passes everything.
5. A canary that tries to read its own spec gets `ENOENT`. A canary that reads
   `/etc/hosts` gets `ERR_ACCESS_DENIED`. The child `env.PATH` is asserted empty.

**Check 5 is the important one.** A benchmark whose sandbox has broken open still
produces confident numbers. Nothing else would notice.

### 10.12 The 20 tasks

All are pure functions. None uses the network, the filesystem, randomness or the
clock. Each `PROMPT.md` states its edge cases in prose. The trap is never hidden.
It is only easy to skim past. That is the point: the benchmark measures whether a
harness reads carefully.

| # | Directory | One line | Difficulty | What it separates |
|---|---|---|---|---|
| 01 | `01-chunk-array` | Split an array into groups of N. | easy | `size = 0` loops forever and kills the process. |
| 02 | `02-run-length-encode` | `encode`/`decode` that round-trip exactly. | easy | Digits in the input break the naive format. |
| 03 | `03-roman-numerals` | `toRoman`/`fromRoman` over 1–3999. | medium | Subtractive pairs both ways. `IIII` and `IC` are rejected. |
| 04 | `04-balanced-brackets` | True when `()[]{}` nest correctly. | easy | Brackets inside quoted strings must be ignored. |
| 05 | `05-deep-equal` | Compare two values deeply. | medium | `NaN` equals `NaN`. `+0` differs from `-0`. Circular refs must not hang. |
| 06 | `06-topological-sort` | A linear order, or throw on a cycle. | medium | Cycle detection, plus a deterministic tie-break. |
| 07 | `07-csv-parse` | Parse CSV into rows. | medium | Commas and newlines inside quotes. `""` escapes a quote. CRLF. |
| 08 | `08-semver-compare` | Return -1, 0 or 1 per semver precedence. | medium | Prerelease ranks below release. Numeric ids compare numerically. |
| 09 | `09-lru-cache` | `get`/`set` with a fixed capacity. | medium | `get` counts as a use. Capacity 0 stores nothing. |
| 10 | `10-debounce-clock` | A debouncer driven by an injected `tick(ms)`. | medium | Trailing versus leading edge. `cancel` and `flush`. |
| 11 | `11-interval-merge` | Collapse `[start,end]` pairs. | easy | `[1,2]` and `[2,3]` merge. Input is unsorted and must not be mutated. |
| 12 | `12-template-render` | Substitute `{{dotted.path}}`. | medium | A missing key throws. `\{{` escapes a literal brace. |
| 13 | `13-line-diff` | A `keep`/`add`/`remove` edit script. | hard | The script must be minimal and tie-break the same way every run. |
| 14 | `14-decimal-add` | Add two decimal strings exactly. | hard | No floats. Signs, carries, differing scales, trailing zeros. |
| 15 | `15-glob-match` | Support `*`, `**`, `?` and `[a-z]`. | hard | `*` stops at `/`, `**` does not. Backtracking times out. |
| 16 | `16-json-pointer` | Resolve an RFC 6901 pointer. | medium | `~0` and `~1` unescaping. `""` is the whole document. |
| 17 | `17-state-machine` | Feed events through a transition table. | medium | Guards veto. Entry and exit actions fire in a fixed order. |
| 18 | `18-word-wrap` | Break lines at spaces within a width. | medium | A long word is hard-split. Existing newlines survive. |
| 19 | `19-expression-eval` | Evaluate `+ - * / %` with parentheses. | hard | Precedence, unary minus, divide by zero. No `eval`. |
| 20 | `20-immutable-set-in` | Set a deep value without mutating. | hard | Untouched branches stay reference-identical. |

Spread: 4 easy, 11 medium, 5 hard. Default `timeoutMs` is 5000. Tasks 13, 15 and 19
use 15000, because each carries a large input that a correct quadratic solution
should survive and a catastrophic one should not.

---

## 11. The harness

`<repo>/harness/` is **the thing that evolves**. It is
self-contained. A node stores the whole tree inline, so any machine can materialise
it, typecheck it and run it with no extra files.

### 11.1 Three hard rules

1. `harness/index.ts` exports `solve`. **The signature is frozen.** It never changes.
   Everything behind `solve` is mutable. Files may be added, split, merged or deleted.
2. `harness/contract.ts` is **immutable**. A patch that touches it is rejected.
3. A harness file may import **only relative siblings inside `harness/`**. No
   packages. No node builtins. No dynamic `import()`. No `eval`. No `process`.

Rule 3 makes the sandbox real at the type level. The harness cannot read the tests,
the network or the disk, because it has no way to name them.

### 11.2 `<repo>/harness/contract.ts`

```ts
/**
 * FROZEN CONTRACT. DO NOT EDIT THIS FILE.
 *
 * Every node in the Petri tree ships a copy of this file, byte for byte.
 * The evolve loop rejects any patch that changes it.
 * The signature of solve() in ./index.ts is frozen with it.
 *
 * The harness NEVER sees the tests. TaskView is built by the task loader, which
 * reads bench/tasks/<id>/task.json, PROMPT.md and starter/ only.
 * It never opens bench/tasks/<id>/test.mjs.
 */

export const HARNESS_ENTRY_VERSION = 1 as const;

export interface SourceFile {
  readonly path: string;      // Relative, inside the task sandbox, e.g. "solution.mjs".
  readonly contents: string;
}

export interface SymbolSpec {
  readonly name: string;      // "chunk"
  readonly signature: string; // "export function chunk(input, size)"
}

/** Everything the harness may see. Never the tests. */
export interface TaskView {
  readonly taskId: string;
  readonly prompt: string;                          // PROMPT.md, verbatim.
  readonly entryFile: string;                       // The file the solution must write.
  readonly exportedSymbols: readonly SymbolSpec[];  // What the tests will import.
  readonly starterFiles: readonly SourceFile[];     // Read-only context. Never tests.
  readonly constraints: readonly string[];
  readonly language: 'javascript';
}

export type Role = 'user' | 'assistant';
export interface ChatMessage { readonly role: Role; readonly content: string; }

export interface ModelRequest {
  /** REQUIRED. Names the call site, e.g. "draft" or "repair#1". Labels must be distinct. */
  readonly label: string;
  readonly messages: readonly ChatMessage[];
  readonly system?: string;
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly stopSequences?: readonly string[];
}

export interface ModelResponse {
  readonly text: string;
  readonly stopReason: 'end_turn' | 'max_tokens' | 'stop_sequence';
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/** The only way a harness reaches a model. */
export interface ModelClient { complete(req: ModelRequest): Promise<ModelResponse>; }

export interface BudgetState {
  readonly callsUsed: number; readonly callsLeft: number;
  readonly tokensUsed: number; readonly tokensLeft: number;
  readonly msLeft: number;
}

/** The runner enforces the budget. The harness may read it. It may never raise it. */
export interface Budget {
  readonly maxCalls: number;
  readonly maxTokens: number;
  readonly maxWallMs: number;
  state(): BudgetState;
}

/** The runner owns the trace. A harness cannot forge it. */
export interface Logger { event(kind: string, data?: Record<string, unknown>): void; }

export interface HarnessContext {
  readonly model: ModelClient;
  readonly budget: Budget;
  readonly log: Logger;
  readonly rng: () => number;  // Seeded from the run seed. Deterministic.
  readonly now: () => number;  // A frozen clock.
}

export interface Solution {
  readonly files: readonly SourceFile[];
  readonly notes?: string;
}

/** ModelClient.complete rejects with this when the harness overspends. */
export class BudgetExceededError extends Error {
  readonly kind = 'budget-exceeded';
  constructor(public readonly what: 'calls' | 'tokens' | 'wall', message: string) {
    super(message);
    this.name = 'BudgetExceededError';
  }
}
```

**The frozen entry point:**

```ts
export async function solve(task: TaskView, ctx: HarnessContext): Promise<Solution>;
```

Default budget: `maxCalls 8`, `maxTokens 120000`, `maxWallMs 120000`.

> **Reconciled.** One design defined the harness as
> `solve(input: { taskId, prompt, entry, exports, attemptIndex }) => { source, usage }`.
> Petri takes the `TaskView` and `HarnessContext` form instead. Reasons: without
> `ctx` there is no budget, no trace and no seeded RNG, which removes the `budget`,
> `decoding` and `memory` levers and so removes half the evolvable surface; the
> stated goal of the other form — "the harness never sees the tests is a property
> of the type signature" — is preserved exactly, because `TaskView` carries no path
> and `ctx` exposes only a `ModelClient`; and token usage is taken from the runner's
> own budget accounting, which is more trustworthy than a number the harness
> reports about itself.

> **Reconciled.** The same design placed the contract in `src/`. Petri keeps it at
> `harness/contract.ts`. The harness then imports nothing outside itself, so a node
> materialises with no repo skeleton and typechecks with `types: []` and no
> `node_modules`. The guard rule becomes one line: any patch touching
> `harness/contract.ts` is rejected.

### 11.3 Harness V1 — the honest baseline

V1 is single-shot. It does not retry. It does not run tests. It does not reflect.
Each module is a named lever. Even where V1 is trivial, the seam exists, so a later
node produces a small readable diff.

**`harness/retrieval.ts`** — what task material enters the prompt, and in what order.

```ts
import type { TaskView, SourceFile } from './contract.js';

export interface RetrievedContext {
  readonly files: readonly SourceFile[];
  readonly droppedFiles: readonly string[];
  readonly charBudget: number;
}

export const DEFAULT_CHAR_BUDGET = 40_000;

/** V1 takes the starter files in declared order until the budget is full. */
export function selectContext(
  task: TaskView,
  charBudget: number = DEFAULT_CHAR_BUDGET,
): RetrievedContext {
  const files: SourceFile[] = [];
  const droppedFiles: string[] = [];
  let used = 0;
  for (const f of task.starterFiles) {
    const cost = f.path.length + f.contents.length + 16;
    if (used + cost > charBudget) { droppedFiles.push(f.path); continue; }
    files.push(f);
    used += cost;
  }
  return { files, droppedFiles, charBudget };
}
```

**`harness/prompt.ts`** — what the harness says to the model.

```ts
export function buildSystemPrompt(): string {
  return [
    'You are a JavaScript programmer.',
    'Write complete, runnable ESM code.',
    'Reply with one fenced code block and nothing else.',
  ].join('\n');
}

export function buildUserPrompt(task: TaskView, context: RetrievedContext): string {
  const parts: string[] = [];
  parts.push(`Task: ${task.prompt}`);
  parts.push(`Write the file ${task.entryFile}.`);
  // V1 sends symbol NAMES only. The full signatures are deliberately withheld.
  parts.push(`It must export: ${task.exportedSymbols.map((s) => s.name).join(', ')}.`);
  if (task.constraints.length > 0) {
    parts.push(`Constraints:\n${task.constraints.map((c) => `- ${c}`).join('\n')}`);
  }
  for (const f of context.files) parts.push(`--- ${f.path} ---\n${f.contents}`);
  return parts.join('\n\n');
}
```

V1 omits the full signatures on purpose. That is headroom, and it is a real defect.

**`harness/recovery.ts`** — what the harness does after a bad reply.

```ts
export interface Failure {
  readonly kind: 'no-code-block' | 'empty-file' | 'model-error' | 'budget-exceeded';
  readonly detail: string;
}

/** V1 does not recover. The seam exists so a repair turn is a one-file diff. */
export async function attemptRepair(
  _task: TaskView, _ctx: HarnessContext, _failure: Failure, _previousReply: string,
): Promise<Solution | null> {
  return null;
}
```

**`harness/loop.ts`** — the control flow of one solve call.

```ts
export const MAX_OUTPUT_TOKENS = 4096;

/** V1 takes the FIRST fenced block. Taking the last one is already a change. */
export function extractSolutionFiles(task: TaskView, replyText: string): SourceFile[] {
  const fence = /```[a-zA-Z0-9_-]*\n([\s\S]*?)```/g;
  const blocks: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = fence.exec(replyText)) !== null) blocks.push(m[1] ?? '');
  const code = blocks.length > 0 ? blocks[0]! : replyText;
  return [{ path: task.entryFile, contents: `${code.trim()}\n` }];
}

/** V1 makes exactly one model call. */
export async function runLoop(task: TaskView, ctx: HarnessContext): Promise<Solution> {
  const context = selectContext(task);
  ctx.log.event('retrieval', { files: context.files.length, dropped: context.droppedFiles.length });

  const reply = await ctx.model.complete({
    label: 'draft',
    system: buildSystemPrompt(),
    messages: [{ role: 'user', content: buildUserPrompt(task, context) }],
    maxTokens: MAX_OUTPUT_TOKENS,
    temperature: 0,
  });
  ctx.log.event('model', {
    label: 'draft', stopReason: reply.stopReason, outputTokens: reply.outputTokens,
  });

  const files = extractSolutionFiles(task, reply.text);
  if (files[0]!.contents.trim().length === 0) {
    const failure: Failure = { kind: 'empty-file', detail: 'the model returned no code' };
    const repaired = await attemptRepair(task, ctx, failure, reply.text);
    if (repaired !== null) return repaired;
    ctx.log.event('give-up', { reason: failure.kind });
    return { files: [{ path: task.entryFile, contents: '' }], notes: 'no code produced' };
  }
  return { files, notes: 'single-shot draft' };
}
```

**`harness/index.ts`**

```ts
import type { TaskView, HarnessContext, Solution } from './contract.js';
import { runLoop } from './loop.js';

export { HARNESS_ENTRY_VERSION } from './contract.js';
export type { TaskView, HarnessContext, Solution } from './contract.js';

/** FROZEN ENTRY POINT. The signature never changes. Everything behind it is mutable. */
export async function solve(task: TaskView, ctx: HarnessContext): Promise<Solution> {
  ctx.log.event('solve:start', { taskId: task.taskId });
  const solution = await runLoop(task, ctx);
  ctx.log.event('solve:end', { files: solution.files.length });
  return solution;
}
```

V1 does not catch `BudgetExceededError`. The runner catches it and scores that task
0. Catching it is a `recovery` change, and the tree can test whether it helps.

### 11.4 The real model client

`<repo>/src/model/anthropic.ts` implements
`ModelClient` over `@anthropic-ai/sdk`. The model id for a live run is
**`claude-sonnet-5`**. The client enforces the budget and throws
`BudgetExceededError`. It never hands the harness an API key.

### 11.5 The replay model client

`<repo>/src/model/replay.ts` needs no API key. It
picks one of the graded answers shipped with each task, in
`bench/tasks/<id>/answers/`. It picks by hashing the exact request text with the run
seed, then applies fixed rules:

- A prompt that carries the full signatures cannot draw `wrong_api`.
- A prompt that carries a worked example cannot draw `syntax_error`.
- A repair turn that quotes an error returns one grade better.

The rules are published in `<repo>/bench/RULES.md`.
They make replay a real, falsifiable environment, and they are fully deterministic,
so two machines produce identical results.

> **Reconciled.** One design used per-task recorded fixtures keyed by
> `(harnessId, taskId, attemptIndex)`. Another used a graded-answer client driven by
> a request hash. Petri keeps **both, for two different jobs**. The fixture store of
> §10.10 replays a *recorded live measurement*, which is what `petri bench record`
> writes. The graded-answer client of §11.5 answers *a prompt no fixture has seen*,
> which is what `petri evolve --mode replay` needs, because every new harness sends
> a new prompt. A fixture miss falls back to the graded-answer client **only when
> `--allow-graded` is passed**, and the resulting `RunResult` records
> `env.model: 'graded'`. Without that flag a miss is a hard error.

---

## 12. The context flattener

Input: the whole tree. Output: a compact digest that an agent reads before it
proposes node N+1. The digest is **deterministic**. The same ledger always renders
the same bytes. No model takes part.

### 12.1 Areas

`<repo>/src/flatten/areas.ts`

```ts
export const AREAS = [
  'prompt', 'retrieval', 'recovery', 'loop', 'decoding',
  'budget', 'verification', 'decomposition', 'memory', 'other',
] as const;
export type Area = (typeof AREAS)[number];
export const AreaSchema = z.enum(AREAS);

export const AREA_REGISTRY: Record<Area, { summary: string; probes: string[] }> = {
  prompt:        { summary: 'What the harness says to the model.',
                   probes: ['system text', 'output format', 'worked examples', 'signatures'] },
  retrieval:     { summary: 'What task material enters the prompt, and in what order.',
                   probes: ['ranking', 'truncation', 'file selection'] },
  recovery:      { summary: 'What the harness does after a bad reply.',
                   probes: ['repair turns', 'error text feedback', 'fallbacks'] },
  loop:          { summary: 'The control flow of one solve call.',
                   probes: ['step count', 'stop rule', 'reply parsing'] },
  decoding:      { summary: 'Sampling controls on each model call.',
                   probes: ['temperature', 'maxTokens', 'stop sequences'] },
  budget:        { summary: 'How the harness spends calls and tokens.',
                   probes: ['per-step caps', 'reserve for repair'] },
  verification:  { summary: 'Checks the harness runs on its own answer before it returns.',
                   probes: ['invariant checks', 'self-review pass', 'shape checks'] },
  decomposition: { summary: 'Splitting one task into smaller model calls.',
                   probes: ['plan then write', 'one call per symbol', 'sub-agents'] },
  memory:        { summary: 'State carried across steps inside one solve call.',
                   probes: ['scratchpad', 'reuse of earlier drafts'] },
  other:         { summary: 'Anything the registry does not name.', probes: [] },
};

export interface ChangedFile { path: string; addedLines: string[]; removedLines: string[]; }

/** Deterministic. Path map first, then keywords over the changed lines. */
export function classifyAreas(changed: ChangedFile[]): { areas: Area[]; primaryArea: Area };
```

The path map is fixed:

```ts
const PATH_AREA: Record<string, Area> = {
  'harness/prompt.ts': 'prompt',
  'harness/retrieval.ts': 'retrieval',
  'harness/recovery.ts': 'recovery',
  'harness/loop.ts': 'loop',
  'harness/index.ts': 'loop',
};
```

A file not in the map is classified by keyword, over its base name and then over its
changed lines. A path contributes `lines + 1` weight. A keyword hit contributes 3.
Areas with weight 3 or more are reported. Ties break on the area name, ascending.

**Declared versus derived.** A node declares `primaryArea` in its proposal. The
classifier derives the area set from the diff. When they differ, the digest uses the
**derived** set and sets `areaMismatch` on the node. A model therefore cannot
mislabel its way around a saturated area.

`memory` means within-solve state only. `HarnessContext` is fresh per task and the
contract is frozen, so cross-task memory is out of scope. The digest states this
limit instead of letting an agent waste a node discovering it.

### 12.2 The digest model

`<repo>/src/flatten/digest.ts`

```ts
export type Verdict = 'PRODUCTIVE' | 'SATURATED' | 'OPEN' | 'NEVER TRIED';

export interface MotifStat {
  motif: string; area: Area; attempts: number; accepted: number;
  bestDeltaBp: number; nodeIds: string[]; exhausted: boolean;
}

export interface AreaStat {
  area: Area; tried: number; accepted: number; rejected: number; pending: number;
  bestDeltaBp: number | null; bestNodeId: string | null;
  verdict: Verdict; motifs: MotifStat[];
}

export interface FailureCard {
  nodeId: string; area: Area; motif: string;
  hypothesis: string;        // VERBATIM.
  hypothesisTruncated: boolean;
  rejection: string;         // "regression -830bp (6820 -> 5990)"
  tokenDelta: number | null;
}

export interface Digest {
  bench: string; benchName: string;
  mode: Mode; ledger: 'hcs' | 'local';
  taskCount: number; runs: number;
  totals: { nodes: number; accepted: number; rejected: number; pending: number; contested: number };
  head: { nodeId: string; medianBp: number };
  root: { nodeId: string; medianBp: number };
  spine: PetriNode[];
  areas: AreaStat[];
  neverTried: Area[];
  notableFailures: FailureCard[];
  exhaustedMotifs: MotifStat[];
  mechanicalFailures: { nodeId: string; cls: string; evidenceHead: string }[];
  knownMotifs: string[];
  digestHash: string;        // sha256 of the rendered text, first 8 hex characters.
}
```

Verdict rules, applied in order:

1. `tried === 0` → `NEVER TRIED`.
2. `accepted > 0 && bestDeltaBp > 0` → `PRODUCTIVE`.
3. `tried >= 3 && accepted === 0` → `SATURATED`.
4. Otherwise → `OPEN`.

Motif exhaustion: `attempts >= 2 && accepted === 0 && bestDeltaBp <= 0`.
A motif is a narrow idea, so it dies after 2 attempts. An area is broad, so it needs
3 before it closes.

Notable-failure ranking, deterministic:

1. Rejection class priority: `REGRESSION` > `CONTESTED` > `WITHIN_NOISE` >
   `typecheck-failed` > `malformed-proposal`.
2. Then `|deltaBp|`, descending.
3. Then node id, ascending.
4. Take the top 6. Quote the hypothesis verbatim. Truncate at 240 characters and set
   the flag.

### 12.3 Render

```ts
export function renderDigest(d: Digest, maxTokens = 6000): string;
```

Output is plain text with fixed-width columns. It is diff-stable and cheap in
tokens. Sections render in a fixed order. **The header, the area map and NEVER TRIED
never drop.** Optional rows drop from the tail. `--max-tokens` raises the cap.
`--json` returns the full structure with no cap.

### 12.4 The rendered digest — worked example

```
# PETRI DIGEST  ledger 23 nodes  digest-hash 9f2c41e8
bench petri-bench-v1 aa80a752 | 20 tasks | unit tests only | N=5 runs | MEDIAN
mode REPLAY (deterministic, no API key). REPLAY never compares against LIVE.
ledger LOCAL — UNVERIFIED. See the trust banner.
totals: 5 accepted | 17 rejected | 1 pending | 0 contested
head n013 7500bp | root n000 2500bp | lift +5000bp over 4 accepted steps

## 1. ACCEPTED SPINE
id    area      motif                   score   delta    tok/task  hypothesis
n000  -         genesis-v1              2500bp      -       3.1k   Single-shot prompt. No retry. No test run.
n001  prompt    include-signatures      4170bp  +1670bp    3.4k   Because the prompt sends only symbol names,
                                                                  the model guesses argument order. Sending
                                                                  full signatures will raise the median by
                                                                  at least 800bp.
n004  prompt    one-worked-example      5830bp  +1660bp    4.2k   Because the model returns prose plus code
                                                                  on hard tasks, one worked example of the
                                                                  exact output shape will raise the median
                                                                  by at least 800bp.
n006  recovery  repair-with-error-text  6670bp  +1040bp    7.8k   Because a failed draft is thrown away, one
                                                                  repair turn quoting the error will raise
                                                                  the median by at least 500bp.
n013  loop      last-fence-not-first    7500bp  +1030bp    7.9k   Because the model writes an explanation
                                                                  before the answer, taking the last fenced
                                                                  block will raise the median by 500bp.

## 2. AREA MAP
area           tried  acc  rej  pend  contest  best delta  best node  verdict
prompt             7    2    5     0        0    +1670bp   n001       PRODUCTIVE
recovery           4    1    3     0        0    +1040bp   n006       PRODUCTIVE
loop               4    1    3     0        0    +1030bp   n013       PRODUCTIVE
retrieval          4    0    3     1        0        +0bp  -          SATURATED
decoding           2    0    2     0        0         0bp  -          OPEN
budget             1    0    1     0        0         0bp  -          OPEN
verification       0    0    0     0        0           -  -          NEVER TRIED
decomposition      0    0    0     0        0           -  -          NEVER TRIED
memory             0    0    0     0        0           -  -          NEVER TRIED
other              0    0    0     0        0           -  -          NEVER TRIED

## 3. AREA DETAIL

### prompt  PRODUCTIVE  7 tried / 2 accepted / 5 rejected
  best     n001 +1670bp  motif include-signatures
  motifs   include-signatures 1/1 acc | one-worked-example 1/1 acc |
           persona-expansion 0/2 EXHAUSTED | think-step-by-step 0/1 |
           more-worked-examples 0/1 | output-format-guard 0/1 (typecheck-failed)
  warning  the last 4 prompt nodes all failed. Cheap prompt edits look mined out.

### recovery  PRODUCTIVE  4 tried / 1 accepted / 3 rejected
  best     n006 +1040bp  motif repair-with-error-text  (cost +3.6k tok/task)
  motifs   repair-with-error-text 1/1 acc | blind-retry 0/1 | more-repair 0/2 EXHAUSTED
  note     repair helps only when it is conditional. n018 made it unconditional
           and lost 1670bp.

### retrieval  SATURATED  4 tried / 0 accepted / 3 rejected / 1 pending
  best     none beat the parent. Best measured delta +0bp (n022, pending).
  motifs   reorder-context 0/2 EXHAUSTED | summarise-files 0/1 | drop-large-files 0/1 pending
  note     the 20 tasks carry 0-2 starter files. Retrieval has almost nothing to rank.

## 4. NEVER TRIED  (no node has touched these)
verification   Checks the harness runs on its own answer before it returns.
               probes: invariant checks, self-review pass, shape checks
decomposition  Splitting one task into smaller model calls.
               probes: plan then write, one call per symbol, sub-agents
memory         State carried across steps inside one solve call.
               probes: scratchpad, reuse of earlier drafts
               LIMIT: ctx is fresh per task. Cross-task memory needs a contract
                      change. The contract is frozen, so it is out of scope.

## 5. NOTABLE FAILURES  (hypotheses quoted verbatim)

n018  recovery / more-repair       rejected REGRESSION -1670bp (6670 -> 5000), tok +5.1k
> "Because repair helps on failures, running a repair turn on every task will
>  raise the median by at least 500bp."

n007  prompt / persona-expansion   rejected REGRESSION -830bp (5830 -> 5000), tok +0.4k
> "Because the persona is still thin, naming the model a principal engineer with
>  15 years of experience will raise the median by at least 500bp."

n011  recovery / more-repair       rejected WITHIN_NOISE +0bp (6670 -> 6670), tok +4.4k
> "Because one repair turn is not always enough, three repair turns will raise
>  the median by at least 500bp."

## 6. EXHAUSTED — DO NOT REPROPOSE
area       motif               attempts  accepted  best delta  nodes
prompt     persona-expansion          2         0       -0bp   n002, n007
retrieval  reorder-context            2         0       +0bp   n003, n008
recovery   more-repair                2         0       +0bp   n011, n018
To use one of these, fill `contradicts` and say what is different this time.

## 7. MECHANICAL FAILURES  (patches that never ran)
n009  malformed-proposal  JSON parse failed after 1 repair turn: unexpected token '`' at 1:1
n012  typecheck-failed    harness/loop.ts(41,11): error TS2345: Argument of type
                          'Solution | null' is not assignable to parameter of type 'Solution'.
n016  typecheck-failed    harness/prompt.ts(22,34): error TS2551: Property 'signatures'
                          does not exist on type 'SymbolSpec'. Did you mean 'signature'?

## 8. CONSTRAINTS FOR NODE N+1
parent n013 | 7500bp | 7.9k tok/task | budget maxCalls 8, maxTokens 120000
at most 2 files changed, at most 120 changed lines
harness/contract.ts is immutable. solve() keeps its signature.
imports: relative siblings inside harness/ only
the win margin is 1000bp. A smaller measured gain is recorded as a tie.
known motif slugs (reuse one if it fits):
  include-signatures, one-worked-example, persona-expansion, think-step-by-step,
  more-worked-examples, output-format-guard, reorder-context, summarise-files,
  drop-large-files, blind-retry, repair-with-error-text, more-repair,
  last-fence-not-first, self-check-step, best-of-two, raise-temperature,
  cap-max-tokens, second-sampled-draft
```

Read the digest and the next move is obvious. Three areas were never tried. Prompt
edits are mined out. Unconditional repair costs tokens and score. An agent with this
text proposes with knowledge. An agent without it guesses.

---

## 13. The evolve loop

### 13.1 Steps

`petri evolve` does exactly this:

1. Load the ledger. Build the digest. Render it.
2. Materialise the parent harness into `.petri/scratch/<runId>/harness/`.
3. Build the proposal prompt. `--dry-run` prints it and exits 0.
4. Call the model. A live run uses `claude-sonnet-5`. A replay run uses the
   graded-answer client, keyed by `sha256(digestHash + seed)`.
5. Parse and validate with `ProposalSchema`. Allow **one** repair turn, labelled
   `proposal-repair`.
6. Check the guards of §13.3.
7. Write the files into the scratch copy. Compute the diff. Classify the derived
   areas.
8. Typecheck the scratch copy.
9. Run the benchmark N times. Take the median.
10. Write the node, publish `NodeSubmitted`, print the node id. Exit 0.

**`petri evolve` never writes `accepted`.** It writes a node whose computed status
is `pending`, even when the measured delta is negative. Two independent
verifications decide the outcome. A mechanical failure at step 5, 6 or 8 still
writes a node; its `NodeDetail.mechanical` records the failure, and it has no
claimed runs.

> **Reconciled.** One design let `petri evolve` write `rejected` directly for a
> mechanical failure. Petri does not store a status at all (§6.10), so the question
> dissolves. A mechanically failed node has no verifications, so `evaluate` returns
> `pending` with `INSUFFICIENT_VERIFICATIONS`. The CLI prints the mechanical reason
> from `NodeDetail.mechanical` beside it, so a reader sees why it will never be
> verified. Design rule 1 holds with no exception.

### 13.2 `ProposalSchema`

`<repo>/src/evolve/schema.ts`

```ts
import { z } from 'zod';
import { AREAS } from '../flatten/areas.js';

export const ProposalSchema = z.strictObject({
  hypothesis: z.string().min(30).max(600),
  falsifiedIf: z.string().min(15).max(400),
  primaryArea: z.enum(AREAS),
  motif: z.string().max(40).regex(/^[a-z0-9]+(-[a-z0-9]+){0,5}$/),
  metric: z.enum(['score', 'tokens']),
  /** Non-zero and signed. For metric 'score' the unit is basis points. */
  predictedDelta: z.int().refine((n) => n !== 0, 'predictedDelta must be non-zero'),
  reasoning: z.string().max(1200),
  whyNotUntested: z.string().max(400).nullable().default(null),
  contradicts: z.array(z.strictObject({
    nodeId: z.string(), why: z.string().max(300),
  })).max(3).default([]),
  files: z.array(z.strictObject({
    path: z.string().regex(/^harness\/[a-z0-9_-]+\.ts$/),
    contents: z.string().min(1).max(40_000),
  })).min(1).max(2),
});
export type Proposal = z.infer<typeof ProposalSchema>;
```

`whyNotUntested` is `null` when absent. **This is the one place a `null` appears in
Petri.** `Proposal` is nested inside `NodeDetail`, which is hashed, and §2 forbids
`null`. The writer therefore drops the key when it is `null`, and the reader applies
the Zod default. A round trip through `canonicalJson` is stable. `petri fsck`
check 5 verifies it.

The model returns **full file contents, never a diff**. That costs output tokens and
it removes fuzzy patch application, context-line mismatch and patch order entirely.
The guard computes the real diff itself for area classification.

### 13.3 Guards

`<repo>/src/evolve/guards.ts`

| Guard | Mechanical class |
|---|---|
| JSON invalid, or Zod invalid, after one repair turn | `malformed-proposal` |
| A path outside `harness/`, or equal to `harness/contract.ts` | `patch-out-of-bounds` |
| More than 2 files, or more than 120 changed lines | `patch-too-large` |
| An import that is not `./sibling.js` | `sandbox-violation` |
| `require(`, `import(`, `eval(`, `new Function(`, `process.`, `globalThis.` | `sandbox-violation` |
| The `solve` signature changed | `contract-violation` |
| A `SATURATED` area with `whyNotUntested` null | `rule-violation` |
| An exhausted motif with `contradicts` empty | `rule-violation` |
| `tsc --noEmit` fails on the scratch copy | `typecheck-failed` |

```ts
const IMPORT_RE = /^\s*import\s+(?:type\s+)?[^'"]*from\s+['"]([^'"]+)['"]/gm;
const BANNED_RE = /\brequire\s*\(|\bimport\s*\(|\beval\s*\(|\bnew\s+Function\s*\(|\bprocess\.|\bglobalThis\./;
const SOLVE_RE  = /export\s+async\s+function\s+solve\s*\(\s*task\s*:\s*TaskView\s*,\s*ctx\s*:\s*HarnessContext\s*\)\s*:\s*Promise<Solution>/;

export function checkSandbox(path: string, contents: string): string | null {
  if (BANNED_RE.test(contents)) return `banned construct in ${path}`;
  for (const m of contents.matchAll(IMPORT_RE)) {
    const spec = m[1]!;
    if (!/^\.\/[a-z0-9_-]+\.js$/.test(spec)) return `illegal import "${spec}" in ${path}`;
  }
  return null;
}
```

### 13.4 Provenance and the mechanical result

```ts
export const ProvenanceSchema = z.strictObject({
  source: z.enum(['model', 'human', 'model-via-human']),
  model: z.string().min(1).max(64),   // 'claude-sonnet-5', 'graded', or 'none'.
  promptHash: Hex64,                  // OBSERVATION. sha256 of the exact prompt sent.
  digestHash: z.string().max(16),     // OBSERVATION. Which digest the proposer read.
  seed: z.int().min(0),
});
export type Provenance = z.infer<typeof ProvenanceSchema>;

export const MechanicalResultSchema = z.strictObject({
  cls: z.enum(['ok', 'malformed-proposal', 'patch-out-of-bounds', 'patch-too-large',
               'sandbox-violation', 'contract-violation', 'rule-violation', 'typecheck-failed']),
  command: z.string().max(400),   // OBSERVATION. '' when there was no command.
  exitCode: z.int(),              // OBSERVATION. 0 when cls is 'ok'.
  evidence: z.string().max(4000), // Verbatim tool output. '' when cls is 'ok'.
});
export type MechanicalResult = z.infer<typeof MechanicalResultSchema>;
```

`model` is `'none'` rather than `null`, because §2 forbids `null`.

Four fields above are **observations** and no node id may read them: both hashes in
`Provenance`, and `command` and `exitCode` in `MechanicalResult`. Of `evidence`,
only the diagnostics reach an id. §6.4a holds the whole table, and §6.4b holds the
reduction. Each of the four names a machine, a moment or a local tree, so hashing
one gives the same patch a different id on a second machine.

### 13.5 A failed typecheck is data, not a crash

`petri evolve` **exits 0** when a patch fails to typecheck. It writes a node that
carries the hypothesis, the full patch, the broken source and the verbatim `tsc`
output. A failed experiment is a record. That is design rule 3.

The cost is that CI cannot use the exit code to detect a bad patch. Use
`petri show <id> --json` and read `detail.mechanical.cls` instead.

### 13.6 The scratch typecheck

`.petri/scratch/<runId>/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2023", "lib": ["ES2023"], "module": "NodeNext",
    "moduleResolution": "NodeNext", "strict": true, "noEmit": true,
    "types": [], "exactOptionalPropertyTypes": true,
    "noUncheckedIndexedAccess": true, "skipLibCheck": true
  },
  "include": ["harness/**/*.ts"]
}
```

`"types": []` works because the harness imports nothing outside itself. The check
needs no `node_modules` beyond `typescript`, and it runs in about one second.

**The working directory is the scratch workspace**, never the repo root. A compiler
prints every path relative to its working directory, so this one line is what keeps
`/Users/<name>/…/.petri/scratch/<uuid>/` out of the output. It prints
`harness/index.ts(1,14): error TS2322: …` on every machine.

Command: `node_modules/.bin/tsc -p tsconfig.json`, run in the workspace. Two
fallbacks follow, for a checkout with no `node_modules`: the same compiler through
`node`, then `pnpm exec tsc -p tsconfig.json`. The repo's own compiler is tried
first because its path is known and it needs no PATH lookup. The command that ran
is recorded in `MechanicalResult.command`, which is an observation (§6.4a), so the
order here can never change a node id.

### 13.7 The human path — one shared code path

`runCandidate()` in `<repo>/src/evolve/run.ts` is the
**only** function that writes a node. `evolve` builds the `Proposal` by asking a
model. `submit` builds it from flags and from files a human edited. Steps 6 to 10
are identical, byte for byte.

```ts
export interface CandidateInput {
  parentId: string;
  proposal: Proposal;
  provenance: Provenance;
  runs: number;
  seed: number;
  mode: Mode;
}
export async function runCandidate(input: CandidateInput): Promise<PetriNode>;
```

Three human routes:

1. `petri propose …` copies the parent harness into
   `.petri/scratch/<runId>/harness/`, writes `proposal.json` with the metadata and
   no files, and prints the path. The human edits the TypeScript with any editor.
2. `petri submit --workspace .petri/scratch/<runId>` reads the edited files, fills
   `proposal.files` and calls `runCandidate()`.
3. `petri evolve --dry-run > prompt.txt`, paste into any chat interface, save the
   JSON reply, then `petri evolve --proposal reply.json`. Provenance becomes
   `model-via-human`.

A human faces the same rules as a model. The 2-file cap, the 120-line cap, the
sandbox and the immutable contract all apply.

---

## 14. The CLI surface

Entry point: `<repo>/src/cli/index.ts`.
Run it with `pnpm petri <command>`, which is `tsx src/cli/index.ts`.

### 14.1 Exit codes

These are the only exit codes. Every command uses this table.

| Code | Name | Meaning |
|---|---|---|
| **0** | OK | The command did what it says. **A recorded rejection is a success.** |
| **1** | USAGE | A bad flag, a missing argument, or an even run count. |
| **2** | NOT_FOUND | No `.petri/`, no such node, no such object, no fixture. |
| **3** | INTEGRITY | A bad signature, a hash mismatch, a broken log chain, a bad id. |
| **4** | REFUSED | A policy refusal. Self-verification. A cross-mode comparison. |
| **5** | ENVIRONMENT | A doctor check failed. Node too old. The sandbox is broken. |
| **6** | NETWORK | A mirror node or Hedera failure, after retries. |
| **7** | INTERRUPTED | SIGINT or SIGTERM. |

A failed experiment exits **0**. A failed *tool* exits non-zero. Design rule 3
depends on this distinction.

### 14.2 Global flags

Accepted by every command.

| Flag | Default | Meaning |
|---|---|---|
| `--root <dir>` | `<repo>` | The repo root that holds `.petri/`. |
| `--json` | off | Print machine-readable JSON to stdout. The banner still goes to stderr. |
| `--quiet` | off | Suppress progress output. It never suppresses the trust banner. |
| `--no-color` | off | Disable ANSI colour. |
| `-h, --help` | — | Print help. Exit 0. |
| `-V, --version` | — | Print the version. Exit 0. |

### 14.3 Setup

| Command | Flags | Does |
|---|---|---|
| `petri init` | `--tree <id>` (default `petri-main`), `--bench <dir>` (default `bench/`), `--mode live\|replay`, `--ledger hcs\|local`, `--force` | Create `.petri/`, write `config.json`, generate `identity.json` at mode 0600, compute and store the bench id. Without `--force` it refuses to overwrite. Defaults come from the environment: no `ANTHROPIC_API_KEY` gives `replay`, no `HEDERA_OPERATOR_KEY` gives `local`. |
| `petri id create` | `--label <name>` | Create the key pair. Fails with exit 1 when a key file exists. Never overwrites. |
| `petri id show` | — | Print this runner's public key. |
| `petri id path` | — | Print the identity file path. |
| `petri config show` | — | Print `config.json`. |
| `petri config set <key> <value>` | — | Set one dotted key, for example `policy.minRuns`. Re-validates the whole file. |
| `petri topic create` | `--network testnet\|mainnet\|previewnet` | Create an HCS topic with no admin key and no submit key. Write `topicId` into `config.json`. Needs `HEDERA_OPERATOR_ID` and `HEDERA_OPERATOR_KEY`. |
| `petri topic show` | — | Print the topic id, the network and the mirror endpoints. |

### 14.4 Building and measuring a node

| Command | Flags | Does |
|---|---|---|
| `petri snapshot <dir>` | — | Hash a directory into a `HarnessObject`. Print the harness id. |
| `petri propose` | `--parent <id>` (default: the current tip), `--area <area>`, `--motif <slug>`, `--hypothesis <text>`, `--falsified-if <text>`, `--metric score\|tokens`, `--predict <int>` | Create a scratch workspace with the parent harness and a `proposal.json`. Print the workspace path. It runs nothing. |
| `petri submit` | `--workspace <dir>`, `--runs <odd>` (default 5), `--seed <int>` (default 7), `--mode live\|replay` | Read the edited workspace, run every guard, typecheck, measure, write the node, publish `NodeSubmitted`. `provenance.source` is `human`. |
| `petri evolve` | `--parent <id>`, `--runs <odd>`, `--seed <int>`, `--mode live\|replay`, `--dry-run`, `--force-area <area>`, `--proposal <file.json>`, `--allow-graded`, `--max-tokens <int>` | The loop of §13.1. `--dry-run` prints the prompt and exits 0. `--proposal` skips the model call and sets `provenance.source` to `model-via-human`. |
| `petri verify <nodeId>` | `--runs <odd>`, `--mode live\|replay`, `--allow-graded` | Re-run the **parent and the candidate**, paired, with the derived seeds. Build the report, sign it, store it, publish `VerificationSigned`. **Exits 4 when you are the node author.** |
| `petri publish <nodeId>` | — | Re-publish a stored node's `NodeSubmitted` to the log. Used after a topic change. |
| `petri status <nodeId>` | `--why` | Run `evaluate` and print the status, the code and the reason. `--why` also lists every ignored verification and why it was ignored. |

### 14.5 Reading the tree

| Command | Flags | Does |
|---|---|---|
| `petri show <nodeId>` | `--diff`, `--runs`, `--verifications` | Print the hypothesis, the status and the reason. Flags add the diff, the claimed runs and every verification. |
| `petri tree` | `--from <id>`, `--depth <n>`, `--all` | Print the whole tree, **rejected branches included**, with one-line reasons. |
| `petri tips` | — | Print accepted leaves. These are the frontiers worth extending. |
| `petri dead-ends` | `[<id>]` | Print every rejected node with its reason. Design rule 3, made visible. |
| `petri lineage <nodeId>` | — | Print the root-first path and the lineage digest. |
| `petri diff <nodeId>` | `--regenerate` | Print `diff.patch`. `--regenerate` rebuilds it from the two snapshots and reports a mismatch. |
| `petri digest` | `--max-tokens <int>` (default 6000), `--json` | Render the context digest of §12.4. |
| `petri areas` | — | Print `AREA_REGISTRY` and the current path map. |
| `petri log` | `--after <seq>`, `--follow` | Print the consensus log in sequence order. |
| `petri replay` | `--topic <id>`, `--network <net>`, `--tree <id>`, `--audit`, `--from <seq>` | Rebuild every node and every status from the log alone. `--audit` also fetches each report and manifest, runs `checkReport`, and asserts `manifest.author === envelope.pub`. |
| `petri export` | `--out <file>` | Write the whole tree as one JSON document, with `trust` and `mode` at the top level. |

`petri replay` needs no key, no account and no local state. It is the proof that
nobody owns the tree.

### 14.6 The benchmark

| Command | Flags | Does |
|---|---|---|
| `petri bench tasks` | `--json` | List the 20 tasks with difficulty, test count and timeout. |
| `petri bench doctor` | — | Run the five checks of §10.11. Exit 5 on any failure. |
| `petri bench run` | `--node <id>`, `--runs <odd>`, `--mode live\|replay`, `--tasks 01,07`, `--allow-graded` | Measure one node. Print the `MedianResult`. It writes no node and publishes nothing. |
| `petri bench record` | `--node <id>`, `--runs <odd>` | **Live only.** Record fixtures and rewrite `fixtures/index.json`. |
| `petri bench id` | — | Print the bench id and the task count. |

### 14.7 Maintenance

| Command | Flags | Does |
|---|---|---|
| `petri fsck` | `--rebuild`, `--strict` | Check every invariant of §19. `--rebuild` regenerates `.petri/index/`. `--strict` turns warnings into exit 3. |
| `petri selftest` | `--emit-goldens` | Run the frozen vectors of §17. `--emit-goldens` prints them in the format of `test/golden.test.ts`. |
| `petri demo` | `--fast` | End to end with no keys: `init`, a root node, two verifications from two throwaway keys, one accepted child, one rejected child, then `tree` and `digest`. This is `pnpm demo`. |

`petri demo` is the judge's path. It must work on a fresh clone with no environment
variables at all.

---

## 15. File ownership table

One module owns each path. **Only the owner writes that file.** Another module that
needs the behaviour imports it.

| Path | Owner | Holds |
|---|---|---|
| `src/core/bytes.ts` | core | `utf8`, `frame` |
| `src/core/canonical.ts` | core | `Canon`, `canonicalJson`, `canonicalBytes`, `sha256Hex`, `contentId`, `byteCompare`, `CanonError` |
| `src/core/ids.ts` | core | `harnessDigestInput`, `harnessId`, `EMPTY_HARNESS_ID`, `nodeIdOf`, `benchIdOf`, and the identity split of §6.4a: `detailToCanon`, `detailDigestInput`, `detailIdOf`, `detailObservation`, `diagnosticsOf` |
| `src/core/schema.ts` | core | Every shared interface and Zod schema. `Hex64`, `TreeId`, `ParentRef`, `NodeManifest`, `NodeDetail`, `BenchSpec`, `PetriNode`, `NodeStatus`, `medianInt`, `scoreBp` |
| `src/core/errors.ts` | core | `PetriError` with an `exitCode`. Every command maps a throw to §14.1. |
| `src/config.ts` | core | `PetriConfig`, `Policy`, `loadConfig`, `saveConfig`, `CONFIG_PATH` |
| `src/trust/identity.ts` | trust | ed25519 key generation, loading, signing, `verifyDetached` |
| `src/trust/envelope.ts` | trust | `signingBytes`, `seal`, `openEnvelope`, `SignedEnvelope` |
| `src/trust/report.ts` | trust | `VerificationReport`, `buildReport`, `checkReport`, `seedFor`, `reportId` |
| `src/consensus/messages.ts` | consensus | `NodeSubmitted`, `VerificationSigned`, `StatusChanged`, `PetriMessage` |
| `src/consensus/log.ts` | consensus | `LogEntry`, `ConsensusLog`, `openLog`, `orderKey`, `parseConsensusTimestamp` |
| `src/consensus/local.ts` | consensus | `LocalLog`, the hash chain, the file lock |
| `src/consensus/hedera.ts` | consensus | `HederaLog`, `createTopic`, `makeClient`, `operatorKeyFromEnv`, `MIRROR_REST` |
| `src/consensus/mirror.ts` | consensus | `readTopic`, `MirrorMessage`, `MirrorStats` |
| `src/consensus/replay.ts` | consensus | `replay`, `ReplayNode`, `ReplayResult` |
| `src/policy/acceptance.ts` | policy | `evaluate`, `Verdict`, `DecisionCode`, `NodeFacts` |
| `src/store/paths.ts` | store | Every path under `.petri/`. No other module builds one. |
| `src/store/json.ts` | store | `writeJsonFile`, the pretty writer. Never hashed. |
| `src/store/objects.ts` | store | `ObjectStore`, content-addressed put and get |
| `src/store/snapshot.ts` | store | Read a directory into a `HarnessSnapshot`. NFC, CRLF and path rules of §3.2. |
| `src/store/store.ts` | store | `PetriStore`. The only class that touches disk outside `.petri/scratch/`. |
| `src/model/client.ts` | model | The `ModelClient` adapter, the budget enforcer, the `Logger` |
| `src/model/anthropic.ts` | model | The live client over `@anthropic-ai/sdk`, model `claude-sonnet-5` |
| `src/model/replay.ts` | model | The graded-answer client and the fixture client of §11.5 |
| `src/flatten/areas.ts` | flatten | `AREAS`, `AREA_REGISTRY`, `classifyAreas` |
| `src/flatten/digest.ts` | flatten | `Digest`, `buildDigest` |
| `src/flatten/render.ts` | flatten | `renderDigest` |
| `src/evolve/schema.ts` | evolve | `ProposalSchema`, `ProvenanceSchema`, `MechanicalResultSchema` |
| `src/evolve/prompt.ts` | evolve | The exact proposal prompt |
| `src/evolve/propose.ts` | evolve | The model call, the parse, one repair turn |
| `src/evolve/guards.ts` | evolve | `checkSandbox`, the patch bounds, the contract check |
| `src/evolve/diff.ts` | evolve | Unified diff between two snapshots. Display only. |
| `src/evolve/typecheck.ts` | evolve | `tsc --noEmit` on the scratch copy |
| `src/evolve/run.ts` | evolve | **`runCandidate()`. The only function that writes a node.** |
| `src/cli/index.ts` | cli | The commander entry point. Maps every throw to an exit code. |
| `src/cli/banner.ts` | cli | The trust banner and the mode banner of §8.9 |
| `src/cli/exit.ts` | cli | The exit-code table of §14.1 |
| `src/cli/init.ts` | cli | `init`, `config` |
| `src/cli/identity.ts` | cli | `id` |
| `src/cli/topic.ts` | cli | `topic` |
| `src/cli/node.ts` | cli | `snapshot`, `propose`, `submit`, `show`, `tree`, `tips`, `dead-ends`, `lineage`, `diff` |
| `src/cli/evolve.ts` | cli | `evolve` |
| `src/cli/verify.ts` | cli | `verify`, `status`, `publish` |
| `src/cli/bench.ts` | cli | `bench *` |
| `src/cli/log.ts` | cli | `log`, `replay`, `export` |
| `src/cli/fsck.ts` | cli | `fsck`, `selftest` |
| `src/cli/digest.ts` | cli | `digest`, `areas` |
| `src/cli/demo.ts` | cli | `demo` |
| `bench/src/schema.ts` | bench | `TaskMetaSchema`, `RunResult`, `TaskOutcome`, `Outcome` |
| `bench/src/taskLoader.ts` | bench | Reads a task directory. Returns the prompt and the spec **separately**. |
| `bench/src/benchSpec.ts` | bench | Builds the `BenchSpec` and the bench id from `bench/tasks/` |
| `bench/src/sandbox.ts` | bench | `buildBootstrap`, `runInSandbox` |
| `bench/src/runner.ts` | bench | `runOnce`, the Class A / Class B split, `isInfrastructure` |
| `bench/src/median.ts` | bench | `medianOf`, `MedianResult` |
| `bench/src/fixtures.ts` | bench | Fixture read, record and index |
| `bench/src/doctor.ts` | bench | The five checks of §10.11 |
| `bench/tasks/**` | bench | The 20 task directories |
| `bench/fixtures/**` | bench | Recorded solutions |
| `bench/RULES.md` | bench | The published grading rules for the replay client |
| `harness/contract.ts` | harness | **FROZEN.** Never edited by anyone. |
| `harness/index.ts` | harness | `solve`. The frozen entry point. |
| `harness/prompt.ts` | harness | The `prompt` lever |
| `harness/retrieval.ts` | harness | The `retrieval` lever |
| `harness/recovery.ts` | harness | The `recovery` lever |
| `harness/loop.ts` | harness | The `loop` lever |
| `test/canonical.test.ts` | test | The canonical encoder rejection cases |
| `test/nodeid.test.ts` | test | §6.4a. One experiment gives one node id, whatever the wall time, the working directory or the home directory. |
| `test/golden.test.ts` | test | The frozen vectors of §17 |
| `test/accept.test.ts` | test | The case table of §9.7 |
| `test/sandbox.test.ts` | test | The adversarial matrix of §10.7 |

**`.petri/` is written by `store` and `consensus` only.** `evolve` writes
`.petri/scratch/` only. `cli` writes nothing directly.

---

## 16. The import graph

### 16.1 Layers

A module may import from a layer above it in this list, never below.

```
L0  core        src/core/*, src/config.ts        imports: nothing in Petri
L1  trust       src/trust/*                      imports: L0
L2  consensus   src/consensus/*                  imports: L0, L1
L2  store       src/store/*                      imports: L0, L1
L3  policy      src/policy/*                     imports: L0, L2(messages only)
L3  bench       bench/src/*                      imports: L0, harness/contract.ts
L3  flatten     src/flatten/*                    imports: L0, L2
L3  model       src/model/*                      imports: L0, harness/contract.ts
L4  evolve      src/evolve/*                     imports: L0-L3
L5  cli         src/cli/*                        imports: everything
L-  harness     harness/*                        imports: ONLY ./sibling.js
```

`harness/` sits outside the layer system. It imports nothing but its own siblings.
That is rule 3 of §11.1, and `src/evolve/guards.ts` enforces it.

### 16.2 Exact import paths

TypeScript with `module: NodeNext` requires a `.js` extension on every relative
import, even though the file on disk is `.ts`. Every example below is literal.

```ts
// From src/trust/envelope.ts
import { canonicalBytes, type Canon } from '../core/canonical.js';
import { verifyDetached, type Identity } from './identity.js';

// From src/consensus/messages.ts
import { Hex64, ParentRef, TreeId, ModeSchema, byteLen } from '../core/schema.js';

// From src/consensus/local.ts
import { canonicalBytes, canonicalJson, sha256Hex } from '../core/canonical.js';
import { openEnvelope, seal } from '../trust/envelope.js';
import type { ConsensusLog, LogEntry, PublishReceipt } from './log.js';
import { PetriMessage } from './messages.js';

// From src/policy/acceptance.ts
import type { VerificationSigned } from '../consensus/messages.js';
import type { Policy } from '../config.js';
import type { Mode, NodeStatus } from '../core/schema.js';

// From src/store/store.ts
import { contentId } from '../core/canonical.js';
import { harnessId, EMPTY_HARNESS_ID } from '../core/ids.js';
import { NodeManifestSchema, NodeDetailSchema } from '../core/schema.js';
import { writeJsonFile } from './json.js';
import { nodeDir, objectPath } from './paths.js';
import { openEnvelope } from '../trust/envelope.js';

// From src/flatten/digest.ts
import { AREAS, AREA_REGISTRY, classifyAreas, type Area } from './areas.js';
import type { PetriNode } from '../core/schema.js';

// From src/evolve/run.ts
import { ProposalSchema, type Proposal } from './schema.js';
import { checkSandbox } from './guards.js';
import { typecheckScratch } from './typecheck.js';
import { unifiedDiff } from './diff.js';
import { classifyAreas } from '../flatten/areas.js';
import { PetriStore } from '../store/store.js';
import { openLog } from '../consensus/log.js';
import { loadIdentity } from '../trust/identity.js';

// From bench/src/runner.ts
import { runInSandbox } from './sandbox.js';
import { loadTask } from './taskLoader.js';
import { scoreBp } from '../../src/core/schema.js';
import type { TaskView, HarnessContext, Solution } from '../../harness/contract.js';

// From src/model/anthropic.ts
import Anthropic from '@anthropic-ai/sdk';
import type { ModelClient, ModelRequest, ModelResponse } from '../../harness/contract.js';

// From harness/loop.ts  -- the ONLY import shape a harness file may use
import type { TaskView, HarnessContext, Solution, SourceFile } from './contract.js';
import { selectContext } from './retrieval.js';
```

### 16.3 The two rules that keep the graph acyclic

1. `src/core/schema.ts` never imports from `src/consensus/`, `src/trust/` or
   `src/store/`. It is the bottom of the graph.
2. `src/policy/acceptance.ts` imports only **types** from
   `src/consensus/messages.js`. It never imports the Zod schemas, so replay can
   call it with a plain object.

---

## 17. Golden vectors — frozen

Freeze these in `<repo>/test/golden.test.ts`. Every
value below was produced by running the code in this document on Node v26.0.0.
A port to another language must reproduce all of them before it is trusted.

### 17.1 Test identities

Deterministic seeds, so anyone can rebuild the key pairs.

| Name | Seed (private) | Public key = runner id |
|---|---|---|
| A, the author | `1111…1111` (32 bytes of `0x11`) | `d04ab232742bb4ab3a1368bd4615e4e6d0224ab71a016baf8520a332c9778737` |
| B, a verifier | `2222…2222` | `a09aa5f47a6759802ff955f8dc2d2a14a5c99d23be97f864127ff9383455a4f0` |
| C, a verifier | `3333…3333` | `17cb79fb2b4120f2b1ec65e4198d6e08b28e813feb01e4a400839b85e18080ce` |

### 17.2 G1 — `harnessId({})`

```
bytes  "petri.harness.v1\ncount 0\n"
id     5894095975556df34aedf9a9be1228f959515821141de45e140f46890fe83a59
```

This id is `EMPTY_HARNESS_ID`. It is the parent baseline of every root node.

### 17.3 G2 — `harnessId` of two files

Input, exactly:

```
"agent/loop.ts"   -> "export const N = 1;\n"
"agent/prompt.md" -> "# system\n"
```

Bytes hashed, exactly, shown here with the newlines escaped:

```
"petri.harness.v1\ncount 2\npath 13\nagent/loop.ts\ndata 20\nexport const N = 1;\n\npath 15\nagent/prompt.md\ndata 9\n# system\n\n"
```

```
id     3c1ed617cef3c5b19aa7200aa51aaa540247bc21e4c5a0f0c33c9cc31a564d12
```

### 17.4 G3 — `harnessId` with Unicode paths

**Input, exactly. The content of each file matters.**

| Path | Content |
|---|---|
| `z.ts` | `"z\n"` |
| `é.ts` (U+00E9) | `"é\n"` |
| `a𐀀.ts` (U+10000) | `"a\n"` |
| `aﬀ.ts` (U+FB00) | `"ﬀ\n"` |

```
UTF-8 byte order    aﬀ.ts | a𐀀.ts | z.ts | é.ts
JS default sort     a𐀀.ts | aﬀ.ts | z.ts | é.ts     <- WRONG. This test catches it.
id                  2921c0977d6eae7388b8f8b0e954f18819a938185cb94fc434b67966ac526d2c
```

The two orders differ for astral-plane characters. A disagreement here gives two
machines two ids for the same tree. This is the most likely cause of a cross-machine
mismatch, so it is frozen.

> **Reconciled.** One design carried a Unicode vector but did not state the file
> contents, only "each content one letter". Its published hash is therefore not
> reproducible, and it is discarded. The table above states every byte.

### 17.5 G4 — `benchId`

Input:

```json
{"id":"petri-bench-v1","protocol":"petri/bench/1","tasks":[{"id":"01-chunk-array","testCount":10,"testsId":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},{"id":"02-run-length-encode","testCount":8,"testsId":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}],"total":2}
```

```
benchId  aa80a75294768bd3bc81ed688e6fd0b4ea2741b68c3508fa37b023f1d70b5cb8
```

### 17.6 G5 — a root `NodeManifest`

Canonical form, 465 bytes, exactly as hashed:

```json
{"author":"d04ab232742bb4ab3a1368bd4615e4e6d0224ab71a016baf8520a332c9778737","bench":"aa80a75294768bd3bc81ed688e6fd0b4ea2741b68c3508fa37b023f1d70b5cb8","detail":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","harness":"3c1ed617cef3c5b19aa7200aa51aaa540247bc21e4c5a0f0c33c9cc31a564d12","hypothesis":"Single-shot prompt. No retry. No test run. This is the honest baseline.","nonce":"","parent":"root","protocol":"petri/node/1","tree":"petri-main"}
```

```
nodeId  a5966c17a7d5ee36571983655df9c4c7e168b7602b90ae0b373d10b6b51e78a6
```

**Test this twice:** once with the keys inserted in the order above, and once with
`Object.fromEntries(Object.entries(manifest).reverse())`. Both must give the same
id. Verified true.

### 17.7 G6 — a child `NodeManifest`

Same author, same bench, `detail` is 64 `e` characters, `parent` is G5's node id.
The harness is G2 with `agent/loop.ts` changed to `export const N = 2;\n`.

```
harnessId  88658e3e002e3c34a8a83b4d9f4fce37c5686015e38a373578cc74747ce8701d
hypothesis "Because the prompt sends only symbol names, sending full signatures will raise the median by at least 500bp."
nodeId     a3572a8d3168357ad34c4afbebc65a4f55ccfa2c0bc5f157d4f65391dea75fa4
```

### 17.8 G7 — derived seeds for G6

```
seedBase  4c581ad0d819234f5a99865db43a8587ffca23ac77f7c3c3b63a7836f4018c22
seed_0    3243d3cd35431fc285c97fe2f6273f342ded906bbcb350f11ec84e98dc384bc2
seed_1    06746f61f42545668c29d7adc8477c9aeb4211965c701b73ac45e86b4032c4e7
seed_2    2240b3377b527447667e6b40d465fa344ad0784413bcc7559f32b1c8c273e91f
```

### 17.9 G8 — a `VerificationReport`

Three runs, total 20 tasks. Parent passes `[12, 12, 13]`. Candidate passes
`[15, 14, 15]`. `resultId` values are placeholders: run `i` of the parent uses 64
copies of the digit `i`, and run `i` of the candidate uses 64 copies of `i + 5`.
`mode` is `replay`. `startedAt` is `1789200000000`.

```
parent.medianBp     6000
candidate.medianBp  7500
deltaMedianBp       1000
reportId            ee768526e9dde63fce6f0df16b4d61c71061b322c648f3e4dbd7285d41f99adf
canonical bytes     2029
```

Signed by B over `"petri/v1/report\n" + canonicalBytes(report)`:

```
sig  7f699604f6329c5854591aedb7e0c66b88c99d9af25c40f28c13fb0cb32b29215c2f307ba014a753bfae226a280e49b20570c5354b7a6f2b3ce7afadebc75702
```

`verifyDetached(B, signingBytes('report', report), sig)` is `true`. Verified.
ed25519 is deterministic, so re-signing must give these exact 128 hex characters.

### 17.10 G9 — sealed wire messages

The `NodeSubmitted` for G6, signed by A, canonicalised:

```json
{"body":{"bench":"aa80a75294768bd3bc81ed688e6fd0b4ea2741b68c3508fa37b023f1d70b5cb8","hyp":"Because the prompt sends only symbol names, sending full signatures will raise the median by at least 500bp.","node":"a3572a8d3168357ad34c4afbebc65a4f55ccfa2c0bc5f157d4f65391dea75fa4","parent":"a5966c17a7d5ee36571983655df9c4c7e168b7602b90ae0b373d10b6b51e78a6","tree":"petri-main","type":"NodeSubmitted"},"pub":"d04ab232742bb4ab3a1368bd4615e4e6d0224ab71a016baf8520a332c9778737","sig":"38ce1b0a46fe537a42956f6c31421679faa238e18dc1b935ba2373b1f11ecdf36b529b149682ddd71bb81f9976310e906734618e5bd3fe97f8e70dcac889610e","ver":1}
```

Measured sizes for this vector set: `NodeSubmitted` 613 bytes,
`VerificationSigned` 667 bytes, `StatusChanged` with 2 verifiers 578 bytes.

The worst case, with a 64-character tree id and every cap filled:

| Message | Bytes | Headroom |
|---|---|---|
| `NodeSubmitted` | 797 | 227 |
| `VerificationSigned` | 749 | 275 |
| `StatusChanged`, 4 verifiers | 911 | 113 |

### 17.11 G10 — the local log hash chain

```
chainSeed("petri-main")        b35e642c36dd31d6ae4c8763a2712aad1e4b527e0fc563e6616b87476a804b43
after seq 1, NodeSubmitted     bd79f478865074e46bb76eaf75a6311afd4c63850d62c53413af31710a2e4a2c
after seq 2, VerificationSigned 3011cf04d968d5d15668419ffe6c3a02acb21a0c5216ad3b3106f909e6179c93
```

Sequence 1 uses `consensusNanos` `"1789200000000000000"` and the envelope of G9.
Sequence 2 uses `"1789200000000000001"` and the `VerificationSigned` of G9.

### 17.12 G11 — canonical encoder rejections

Every one of these must throw `CanonError`. Freeze the message prefix.

| Input | Message |
|---|---|
| `{ a: null }` | `canonical: null value at $.a` |
| `{ a: undefined }` | `canonical: undefined value at $.a` |
| `{ A: 1 }` | `canonical: illegal key "A" at $` |
| `{ 'a-b': 1 }` | `canonical: illegal key "a-b" at $` |
| `{ a: 1.5 }` | `canonical: non-integer number at $.a` |
| `{ a: 2 ** 53 }` | `canonical: unsafe integer at $.a` |
| `'\uD800'` | `canonical: lone high surrogate at $[0]` |
| `{ a: new Date() }` | `canonical: not a plain object at $.a` |

And two that must **succeed**:

```
canonicalJson({ a: '😂 ok' })            === '{"a":"😂 ok"}'
canonicalJson({ z: 1, a: 2 })            === '{"a":2,"z":1}'
```

---

## 18. What Petri does NOT protect against

Each item names the attack, says whether Petri detects it, and names the mitigation
that is out of scope.

### 18.1 The lazy verifier

**Attack.** B never runs the benchmark. B copies the author's claimed numbers into a
report, signs it, and publishes. The signature is valid. The medians are consistent.

**What Petri gives.** In `mode: replay` the benchmark is deterministic and the seeds
derive from the node id. Two honest verifiers must therefore produce **identical
`resultId` values** for each run. A lazy verifier who invents numbers will not
match. `petri replay --audit` reports it:

```
WARNING  node a3572a8d: verifiers a09aa5f4 and 17cb79fb disagree on run 3 resultId.
         At most one of them actually ran the benchmark.
```

In `mode: live`, model sampling makes run hashes differ honestly, so this check is
off and Petri has **no defence at all**.

**Out of scope.** Publishing per-run result bytes for third-party recomputation, a
trusted execution environment with an attested binary, or a bond that is slashed
after a random re-audit.

### 18.2 Sybil verifiers

**Attack.** One person generates two key pairs and verifies their own node twice.
`evaluate` sees two distinct public keys and accepts.

**Detection.** None. A public key is not a person. Hedera does not change this: it
proves two accounts paid, not that two people exist.

**Partly in scope.** `policy.trustedRunners` is a key allowlist. When it is not
empty, only listed keys count. That turns a permissionless tree into a curated one,
which is the right trade for a team and the wrong trade for an open network. It is
**off by default**, so the open case stays honest.

### 18.3 Benchmark overfitting

A node improves the specific tests and nothing else. Every verification is honest.
The recorded gain does not generalise. There is no detection inside a tree. The
bench id at least pins which tests were used, so the gaming is visible to a reader.
A held-out task split and a scheduled bench rotation are out of scope.

### 18.4 The in-process sandbox limit

The permission model is process-wide, so the solution shares a process with the test
code. It can reach the tests in memory even though it cannot reach them on disk. A
solution could walk the module graph, or monkey-patch `node:assert`.

**Partial mitigation only.** The attestation counts come from the `node:test` event
stream rather than from assertion side effects, which defeats naive `assert`
patching. Any exit-code and attestation disagreement is flagged `tampered`.
**A determined in-process attack is not blocked.** The real fix is one process per
task behind a message boundary, or an OS container. Both were rejected here, because
a judge must clone and run with no setup. This limit belongs in the README, not only
here.

### 18.5 Non-determinism in live mode

Not an attack. Model sampling and provider routing change scores between two honest
runs. A median over five runs reduces the noise. It does not remove it. A provider
change months later can make an accepted node wrong while the tree still says
`accepted`. Re-verification epochs with a `Revalidated` message type are out of
scope.

### 18.6 Key theft and key loss

`.petri/identity.json` holds an unencrypted seed. Mode 0600 stops other
unprivileged users. It does **not** stop root, a backup tool, or a malicious
postinstall script running as you. There is **no revocation**: a stolen key's past
signatures stay valid forever. An OS keychain, a passphrase with a key derivation
function, a hardware key and a revocation message type are all out of scope.

### 18.7 A front-run node

In fast replay the first `NodeSubmitted` for a node id defines its author. Somebody
could submit a stolen node under their own key before the real author does.
`petri replay --audit` catches it, because it fetches the manifest and checks
`manifest.author === envelope.pub`. Fast mode does not, and fast is the default.

### 18.8 The local log proves nothing about time or deletion

Delete `log.jsonl` and history restarts. That breaks design rule 3 and nothing stops
it. The `chain` field lets anyone holding an earlier copy prove a line was removed,
and `LocalLog.read` refuses to continue on a break. A fresh reader with no earlier
copy cannot tell. Only a real topic fixes this, and the banner of §8.9 says so.

### 18.9 Mirror node omission

A mirror could return a page that skips one message, turning a contested node into
an accepted one. `running_hash` chains every message, so a mirror that omits one
cannot produce a matching hash later. `config.hedera.mirrorRest` is an array so two
hosts can be compared. **Petri v1 queries the first host only.** Verifying the
running-hash chain locally is out of scope.

### 18.10 The honest summary

Petri makes three claims and no more.

1. **Every number is signed.** You know which key produced it.
2. **Every claim is paired.** A delta always comes with its own baseline re-run.
3. **Nothing can be deleted.** On a real topic, a rejected node stays visible forever.

Petri does **not** claim that two keys are two people. It does **not** claim that a
verifier ran the benchmark. Those need stake or attestation, and both are out of
scope. Any tool that claims them without that machinery is lying.

---

## 19. Invariants that `petri fsck` checks

| # | Invariant | Failure |
|---|---|---|
| 1 | For every node, `contentId(manifest) === id`. | error |
| 2 | For every node, the stored `envelope.json` opens, and `envelope.pub === manifest.author`. | error |
| 3 | Every `manifest.parent` exists, or is `'root'`. The graph is acyclic. | error |
| 4 | Every `manifest.harness` has an object, and rehashing that object through `harnessDigestInput` reproduces the id. | error |
| 5 | For every node, `detailIdOf(detail)` equals `manifest.detail`. That is `contentId` of the detail with `node` blanked, a `null` `whyNotUntested` dropped, and every observation field of §6.4a dropped. | error |
| 6 | For every verification, `checkReport` returns ok, and its id equals the file name. | error |
| 7 | No verification has `envelope.pub === manifest.author`. Design rule 1. | error |
| 8 | Regenerating `diff.patch` from the parent snapshot reproduces the stored text. | **warning** |
| 9 | Every `report.mode` equals its node's `detail.mode`. | error |
| 10 | The log chain reproduces from `chainSeed(treeId)`, and `seq` is gap-free. | error |
| 11 | Re-running `evaluate` for every node reproduces the status cached in `index/nodes.json`. | error |
| 12 | **Nothing was deleted.** Every node id named as a parent, and every report referenced in the log, is present on disk. Design rule 3. | error |
| 13 | `.petri/identity.json` has mode 0600, and its public key derives from its private key. | error |
| 14 | Every stored object parses against the schema its `protocol` field names. | error |

Check 8 is a warning because diff algorithms legitimately vary. The snapshots remain
the authority. Everything else is an error and exits 3.

`petri fsck --rebuild` regenerates `.petri/index/` from `nodes/` and `objects/`.
`petri fsck --strict` turns the warning into an error.

---

## 20. Reconciliation index

Every conflict between the four design tracks, the decision, and where it lives.

| # | Conflict | Decision | Where |
|---|---|---|---|
| 1 | Two canonical JSON encoders: byte-sorted with `null` allowed, versus JCS-restricted with no `null`. | One encoder. The JCS-restricted form, with ASCII lowerCamelCase keys, integers only, no `null`, and a UTF-8 byte sort. | §2 |
| 2 | `parent: null` versus a `'root'` sentinel. | The `'root'` sentinel. `null` is banned everywhere. | §1.2 |
| 3 | Prefixed ids (`petri1:`, `sha256:`, `ed25519:`) versus bare hex. | Bare Hex64 in every stored and transmitted byte. Prefixes are display only. | §1.1 |
| 4 | Domain separation by hash prefix versus an in-band `protocol` field. | `protocol` field for content ids. Hash prefix for signatures only. | §3.1, §5.2 |
| 5 | Absolute score comparison versus paired parent-and-candidate deltas. | Paired deltas. It also removes the `PARENT_UNVERIFIED` case. | §6.5 |
| 6 | `minDeltaBp: 1` versus a 2-task margin from a 400k-trial simulation. | **1000 bp**, which is the simulated 2-task margin expressed in basis points. | §4.1 |
| 7 | Integer task counts versus `Rational {n,d}` versus basis points. | Basis points, with `passed` and `total` carried beside every score. | §6.6 |
| 8 | Lower median versus textbook median for even run counts. | An even run count is a hard error, so both definitions become one. | §6.6 |
| 9 | Pooling every run across verifiers versus per-verifier paired deltas. | Per-verifier deltas, and every counted verifier must clear the margin. | §6.6, §9.3 |
| 10 | Status sets: `{accepted, rejected, unverified}`, `{candidate, rejected}`, `{proposed, measured, replay-verified, accepted, rejected}`, `{pending, accepted, rejected, contested, withdrawn, superseded}`. | The last one. `unverified` and `candidate` both become `pending`. | §6.10 |
| 11 | Replay nodes can never be accepted, versus the rule applies unchanged in replay. | A replay node **can** be accepted inside a replay tree. Cross-mode comparison stays banned in both directions. Design rule 6 needs acceptance to fire in the demo. | §9.6 |
| 12 | Status cached in `node.json` versus derived on load. | Always derived. `index/` may cache it, and fsck check 11 compares. | §6.10 |
| 13 | `diff` hashed into the node id versus excluded. | Excluded from the id and from the wire. It is display output, regenerated by fsck check 8. | §8.3 |
| 14 | `StatusChanged.verifiers` capped at 8. | Capped at 4. Eight measured 1125 bytes and does not fit one HCS chunk. | §8.3 |
| 15 | `NodeSubmitted` carrying `harness` and `detail`. | Neither. Both live in the manifest, which `node` commits to. It buys 100 to 150 bytes of headroom. | §8.3 |
| 16 | Harness entry `solve(input) => {source, usage}` versus `solve(task, ctx) => Solution`. | `solve(task: TaskView, ctx: HarnessContext): Promise<Solution>`. Without `ctx` there is no budget, no trace and no seeded RNG. | §11.2 |
| 17 | The contract in `src/` versus in `harness/`. | `harness/contract.ts`. The harness then imports nothing outside itself. | §11.2 |
| 18 | Tasks in TypeScript with `task.yaml` and `tests/` versus JavaScript with `task.json` and `test.mjs`. | JavaScript, `task.json`, one `test.mjs`. The sandbox cannot afford a build step. | §10.5 |
| 19 | Recorded fixtures versus a graded-answer replay client. | Both, for two different jobs. A fixture miss is a hard error unless `--allow-graded` is passed. | §11.5 |
| 20 | Exit code alone versus exit code plus an fd-3 attestation. | Both channels must agree. stdout is still drained and never parsed. | §10.7 |
| 21 | Mode names `sim`/`real` versus `live`/`replay` versus `hedera`/`offline`. | Two axes: `mode: live\|replay` and `ledger: hcs\|local`. | §1 |
| 22 | A separate `Seq` ordering key with `c`/`l` prefixes and an epoch. | Removed. `LogEntry.seq` is the only order, in both ledgers. | §8.1 |
| 23 | `ObjectStore` over `Buffer` versus over `Canon`. | `Canon`, synchronous. A `Buffer` store could hold bytes nothing can rehash. | §7.8 |
| 24 | `petri evolve` writing `rejected` for a mechanical failure. | It writes no status at all. A mechanically failed node is `pending` with its reason in `detail.mechanical`. | §13.1 |
| 25 | Three different `.petri/` layouts. | One tree, one name per thing, with sharded node directories. | §7 |
| 26 | A Unicode golden vector with unstated file contents. | Discarded and regenerated, with every byte stated. | §17.4 |

---

## 21. What is deliberately NOT in v1

Say this out loud, so nobody builds it by accident and nobody claims it exists.

- No revocation of a stolen key.
- No stake, no slashing, no attestation.
- No held-out benchmark split and no bench rotation.
- No re-verification epochs.
- No cross-task memory in the harness. `HarnessContext` is fresh per task.
- No agentic harness. The harness cannot read files or run tools under contract v1.
- No multi-mirror cross-check. Petri queries the first host only.
- No local verification of the Hedera running-hash chain.
- No binary files in a harness snapshot. UTF-8 text only, and no carriage returns.
- No bundler. `tsx` runs the TypeScript directly.
