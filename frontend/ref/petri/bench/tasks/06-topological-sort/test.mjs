import test from 'node:test';
import assert from 'node:assert/strict';
import { toposort } from './solution.mjs';

test('orders a chain', () => {
  assert.deepEqual(toposort(['a', 'b', 'c'], [['a', 'b'], ['b', 'c']]), ['a', 'b', 'c']);
});

test('keeps the given order when there are no edges', () => {
  assert.deepEqual(toposort(['c', 'a', 'b'], []), ['c', 'a', 'b']);
  assert.deepEqual(toposort([], []), []);
});

test('breaks ties by position in nodes, after every placement', () => {
  assert.deepEqual(toposort(['a', 'b', 'c', 'd'], [['b', 'a']]), ['b', 'a', 'c', 'd']);
  assert.deepEqual(
    toposort(['a', 'b', 'c', 'd'], [['a', 'd'], ['b', 'd'], ['c', 'b']]),
    ['a', 'c', 'b', 'd'],
  );
});

test('accepts duplicate edges', () => {
  assert.deepEqual(
    toposort(['a', 'b'], [['a', 'b'], ['a', 'b'], ['a', 'b']]),
    ['a', 'b'],
  );
});

test('does not change the arguments', () => {
  const nodes = ['b', 'a'];
  const edges = [['a', 'b']];
  toposort(nodes, edges);
  assert.deepEqual(nodes, ['b', 'a']);
  assert.deepEqual(edges, [['a', 'b']]);
});

test('throws on a cycle', () => {
  assert.throws(() => toposort(['a', 'b'], [['a', 'b'], ['b', 'a']]), /cycle/);
  assert.throws(() => toposort(['a'], [['a', 'a']]), /cycle/);
});

test('throws on an edge that names an unknown node', () => {
  assert.throws(() => toposort(['a'], [['a', 'z']]), RangeError);
  assert.throws(() => toposort(['a'], [['z', 'a']]), RangeError);
});

test('throws on bad shapes', () => {
  assert.throws(() => toposort('ab', []), TypeError);
  assert.throws(() => toposort(['a'], 'x'), TypeError);
  assert.throws(() => toposort(['a', 'a'], []), TypeError);
  assert.throws(() => toposort([1, 2], []), TypeError);
  assert.throws(() => toposort(['a', 'b'], [['a', 'b', 'c']]), TypeError);
});
