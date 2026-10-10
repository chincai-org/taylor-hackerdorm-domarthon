import test from 'node:test';
import assert from 'node:assert/strict';
import { encode, decode } from './solution.mjs';

test('encodes a repeated run', () => {
  assert.equal(encode('aaab'), '3xa1xb');
});

test('writes a count of one for single characters', () => {
  assert.equal(encode('abc'), '1xa1xb1xc');
});

test('encodes a run longer than nine', () => {
  assert.equal(encode('aaaaaaaaaaaa'), '12xa');
});

test('handles digits and the separator in the input', () => {
  assert.equal(encode('3'), '1x3');
  assert.equal(encode('xx'), '2xx');
  assert.equal(decode(encode('112233')), '112233');
  assert.equal(decode(encode('1x2x3')), '1x2x3');
  assert.equal(decode(encode('10x11')), '10x11');
});

test('empty strings round-trip', () => {
  assert.equal(encode(''), '');
  assert.equal(decode(''), '');
});

test('decodes back to the original', () => {
  assert.equal(decode('3xa1xb'), 'aaab');
  assert.equal(decode('12xa'), 'aaaaaaaaaaaa');
  assert.equal(decode('1xx'), 'x');
});

test('rejects malformed encodings', () => {
  assert.throws(() => decode('xa'), SyntaxError);
  assert.throws(() => decode('3a'), SyntaxError);
  assert.throws(() => decode('3x'), SyntaxError);
  assert.throws(() => decode('0xa'), SyntaxError);
  assert.throws(() => decode('01xa'), SyntaxError);
});

test('rejects non-string arguments', () => {
  assert.throws(() => encode(123), TypeError);
  assert.throws(() => decode(null), TypeError);
});
