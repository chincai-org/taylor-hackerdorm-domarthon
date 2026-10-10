import test from 'node:test';
import assert from 'node:assert/strict';
import { createCache } from './solution.mjs';

test('stores and reads values', () => {
  const c = createCache(2);
  c.set('a', 1);
  assert.equal(c.get('a'), 1);
  assert.equal(c.has('a'), true);
  assert.equal(c.get('zz'), undefined);
  assert.equal(c.size(), 1);
});

test('removes the least recently used entry', () => {
  const c = createCache(2);
  c.set('a', 1);
  c.set('b', 2);
  c.set('c', 3);
  assert.equal(c.has('a'), false);
  assert.equal(c.get('b'), 2);
  assert.equal(c.get('c'), 3);
  assert.equal(c.size(), 2);
});

test('get counts as a use', () => {
  const c = createCache(2);
  c.set('a', 1);
  c.set('b', 2);
  c.get('a');
  c.set('c', 3);
  assert.equal(c.has('a'), true);
  assert.equal(c.has('b'), false);
});

test('has does not count as a use', () => {
  const c = createCache(2);
  c.set('a', 1);
  c.set('b', 2);
  c.has('a');
  c.keys();
  c.size();
  c.set('c', 3);
  assert.equal(c.has('a'), false);
  assert.equal(c.has('b'), true);
});

test('setting an existing key updates it and counts as a use', () => {
  const c = createCache(2);
  c.set('a', 1);
  c.set('b', 2);
  c.set('a', 9);
  assert.equal(c.size(), 2);
  c.set('c', 3);
  assert.equal(c.get('a'), 9);
  assert.equal(c.has('b'), false);
});

test('keys are ordered from least to most recently used', () => {
  const c = createCache(3);
  c.set('a', 1);
  c.set('b', 2);
  c.set('c', 3);
  assert.deepEqual(c.keys(), ['a', 'b', 'c']);
  c.get('a');
  assert.deepEqual(c.keys(), ['b', 'c', 'a']);
});

test('a capacity of zero stores nothing', () => {
  const c = createCache(0);
  c.set('a', 1);
  assert.equal(c.size(), 0);
  assert.equal(c.has('a'), false);
  assert.equal(c.get('a'), undefined);
  assert.deepEqual(c.keys(), []);
});

test('delete reports whether the key was held', () => {
  const c = createCache(2);
  c.set('a', 1);
  assert.equal(c.delete('a'), true);
  assert.equal(c.delete('a'), false);
  assert.equal(c.size(), 0);
});

test('stores an undefined value and non-string keys', () => {
  const c = createCache(2);
  c.set('a', undefined);
  assert.equal(c.has('a'), true);
  assert.equal(c.get('a'), undefined);
  const key = {};
  c.set(key, 5);
  assert.equal(c.get(key), 5);
  assert.equal(c.has({}), false);
});

test('rejects a bad capacity and keeps caches separate', () => {
  assert.throws(() => createCache(-1), RangeError);
  assert.throws(() => createCache(1.5), RangeError);
  assert.throws(() => createCache('2'), TypeError);
  const one = createCache(2);
  const two = createCache(2);
  one.set('a', 1);
  assert.equal(two.size(), 0);
});
