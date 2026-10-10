import test from 'node:test';
import assert from 'node:assert/strict';
import { addDecimal } from './solution.mjs';

test('adds two fractions without float error', () => {
  assert.equal(addDecimal('0.1', '0.2'), '0.3');
  assert.equal(addDecimal('1.005', '2.995'), '4');
});

test('adds different scales', () => {
  assert.equal(addDecimal('1.5', '2.25'), '3.75');
  assert.equal(addDecimal('2.25', '1.5'), '3.75');
});

test('carries across the decimal point', () => {
  assert.equal(addDecimal('99.99', '0.01'), '100');
  assert.equal(addDecimal('9.9', '0.1'), '10');
});

test('stays exact far beyond 53 bits', () => {
  assert.equal(addDecimal('12345678901234567890', '1'), '12345678901234567891');
  assert.equal(addDecimal('9007199254740993', '2'), '9007199254740995');
  assert.equal(
    addDecimal('0.00000000000000000001', '0.00000000000000000002'),
    '0.00000000000000000003',
  );
});

test('handles both signs', () => {
  assert.equal(addDecimal('-5', '3'), '-2');
  assert.equal(addDecimal('3', '-5'), '-2');
  assert.equal(addDecimal('-5', '-3'), '-8');
  assert.equal(addDecimal('-1.25', '0.25'), '-1');
});

test('a zero sum is never negative zero', () => {
  assert.equal(addDecimal('-1.5', '1.5'), '0');
  assert.equal(addDecimal('-0.0', '0.0'), '0');
  assert.equal(addDecimal('0', '0'), '0');
});

test('drops trailing fraction zeros', () => {
  assert.equal(addDecimal('0.10', '0.20'), '0.3');
  assert.equal(addDecimal('1.50', '0.50'), '2');
});

test('drops leading integer zeros', () => {
  assert.equal(addDecimal('007.10', '0.90'), '8');
  assert.equal(addDecimal('000', '000'), '0');
});

test('accepts a leading plus and never writes one', () => {
  assert.equal(addDecimal('+1.20', '0.80'), '2');
  assert.equal(addDecimal('+3', '+4'), '7');
});

test('borrows correctly when the signs differ', () => {
  assert.equal(addDecimal('1', '-0.000001'), '0.999999');
  assert.equal(addDecimal('-1000', '0.5'), '-999.5');
});

test('rejects bad types and bad syntax', () => {
  assert.throws(() => addDecimal(1, '2'), TypeError);
  assert.throws(() => addDecimal('1', 2), TypeError);
  assert.throws(() => addDecimal('.5', '1'), SyntaxError);
  assert.throws(() => addDecimal('1.', '1'), SyntaxError);
  assert.throws(() => addDecimal('', '1'), SyntaxError);
  assert.throws(() => addDecimal('1e3', '1'), SyntaxError);
  assert.throws(() => addDecimal('1.2.3', '1'), SyntaxError);
  assert.throws(() => addDecimal('-', '1'), SyntaxError);
  assert.throws(() => addDecimal('1 ', '1'), SyntaxError);
});
