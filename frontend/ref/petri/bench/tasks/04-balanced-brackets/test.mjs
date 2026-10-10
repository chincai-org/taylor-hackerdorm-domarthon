import test from 'node:test';
import assert from 'node:assert/strict';
import { isBalanced } from './solution.mjs';

test('accepts balanced input', () => {
  assert.equal(isBalanced('a(b)[c]{d}'), true);
  assert.equal(isBalanced('({[]})'), true);
  assert.equal(isBalanced(''), true);
});

test('rejects a wrong nesting order', () => {
  assert.equal(isBalanced('([)]'), false);
  assert.equal(isBalanced('{(})'), false);
});

test('rejects an unclosed bracket', () => {
  assert.equal(isBalanced('('), false);
  assert.equal(isBalanced('a(b[c]'), false);
});

test('rejects a closing bracket with no opening one', () => {
  assert.equal(isBalanced(')('), false);
  assert.equal(isBalanced('a]'), false);
});

test('ignores brackets inside quoted strings', () => {
  assert.equal(isBalanced('a = "]"'), true);
  assert.equal(isBalanced("x = ('[') + '('"), true);
  assert.equal(isBalanced('"("'), true);
});

test('the other quote has no meaning inside a string', () => {
  assert.equal(isBalanced('if (x) { y["don\'t"] }'), true);
  assert.equal(isBalanced("'say \"hi\" ('"), true);
});

test('a backslash escapes the next character inside a string', () => {
  assert.equal(isBalanced('f("\\"(")'), true);
  assert.equal(isBalanced('("\\")'), false);
});

test('rejects an unterminated string and a non-string argument', () => {
  assert.equal(isBalanced('("abc)'), false);
  assert.throws(() => isBalanced(['(']), TypeError);
});
