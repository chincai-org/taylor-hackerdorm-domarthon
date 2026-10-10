import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyBlocker } from '../src/cli/verify.js';

type Arg = Parameters<typeof verifyBlocker>[0];
const nodeWith = (cls: string): Arg =>
  ({ id: 'ab'.repeat(32), detail: { mechanical: { cls, command: '', exitCode: 0, evidence: '' } } }) as unknown as Arg;

test('a measured node may be verified', () => {
  assert.equal(verifyBlocker(nodeWith('ok')), null);
});

test('a node stopped by the typecheck is refused, with its class', () => {
  const why = verifyBlocker(nodeWith('typecheck-failed'));
  assert.ok(why !== null);
  assert.match(why, /stopped before scoring \(typecheck-failed\)/);
  assert.match(why, /nothing was measured/i);
});

test('a node stopped by a guard is refused', () => {
  assert.match(verifyBlocker(nodeWith('sandbox-violation')) ?? '', /sandbox-violation/);
});

test('a node that passed every check but could not be scored is refused too', () => {
  assert.match(verifyBlocker(nodeWith('not-scored')) ?? '', /not-scored/);
});
