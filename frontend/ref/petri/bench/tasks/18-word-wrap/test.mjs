import test from 'node:test';
import assert from 'node:assert/strict';
import { wrapText } from './solution.mjs';

test('wraps at a space', () => {
  assert.equal(wrapText('the quick brown fox', 10), 'the quick\nbrown fox');
});

test('a line that exactly fits is not broken', () => {
  assert.equal(wrapText('abc def', 7), 'abc def');
  assert.equal(wrapText('abc def', 6), 'abc\ndef');
});

test('hard-splits a word longer than the width', () => {
  assert.equal(wrapText('abcdefghij', 4), 'abcd\nefgh\nij');
  assert.equal(wrapText('abcdefgh', 4), 'abcd\nefgh');
});

test('finishes the current line before a hard split', () => {
  assert.equal(wrapText('ab cdefgh', 4), 'ab\ncdef\ngh');
});

test('the remainder of a split word accepts later words', () => {
  assert.equal(wrapText('abcdefgh x', 6), 'abcdef\ngh x');
});

test('collapses space runs and trims the ends', () => {
  assert.equal(wrapText('  a   b  ', 10), 'a b');
  assert.equal(wrapText('a  b', 3), 'a b');
});

test('keeps existing newlines and blank lines', () => {
  assert.equal(wrapText('a\n\nb', 5), 'a\n\nb');
  assert.equal(wrapText('one two\nthree', 4), 'one\ntwo\nthre\ne');
});

test('a line of only spaces becomes empty', () => {
  assert.equal(wrapText('a\n   \nb', 5), 'a\n\nb');
});

test('empty input gives an empty string', () => {
  assert.equal(wrapText('', 5), '');
  assert.equal(wrapText('\n', 5), '\n');
});

test('no output line is ever wider than the width', () => {
  const text = 'alpha bb ccccccccccccc dd eeee f gg hhhhhhh ii\njjjj kkkkkkkkkkkk l';
  for (const width of [1, 2, 3, 5, 8, 13]) {
    for (const line of wrapText(text, width).split('\n')) {
      assert.ok(line.length <= width, `width ${width} produced "${line}"`);
    }
  }
});

test('rejects bad arguments', () => {
  assert.throws(() => wrapText(5, 5), TypeError);
  assert.throws(() => wrapText(null, 5), TypeError);
  assert.throws(() => wrapText('a', 0), RangeError);
  assert.throws(() => wrapText('a', -1), RangeError);
  assert.throws(() => wrapText('a', 2.5), RangeError);
  assert.throws(() => wrapText('a', '5'), RangeError);
});
