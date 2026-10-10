import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeIntervals } from './solution.mjs';

test('merges overlapping intervals', () => {
  assert.deepEqual(mergeIntervals([[1, 3], [2, 6], [8, 10]]), [[1, 6], [8, 10]]);
});

test('merges touching intervals', () => {
  assert.deepEqual(mergeIntervals([[1, 2], [2, 3]]), [[1, 3]]);
});

test('sorts unsorted input', () => {
  assert.deepEqual(mergeIntervals([[5, 6], [1, 2]]), [[1, 2], [5, 6]]);
});

test('swallows a contained interval', () => {
  assert.deepEqual(mergeIntervals([[1, 10], [2, 3], [4, 5]]), [[1, 10]]);
});

test('keeps a zero-width interval', () => {
  assert.deepEqual(mergeIntervals([[4, 4]]), [[4, 4]]);
  assert.deepEqual(mergeIntervals([[1, 5], [4, 4]]), [[1, 5]]);
});

test('empty input gives an empty array', () => {
  assert.deepEqual(mergeIntervals([]), []);
});

test('does not mutate the input array or its pairs', () => {
  const pairs = [[5, 6], [1, 2]];
  const copy = [pairs[0], pairs[1]];
  mergeIntervals(pairs);
  assert.deepEqual(pairs, [[5, 6], [1, 2]]);
  assert.equal(pairs[0], copy[0]);
  assert.equal(pairs[1], copy[1]);
});

test('result pairs are new arrays', () => {
  const pairs = [[1, 2], [5, 6]];
  const out = mergeIntervals(pairs);
  assert.deepEqual(out, [[1, 2], [5, 6]]);
  assert.notEqual(out[0], pairs[0]);
  assert.notEqual(out[1], pairs[1]);
});

test('rejects a non-array input and a bad pair shape', () => {
  assert.throws(() => mergeIntervals('nope'), TypeError);
  assert.throws(() => mergeIntervals([[1, 2, 3]]), TypeError);
  assert.throws(() => mergeIntervals([[1]]), TypeError);
  assert.throws(() => mergeIntervals([{ start: 1, end: 2 }]), TypeError);
});

test('rejects non-finite numbers and non-numbers', () => {
  assert.throws(() => mergeIntervals([[1, NaN]]), TypeError);
  assert.throws(() => mergeIntervals([[1, Infinity]]), TypeError);
  assert.throws(() => mergeIntervals([['1', 2]]), TypeError);
});

test('validates every pair, not only the first', () => {
  assert.throws(() => mergeIntervals([[1, 2], [3, 1]]), RangeError);
  assert.throws(() => mergeIntervals([[1, 2], [3, 4], [5, NaN]]), TypeError);
});
