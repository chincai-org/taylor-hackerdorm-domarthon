import test from 'node:test';
import assert from 'node:assert/strict';
import { diffLines } from './solution.mjs';

const rebuild = (script, ops) => script.filter((s) => ops.includes(s.op)).map((s) => s.line);
const cost = (script) => script.filter((s) => s.op !== 'keep').length;

test('marks a deleted middle line', () => {
  assert.deepEqual(diffLines(['a', 'b', 'c'], ['a', 'c']), [
    { op: 'keep', line: 'a' },
    { op: 'remove', line: 'b' },
    { op: 'keep', line: 'c' },
  ]);
});

test('marks an inserted middle line', () => {
  assert.deepEqual(diffLines(['a', 'c'], ['a', 'b', 'c']), [
    { op: 'keep', line: 'a' },
    { op: 'add', line: 'b' },
    { op: 'keep', line: 'c' },
  ]);
});

test('handles empty sides', () => {
  assert.deepEqual(diffLines([], []), []);
  assert.deepEqual(diffLines([], ['x']), [{ op: 'add', line: 'x' }]);
  assert.deepEqual(diffLines(['x'], []), [{ op: 'remove', line: 'x' }]);
});

test('identical input is all keeps', () => {
  assert.deepEqual(diffLines(['a', 'b'], ['a', 'b']), [
    { op: 'keep', line: 'a' },
    { op: 'keep', line: 'b' },
  ]);
});

test('a replaced line removes before it adds', () => {
  assert.deepEqual(diffLines(['a'], ['b']), [
    { op: 'remove', line: 'a' },
    { op: 'add', line: 'b' },
  ]);
});

test('applies the tie-break on a swap', () => {
  assert.deepEqual(diffLines(['x', 'a'], ['a', 'x']), [
    { op: 'remove', line: 'x' },
    { op: 'keep', line: 'a' },
    { op: 'add', line: 'x' },
  ]);
});

test('picks the longer common subsequence, not the first match', () => {
  assert.deepEqual(diffLines(['a', 'b', 'c'], ['c', 'a', 'b']), [
    { op: 'add', line: 'c' },
    { op: 'keep', line: 'a' },
    { op: 'keep', line: 'b' },
    { op: 'remove', line: 'c' },
  ]);
});

test('groups a removed block before an added block', () => {
  assert.deepEqual(diffLines(['a', 'b', 'z'], ['c', 'd', 'z']), [
    { op: 'remove', line: 'a' },
    { op: 'remove', line: 'b' },
    { op: 'add', line: 'c' },
    { op: 'add', line: 'd' },
    { op: 'keep', line: 'z' },
  ]);
});

test('each entry has op before line and nothing else', () => {
  for (const entry of diffLines(['a', 'b'], ['b', 'c'])) {
    assert.deepEqual(Object.keys(entry), ['op', 'line']);
  }
});

test('the script rebuilds both sides and stays minimal', () => {
  const a = ['1', '2', '3', '4', '5', '6', '7'];
  const b = ['2', '9', '4', '5', '8', '7', '10'];
  const script = diffLines(a, b);
  assert.deepEqual(rebuild(script, ['keep', 'remove']), a);
  assert.deepEqual(rebuild(script, ['keep', 'add']), b);
  assert.equal(cost(script), 6);
});

test('rejects bad arguments and does not mutate the input', () => {
  assert.throws(() => diffLines('ab', []), TypeError);
  assert.throws(() => diffLines([], 'ab'), TypeError);
  assert.throws(() => diffLines([1], []), TypeError);
  assert.throws(() => diffLines([], [null]), TypeError);
  const a = ['a', 'b'];
  const b = ['b'];
  diffLines(a, b);
  assert.deepEqual(a, ['a', 'b']);
  assert.deepEqual(b, ['b']);
});

test('handles 500 lines on each side', () => {
  const a = Array.from({ length: 500 }, (_, i) => `line ${i}`);
  const b = a.map((s, i) => (i % 50 === 0 ? `changed ${i}` : s));
  const script = diffLines(a, b);
  assert.deepEqual(rebuild(script, ['keep', 'remove']), a);
  assert.deepEqual(rebuild(script, ['keep', 'add']), b);
  assert.equal(cost(script), 20);
});
