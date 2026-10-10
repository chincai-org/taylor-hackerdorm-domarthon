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
