import test from 'node:test';
import assert from 'node:assert/strict';
import { deepEqual } from './solution.mjs';

test('compares primitives with Object.is semantics', () => {
  assert.equal(deepEqual(1, 1), true);
  assert.equal(deepEqual(NaN, NaN), true);
  assert.equal(deepEqual(0, -0), false);
  assert.equal(deepEqual(1, '1'), false);
});

test('compares nested structures', () => {
  assert.equal(deepEqual({ x: [1, { y: 2 }] }, { x: [1, { y: 2 }] }), true);
  assert.equal(deepEqual({ x: [1, { y: 2 }] }, { x: [1, { y: 3 }] }), false);
});

test('key order does not matter', () => {
  assert.equal(deepEqual({ a: 1, b: 2 }, { b: 2, a: 1 }), true);
});

test('a present undefined key differs from a missing key', () => {
  assert.equal(deepEqual({ a: undefined }, {}), false);
  assert.equal(deepEqual({}, { a: undefined }), false);
  assert.equal(deepEqual({ a: undefined }, { a: undefined }), true);
});

test('arrays compare by length and index', () => {
  assert.equal(deepEqual([1, 2], [1, 2, 3]), false);
  assert.equal(deepEqual([1, 2], [2, 1]), false);
  assert.equal(deepEqual([], []), true);
});

test('an array never equals a plain object', () => {
  assert.equal(deepEqual([], {}), false);
  assert.equal(deepEqual({ 0: 1, length: 1 }, [1]), false);
});

test('compares dates by time', () => {
  assert.equal(deepEqual(new Date(1000), new Date(1000)), true);
  assert.equal(deepEqual(new Date(1000), new Date(2000)), false);
  assert.equal(deepEqual(new Date(1000), 1000), false);
});

test('null compares only with null', () => {
  assert.equal(deepEqual(null, null), true);
  assert.equal(deepEqual(null, {}), false);
  assert.equal(deepEqual({}, null), false);
});

test('equal cyclic structures do not hang', () => {
  const a = { name: 'a' };
  a.self = a;
  const b = { name: 'a' };
  b.self = b;
  assert.equal(deepEqual(a, b), true);
});

test('unequal cyclic structures return false', () => {
  const a = { v: 1 };
  a.self = a;
  const b = { v: 2 };
  b.self = b;
  assert.equal(deepEqual(a, b), false);
});
