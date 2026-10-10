import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv } from './solution.mjs';

test('parses plain rows', () => {
  assert.deepEqual(parseCsv('a,b\nc,d'), [['a', 'b'], ['c', 'd']]);
});

test('empty text gives no records', () => {
  assert.deepEqual(parseCsv(''), []);
});

test('one final terminator is ignored', () => {
  assert.deepEqual(parseCsv('a,b\n'), [['a', 'b']]);
  assert.deepEqual(parseCsv('a\n\n'), [['a'], ['']]);
  assert.deepEqual(parseCsv('\n'), [['']]);
});

test('accepts CRLF terminators', () => {
  assert.deepEqual(parseCsv('a,b\r\nc,d\r\n'), [['a', 'b'], ['c', 'd']]);
});

test('quotes protect commas and newlines', () => {
  assert.deepEqual(parseCsv('"a,b",c'), [['a,b', 'c']]);
  assert.deepEqual(parseCsv('"line1\nline2"'), [['line1\nline2']]);
  assert.deepEqual(parseCsv('"x\r\ny",z'), [['x\r\ny', 'z']]);
});

test('two quotes mean one literal quote', () => {
  assert.deepEqual(parseCsv('"say ""hi""",b'), [['say "hi"', 'b']]);
  assert.deepEqual(parseCsv('""'), [['']]);
  assert.deepEqual(parseCsv('""""'), [['"']]);
});

test('keeps empty fields and spaces', () => {
  assert.deepEqual(parseCsv('a,,b'), [['a', '', 'b']]);
  assert.deepEqual(parseCsv(','), [['', '']]);
  assert.deepEqual(parseCsv(' a , b '), [[' a ', ' b ']]);
});

test('a quote inside an unquoted field is literal', () => {
  assert.deepEqual(parseCsv('a"b,c'), [['a"b', 'c']]);
  assert.deepEqual(parseCsv('a\rb'), [['a\rb']]);
});

test('rejects an unterminated quoted field', () => {
  assert.throws(() => parseCsv('"abc'), SyntaxError);
  assert.throws(() => parseCsv('a,"b'), SyntaxError);
});

test('rejects text after a closing quote and a non-string argument', () => {
  assert.throws(() => parseCsv('"a"b'), SyntaxError);
  assert.throws(() => parseCsv(42), TypeError);
});
