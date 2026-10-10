import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evolveBlocker } from '../src/cli/evolve.js';

const base = { hasKey: false, dryRun: false, allowGraded: false };

test('evolve refuses replay: a proposal is a new harness with no recorded answers', () => {
  const why = evolveBlocker({ ...base, mode: 'replay' });
  assert.ok(why !== null);
  assert.match(why, /replay mode cannot score a proposed change/);
  assert.match(why, /--dry-run/);
});

test('evolve refuses live mode without an API key', () => {
  const why = evolveBlocker({ ...base, mode: 'live' });
  assert.ok(why !== null);
  assert.match(why, /ANTHROPIC_API_KEY/);
});

test('a dry run needs no key, in either mode', () => {
  assert.equal(evolveBlocker({ ...base, mode: 'replay', dryRun: true }), null);
  assert.equal(evolveBlocker({ ...base, mode: 'live', dryRun: true }), null);
});

test('live mode with a key may run', () => {
  assert.equal(evolveBlocker({ ...base, mode: 'live', hasKey: true }), null);
});

test('replay may run only when graded answers are explicitly allowed', () => {
  assert.equal(evolveBlocker({ ...base, mode: 'replay', allowGraded: true }), null);
});
