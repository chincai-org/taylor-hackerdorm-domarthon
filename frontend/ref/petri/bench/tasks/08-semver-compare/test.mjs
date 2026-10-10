import test from 'node:test';
import assert from 'node:assert/strict';
import { compare } from './solution.mjs';

test('compares the three numbers', () => {
  assert.equal(compare('1.2.3', '1.2.4'), -1);
  assert.equal(compare('2.0.0', '1.9.9'), 1);
  assert.equal(compare('1.10.0', '1.9.0'), 1);
  assert.equal(compare('1.0.0', '1.0.0'), 0);
});

test('compares numbers numerically, not as text', () => {
  assert.equal(compare('10.0.0', '9.0.0'), 1);
  assert.equal(compare('1.0.100', '1.0.99'), 1);
});

test('ignores build metadata', () => {
  assert.equal(compare('1.0.0+build.1', '1.0.0'), 0);
  assert.equal(compare('1.0.0+a', '1.0.0+b'), 0);
  assert.equal(compare('1.0.0-alpha+z', '1.0.0-alpha+a'), 0);
});

test('a prerelease is lower than the release', () => {
  assert.equal(compare('1.0.0-alpha', '1.0.0'), -1);
  assert.equal(compare('1.0.0', '1.0.0-alpha'), 1);
  assert.equal(compare('1.0.0-alpha', '0.9.9'), 1);
});

test('numeric prerelease identifiers compare as numbers', () => {
  assert.equal(compare('1.0.0-2', '1.0.0-10'), -1);
  assert.equal(compare('1.0.0-rc.2', '1.0.0-rc.10'), -1);
});

test('a numeric identifier is lower than a text identifier', () => {
  assert.equal(compare('1.0.0-1', '1.0.0-alpha'), -1);
  assert.equal(compare('1.0.0-alpha', '1.0.0-1'), 1);
});

test('more identifiers wins when the prefix matches', () => {
  assert.equal(compare('1.0.0-alpha', '1.0.0-alpha.1'), -1);
  assert.equal(compare('1.0.0-alpha.1', '1.0.0-alpha'), 1);
});

test('follows the full precedence chain', () => {
  const chain = [
    '1.0.0-alpha',
    '1.0.0-alpha.1',
    '1.0.0-alpha.beta',
    '1.0.0-beta',
    '1.0.0-beta.2',
    '1.0.0-beta.11',
    '1.0.0-rc.1',
    '1.0.0',
  ];
  for (let i = 0; i + 1 < chain.length; i += 1) {
    assert.equal(compare(chain[i], chain[i + 1]), -1);
    assert.equal(compare(chain[i + 1], chain[i]), 1);
  }
});

test('rejects invalid versions', () => {
  assert.throws(() => compare('1.0', '1.0.0'), SyntaxError);
  assert.throws(() => compare('01.0.0', '1.0.0'), SyntaxError);
  assert.throws(() => compare('v1.0.0', '1.0.0'), SyntaxError);
  assert.throws(() => compare('1.0.0-', '1.0.0'), SyntaxError);
  assert.throws(() => compare('1.0.0-a..b', '1.0.0'), SyntaxError);
  assert.throws(() => compare('1.0.0-01', '1.0.0'), SyntaxError);
  assert.throws(() => compare('1.0.0-a!b', '1.0.0'), SyntaxError);
  assert.equal(compare('1.0.0-0a', '1.0.0-0b'), -1);
});

test('rejects non-string arguments', () => {
  assert.throws(() => compare(1, '1.0.0'), TypeError);
  assert.throws(() => compare('1.0.0', null), TypeError);
});
