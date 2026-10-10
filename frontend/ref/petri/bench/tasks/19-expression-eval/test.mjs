import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from './solution.mjs';

test('applies precedence', () => {
  assert.equal(evaluate('1 + 2 * 3'), 7);
  assert.equal(evaluate('2 * 3 + 1'), 7);
  assert.equal(evaluate('1 + 6 / 3'), 3);
});

test('parentheses override precedence', () => {
  assert.equal(evaluate('(1 + 2) * 3'), 9);
  assert.equal(evaluate('((2))'), 2);
  assert.equal(evaluate('2 * (3 + (4 - 1))'), 12);
});

test('equal precedence groups to the left', () => {
  assert.equal(evaluate('2 - 3 - 4'), -5);
  assert.equal(evaluate('16 / 4 / 2'), 2);
  assert.equal(evaluate('10 - 2 + 3'), 11);
});

test('handles unary signs', () => {
  assert.equal(evaluate('-2 * 3'), -6);
  assert.equal(evaluate('2 * -3'), -6);
  assert.equal(evaluate('--3'), 3);
  assert.equal(evaluate('-(2 + 3)'), -5);
  assert.equal(evaluate('+4'), 4);
  assert.equal(evaluate('3 - -2'), 5);
});

test('remainder follows the left operand sign', () => {
  assert.equal(evaluate('7 % 3'), 1);
  assert.equal(evaluate('-7 % 3'), -1);
  assert.equal(evaluate('7 % -3'), 1);
});

test('decimals and plain JavaScript arithmetic', () => {
  assert.equal(evaluate('1 / 4'), 0.25);
  assert.equal(evaluate('0.1 + 0.2'), 0.1 + 0.2);
  assert.equal(evaluate('2.5 * 4'), 10);
});

test('ignores spaces and tabs', () => {
  assert.equal(evaluate('  1\t+\t2  '), 3);
  assert.equal(evaluate('1+2'), 3);
});

test('division and remainder by zero raise RangeError', () => {
  assert.throws(() => evaluate('1 / 0'), RangeError);
  assert.throws(() => evaluate('1 % 0'), RangeError);
  assert.throws(() => evaluate('1 / (2 - 2)'), RangeError);
  assert.throws(() => evaluate('0 / 0'), RangeError);
});

test('rejects malformed input', () => {
  assert.throws(() => evaluate(''), SyntaxError);
  assert.throws(() => evaluate('   '), SyntaxError);
  assert.throws(() => evaluate('1 +'), SyntaxError);
  assert.throws(() => evaluate('* 2'), SyntaxError);
  assert.throws(() => evaluate('1 2'), SyntaxError);
  assert.throws(() => evaluate('(1 + 2'), SyntaxError);
  assert.throws(() => evaluate('1 + 2)'), SyntaxError);
  assert.throws(() => evaluate('()'), SyntaxError);
});

test('rejects numbers outside the grammar and stray characters', () => {
  assert.throws(() => evaluate('.5 + 1'), SyntaxError);
  assert.throws(() => evaluate('1. + 1'), SyntaxError);
  assert.throws(() => evaluate('1e3'), SyntaxError);
  assert.throws(() => evaluate('2 ^ 3'), SyntaxError);
  assert.throws(() => evaluate('2 ** 3'), SyntaxError);
  assert.throws(() => evaluate('a + 1'), SyntaxError);
  assert.throws(() => evaluate(7), TypeError);
});

test('handles a long expression', () => {
  const expr = Array.from({ length: 5001 }, () => '1').join('+');
  assert.equal(evaluate(expr), 5001);
  const mixed = `1${'+2*3-4'.repeat(1000)}`;
  assert.equal(evaluate(mixed), 1 + 1000 * (6 - 4));
});

test('handles deep nesting', () => {
  const depth = 500;
  assert.equal(evaluate(`${'('.repeat(depth)}3${')'.repeat(depth)}`), 3);
});
