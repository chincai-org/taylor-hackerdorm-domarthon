import test from 'node:test';
import assert from 'node:assert/strict';
import { setIn } from './solution.mjs';

const state = () => ({
  user: { name: 'Ada', tags: ['x', 'y'] },
  other: { deep: { n: 1 } },
  list: [{ id: 0 }, { id: 1 }],
});

test('sets a shallow key and leaves the original alone', () => {
  const s = { a: 1, b: 2 };
  const out = setIn(s, ['a'], 9);
  assert.deepEqual(out, { a: 9, b: 2 });
  assert.deepEqual(s, { a: 1, b: 2 });
  assert.notEqual(out, s);
});

test('sets a deep key', () => {
  const s = state();
  const out = setIn(s, ['user', 'name'], 'Bea');
  assert.equal(out.user.name, 'Bea');
  assert.equal(s.user.name, 'Ada');
});

test('shares every branch the path does not enter', () => {
  const s = state();
  const out = setIn(s, ['user', 'name'], 'Bea');
  assert.equal(out.other, s.other);
  assert.equal(out.list, s.list);
  assert.equal(out.user.tags, s.user.tags);
  assert.notEqual(out.user, s.user);
});

test('copies arrays as arrays and shares untouched elements', () => {
  const s = state();
  const out = setIn(s, ['list', 1, 'id'], 99);
  assert.ok(Array.isArray(out.list));
  assert.equal(out.list[1].id, 99);
  assert.equal(out.list[0], s.list[0]);
  assert.notEqual(out.list, s.list);
  assert.equal(s.list[1].id, 1);
});

test('an empty path returns the value', () => {
  const s = state();
  assert.equal(setIn(s, [], 7), 7);
});

test('a write that changes nothing returns the same object', () => {
  const s = state();
  assert.equal(setIn(s, ['user', 'name'], 'Ada'), s);
  assert.equal(setIn(s, ['other', 'deep'], s.other.deep), s);
  assert.equal(setIn(s, ['list', 0], s.list[0]), s);
});

test('the no-change test is Object.is, not ===', () => {
  const s = { a: NaN, z: 0 };
  assert.equal(setIn(s, ['a'], NaN), s);
  assert.notEqual(setIn(s, ['z'], -0), s);
  assert.ok(Object.is(setIn(s, ['z'], -0).z, -0));
});

test('creates a missing object or array from the next key', () => {
  assert.deepEqual(setIn({}, ['a', 'b'], 1), { a: { b: 1 } });
  const made = setIn({}, ['a', 0], 1);
  assert.ok(Array.isArray(made.a));
  assert.deepEqual(made.a, [1]);
});

test('replaces a non-container on the way', () => {
  const s = { a: 5 };
  assert.deepEqual(setIn(s, ['a', 'b'], 1), { a: { b: 1 } });
  assert.deepEqual(s, { a: 5 });
  assert.deepEqual(setIn({ a: null }, ['a', 'b'], 1), { a: { b: 1 } });
});

test('appends at the end of an array', () => {
  const s = { list: [1, 2] };
  assert.deepEqual(setIn(s, ['list', 2], 3).list, [1, 2, 3]);
  assert.deepEqual(s.list, [1, 2]);
});

test('rejects an index past the end and a negative index', () => {
  const s = { list: [1, 2] };
  assert.throws(() => setIn(s, ['list', 3], 9), RangeError);
  assert.throws(() => setIn(s, ['list', -1], 9), TypeError);
  assert.throws(() => setIn(s, ['list', 1.5], 9), TypeError);
});

test('rejects mismatched keys and bad arguments', () => {
  const s = state();
  assert.throws(() => setIn(s, ['list', 'x'], 1), TypeError);
  assert.throws(() => setIn(s, ['user', 0], 1), TypeError);
  assert.throws(() => setIn(s, 'user', 1), TypeError);
  assert.throws(() => setIn(s, [null], 1), TypeError);
  assert.throws(() => setIn(5, ['a'], 1), TypeError);
  assert.throws(() => setIn(null, ['a'], 1), TypeError);
});
