import test from 'node:test';
import assert from 'node:assert/strict';
import { matchGlob } from './solution.mjs';

test('a star stops at a separator', () => {
  assert.equal(matchGlob('*.js', 'app.js'), true);
  assert.equal(matchGlob('*.js', 'src/app.js'), false);
  assert.equal(matchGlob('src/*.js', 'src/app.js'), true);
});

test('a double star crosses separators', () => {
  assert.equal(matchGlob('**/*.js', 'src/a/app.js'), true);
  assert.equal(matchGlob('a/**', 'a/b/c'), true);
  assert.equal(matchGlob('a/*', 'a/b/c'), false);
  assert.equal(matchGlob('**', 'a/b/c'), true);
});

test('a double star matches zero characters but not a missing separator', () => {
  assert.equal(matchGlob('a/**', 'a/'), true);
  assert.equal(matchGlob('**/x', 'a/x'), true);
  assert.equal(matchGlob('**/x', 'x'), false);
});

test('a run of stars behaves as a double star', () => {
  assert.equal(matchGlob('a/***/b', 'a/x/y/b'), true);
});

test('a question mark takes one character but never a separator', () => {
  assert.equal(matchGlob('a?c', 'abc'), true);
  assert.equal(matchGlob('a?c', 'a/c'), false);
  assert.equal(matchGlob('a?c', 'ac'), false);
  assert.equal(matchGlob('a?c', 'abbc'), false);
});

test('character classes and ranges', () => {
  assert.equal(matchGlob('[a-c]at', 'bat'), true);
  assert.equal(matchGlob('[a-c]at', 'dat'), false);
  assert.equal(matchGlob('[abc]at', 'cat'), true);
  assert.equal(matchGlob('[a-c]at', 'at'), false);
});

test('a negated class excludes its members and the separator', () => {
  assert.equal(matchGlob('[!a-c]at', 'dat'), true);
  assert.equal(matchGlob('[!a-c]at', 'bat'), false);
  assert.equal(matchGlob('[!a]x', '/x'), false);
});

test('a bracket or a dash can be a literal member', () => {
  assert.equal(matchGlob('[]a]x', ']x'), true);
  assert.equal(matchGlob('[]a]x', 'ax'), true);
  assert.equal(matchGlob('[-a]x', '-x'), true);
  assert.equal(matchGlob('[a-]x', '-x'), true);
});

test('a backslash escapes the next character', () => {
  assert.equal(matchGlob('\\*x', '*x'), true);
  assert.equal(matchGlob('\\*x', 'ax'), false);
  assert.equal(matchGlob('\\[a]x', '[a]x'), true);
  assert.equal(matchGlob('a\\\\b', 'a\\b'), true);
});

test('empty pattern and empty path', () => {
  assert.equal(matchGlob('', ''), true);
  assert.equal(matchGlob('', 'a'), false);
  assert.equal(matchGlob('*', ''), true);
  assert.equal(matchGlob('?', ''), false);
});

test('rejects bad types and bad patterns', () => {
  assert.throws(() => matchGlob(1, 'a'), TypeError);
  assert.throws(() => matchGlob('a', 1), TypeError);
  assert.throws(() => matchGlob('[abc', 'a'), SyntaxError);
  assert.throws(() => matchGlob('[!abc', 'a'), SyntaxError);
  assert.throws(() => matchGlob('a\\', 'a'), SyntaxError);
});

test('answers a wildcard-heavy mismatch without blowing up', () => {
  const pattern = `${'*a'.repeat(12)}b`;
  const path = 'a'.repeat(60);
  const started = Date.now();
  assert.equal(matchGlob(pattern, path), false);
  assert.equal(matchGlob(`${'**a'.repeat(12)}b`, `${'a/'.repeat(40)}a`), false);
  assert.ok(Date.now() - started < 2000);
});
