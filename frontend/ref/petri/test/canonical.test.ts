/**
 * The canonical encoder and the frozen golden vectors. SPEC.md sections 2 and 17.
 *
 * These bytes are the contract between two machines. If this file fails, two
 * runners compute two different ids for one object, and every signature check
 * between them fails with no useful message. Nothing else in Petri would notice.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CanonError, byteCompare, canonicalBytes, canonicalJson, contentId, sha256Hex,
  type Canon,
} from '../src/core/canonical.js';
import { EMPTY_HARNESS_ID, benchIdOf, harnessDigestInput, harnessId } from '../src/core/ids.js';
import type { BenchSpec } from '../src/core/schema.js';

/* -------------------------------------------------------------------------- */
/* G11 — the encoder rejections. SPEC.md section 17.12.                        */
/* -------------------------------------------------------------------------- */

const REJECTIONS: { name: string; value: unknown; message: string }[] = [
  { name: 'a null value', value: { a: null }, message: 'canonical: null value at $.a' },
  { name: 'an undefined value', value: { a: undefined }, message: 'canonical: undefined value at $.a' },
  { name: 'an upper-case key', value: { A: 1 }, message: 'canonical: illegal key "A" at $' },
  { name: 'a hyphen in a key', value: { 'a-b': 1 }, message: 'canonical: illegal key "a-b" at $' },
  { name: 'a float', value: { a: 1.5 }, message: 'canonical: non-integer number at $.a' },
  { name: 'an unsafe integer', value: { a: 2 ** 53 }, message: 'canonical: unsafe integer at $.a' },
  { name: 'a lone high surrogate', value: '\uD800', message: 'canonical: lone high surrogate at $[0]' },
  { name: 'a Date', value: { a: new Date() }, message: 'canonical: not a plain object at $.a' },
];

for (const row of REJECTIONS) {
  test(`canonicalJson refuses ${row.name}`, () => {
    assert.throws(
      () => canonicalJson(row.value as Canon),
      (err: unknown) => {
        assert.ok(err instanceof CanonError, 'the error must be a CanonError');
        assert.equal(err.message, row.message);
        return true;
      },
    );
  });
}

test('canonicalJson refuses a lone low surrogate', () => {
  assert.throws(() => canonicalJson('\uDC00' as Canon), CanonError);
});

/* -------------------------------------------------------------------------- */
/* G11 — the two that must succeed.                                           */
/* -------------------------------------------------------------------------- */

test('canonicalJson keeps an astral character verbatim', () => {
  assert.equal(canonicalJson({ a: '\u{1F602} ok' }), '{"a":"\u{1F602} ok"}');
});

test('canonicalJson sorts keys, whatever order they were inserted in', () => {
  assert.equal(canonicalJson({ z: 1, a: 2 }), '{"a":2,"z":1}');
});

test('canonicalJson maps minus zero to zero', () => {
  assert.equal(canonicalJson({ a: -0 }), '{"a":0}');
});

test('byteCompare orders by UTF-8 bytes, not by UTF-16 code units', () => {
  // The astral character sorts AFTER U+FB00 by bytes and BEFORE it by the default
  // JS sort. This one difference gives two machines two ids for one tree.
  assert.ok(byteCompare('aﬀ.ts', 'a\u{10000}.ts') < 0);
  assert.ok('aﬀ.ts' > 'a\u{10000}.ts', 'the default JS sort disagrees, as it must');
});

/* -------------------------------------------------------------------------- */
/* Section 2.2 — the property that makes nesting safe.                        */
/* -------------------------------------------------------------------------- */

test('canonicalJson is stable through a JSON round trip', () => {
  const value: Canon = {
    body: { deep: { a: 1, z: [1, 2, { b: true, a: 'x' }] } },
    outer: 'ok',
  };
  const once = canonicalJson(value);
  assert.equal(canonicalJson(JSON.parse(once) as Canon), once);
});

test('a nested body canonicalises to the same bytes as that body alone', () => {
  const body: Canon = { hyp: 'a plain English hypothesis', node: 'abc' };
  const envelope: Canon = { body, pub: 'ff', sig: '00', ver: 1 };
  const alone = canonicalJson(body);
  assert.ok(canonicalJson(envelope).includes(alone));
});

test('canonicalBytes is the UTF-8 encoding of canonicalJson', () => {
  const value: Canon = { a: '\u{1F602}' };
  assert.deepEqual(canonicalBytes(value), Buffer.from(canonicalJson(value), 'utf8'));
});

/* -------------------------------------------------------------------------- */
/* G1, G2, G3 — harness ids. SPEC.md sections 17.2 to 17.4.                    */
/* -------------------------------------------------------------------------- */

test('G1: the empty harness id is frozen', () => {
  assert.equal(
    harnessDigestInput({}).toString('utf8'),
    'petri.harness.v1\ncount 0\n',
  );
  assert.equal(harnessId({}), '5894095975556df34aedf9a9be1228f959515821141de45e140f46890fe83a59');
  assert.equal(harnessId({}), EMPTY_HARNESS_ID);
});

test('G2: two files hash to the frozen id, through the frozen bytes', () => {
  const snapshot = {
    'agent/loop.ts': 'export const N = 1;\n',
    'agent/prompt.md': '# system\n',
  };
  assert.equal(
    harnessDigestInput(snapshot).toString('utf8'),
    'petri.harness.v1\ncount 2\n'
    + 'path 13\nagent/loop.ts\ndata 20\nexport const N = 1;\n\n'
    + 'path 15\nagent/prompt.md\ndata 9\n# system\n\n',
  );
  assert.equal(
    harnessId(snapshot),
    '3c1ed617cef3c5b19aa7200aa51aaa540247bc21e4c5a0f0c33c9cc31a564d12',
  );
});

test('G2: the insertion order of the snapshot does not change the id', () => {
  const a = { 'agent/loop.ts': 'export const N = 1;\n', 'agent/prompt.md': '# system\n' };
  const b = { 'agent/prompt.md': '# system\n', 'agent/loop.ts': 'export const N = 1;\n' };
  assert.equal(harnessId(a), harnessId(b));
});

test('G3: Unicode paths sort by UTF-8 bytes', () => {
  const snapshot = {
    'z.ts': 'z\n',
    'é.ts': 'é\n',
    'a\u{10000}.ts': 'a\n',
    'aﬀ.ts': 'ﬀ\n',
  };
  assert.equal(
    harnessId(snapshot),
    '2921c0977d6eae7388b8f8b0e954f18819a938185cb94fc434b67966ac526d2c',
  );
});

/* -------------------------------------------------------------------------- */
/* G4 — the bench id. SPEC.md section 17.5.                                    */
/* -------------------------------------------------------------------------- */

const G4_SPEC: BenchSpec = {
  protocol: 'petri/bench/1',
  id: 'petri-bench-v1',
  tasks: [
    { id: '01-chunk-array', testCount: 10, testsId: 'a'.repeat(64) },
    { id: '02-run-length-encode', testCount: 8, testsId: 'b'.repeat(64) },
  ],
  total: 2,
};

test('G4: the bench id is frozen', () => {
  assert.equal(
    canonicalJson(G4_SPEC as unknown as Canon),
    '{"id":"petri-bench-v1","protocol":"petri/bench/1","tasks":['
    + `{"id":"01-chunk-array","testCount":10,"testsId":"${'a'.repeat(64)}"},`
    + `{"id":"02-run-length-encode","testCount":8,"testsId":"${'b'.repeat(64)}"}`
    + '],"total":2}',
  );
  assert.equal(
    benchIdOf(G4_SPEC),
    'aa80a75294768bd3bc81ed688e6fd0b4ea2741b68c3508fa37b023f1d70b5cb8',
  );
});

/* -------------------------------------------------------------------------- */
/* One hash helper, one content id.                                            */
/* -------------------------------------------------------------------------- */

test('sha256Hex treats a string as its UTF-8 bytes', () => {
  assert.equal(sha256Hex('abc'), sha256Hex(Buffer.from('abc', 'utf8')));
  assert.equal(
    sha256Hex(''),
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  );
});

test('contentId is sha256Hex of canonicalBytes', () => {
  const value: Canon = { a: 1, z: 'two' };
  assert.equal(contentId(value), sha256Hex(canonicalBytes(value)));
});
