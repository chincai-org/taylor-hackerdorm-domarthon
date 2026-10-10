import test from 'node:test';
import assert from 'node:assert/strict';
import { resolvePointer } from './solution.mjs';

const doc = {
  a: { b: [10, 20] },
  '': 'empty key',
  'm~n': 1,
  'a/b': 2,
  '~1': 'tilde one',
  zero: 0,
  nul: null,
  list: [{ x: 1 }],
};

test('the empty pointer selects the whole document', () => {
  assert.equal(resolvePointer(doc, ''), doc);
});

test('walks objects and arrays', () => {
  assert.equal(resolvePointer(doc, '/a/b/1'), 20);
  assert.equal(resolvePointer(doc, '/a/b/0'), 10);
  assert.deepEqual(resolvePointer(doc, '/a'), { b: [10, 20] });
});

test('returns the value itself, not a copy', () => {
  assert.equal(resolvePointer(doc, '/list/0'), doc.list[0]);
});

test('an empty token is the empty key', () => {
  assert.equal(resolvePointer(doc, '/'), 'empty key');
});

test('unescapes tilde sequences', () => {
  assert.equal(resolvePointer(doc, '/m~0n'), 1);
  assert.equal(resolvePointer(doc, '/a~1b'), 2);
});

test('unescapes ~1 before ~0', () => {
  assert.equal(resolvePointer(doc, '/~01'), 'tilde one');
});

test('falsy values are real results', () => {
  assert.equal(resolvePointer(doc, '/zero'), 0);
  assert.equal(resolvePointer(doc, '/nul'), null);
});

test('rejects a malformed pointer', () => {
  assert.throws(() => resolvePointer(doc, 'a'), SyntaxError);
  assert.throws(() => resolvePointer(doc, 'a/b'), SyntaxError);
  assert.throws(() => resolvePointer(doc, '/m~2n'), SyntaxError);
  assert.throws(() => resolvePointer(doc, '/m~'), SyntaxError);
  assert.throws(() => resolvePointer(doc, 1), TypeError);
});

test('rejects a bad array index', () => {
  assert.throws(() => resolvePointer(doc, '/a/b/01'), SyntaxError);
  assert.throws(() => resolvePointer(doc, '/a/b/-'), SyntaxError);
  assert.throws(() => resolvePointer(doc, '/a/b/length'), SyntaxError);
  assert.throws(() => resolvePointer(doc, '/a/b/2'), ReferenceError);
});

test('rejects a missing or inherited key', () => {
  assert.throws(() => resolvePointer(doc, '/nope'), ReferenceError);
  assert.throws(() => resolvePointer(doc, '/toString'), ReferenceError);
  assert.throws(() => resolvePointer(Object.create({ hidden: 1 }), '/hidden'), ReferenceError);
});

test('rejects a walk into a primitive or null', () => {
  assert.throws(() => resolvePointer(doc, '/zero/x'), ReferenceError);
  assert.throws(() => resolvePointer(doc, '/nul/x'), ReferenceError);
  assert.throws(() => resolvePointer(doc, '/m~0n/0'), ReferenceError);
});
