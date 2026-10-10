import test from 'node:test';
import assert from 'node:assert/strict';
import { toRoman, fromRoman } from './solution.mjs';

test('encodes small values', () => {
  assert.equal(toRoman(1), 'I');
  assert.equal(toRoman(4), 'IV');
  assert.equal(toRoman(9), 'IX');
  assert.equal(toRoman(14), 'XIV');
});

test('encodes large values', () => {
  assert.equal(toRoman(1990), 'MCMXC');
  assert.equal(toRoman(2024), 'MMXXIV');
  assert.equal(toRoman(3999), 'MMMCMXCIX');
});

test('rejects values outside the range', () => {
  assert.throws(() => toRoman(0), RangeError);
  assert.throws(() => toRoman(4000), RangeError);
  assert.throws(() => toRoman(-1), RangeError);
});

test('rejects bad value types', () => {
  assert.throws(() => toRoman(1.5), RangeError);
  assert.throws(() => toRoman('12'), TypeError);
});

test('decodes standard numerals', () => {
  assert.equal(fromRoman('XIV'), 14);
  assert.equal(fromRoman('MCMXC'), 1990);
  assert.equal(fromRoman('MMMCMXCIX'), 3999);
});

test('round-trips every value from 1 to 3999', () => {
  for (let n = 1; n <= 3999; n += 1) {
    assert.equal(fromRoman(toRoman(n)), n);
  }
});

test('rejects a letter repeated four times', () => {
  assert.throws(() => fromRoman('IIII'), SyntaxError);
  assert.throws(() => fromRoman('VIIII'), SyntaxError);
  assert.throws(() => fromRoman('XXXX'), SyntaxError);
});

test('rejects subtractive pairs that are not standard', () => {
  assert.throws(() => fromRoman('IC'), SyntaxError);
  assert.throws(() => fromRoman('IL'), SyntaxError);
  assert.throws(() => fromRoman('VX'), SyntaxError);
  assert.throws(() => fromRoman('VV'), SyntaxError);
});

test('rejects empty, lower case and unknown letters', () => {
  assert.throws(() => fromRoman(''), SyntaxError);
  assert.throws(() => fromRoman('xiv'), SyntaxError);
  assert.throws(() => fromRoman('ABC'), SyntaxError);
  assert.throws(() => fromRoman(' XIV'), SyntaxError);
});

test('rejects a non-string numeral', () => {
  assert.throws(() => fromRoman(14), TypeError);
});
