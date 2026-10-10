import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runWorldCheck, worldCheckLine } from '../src/trust/world.js';

const ids = { tree: 'petri-main', node: 'ab'.repeat(32), report: 'cd'.repeat(32), runner: 'ef'.repeat(32), now: () => 1 };
const WALLET = '0x1111111111111111111111111111111111111111';
const never = async (): Promise<string | null> => { throw new Error('the lookup must not run'); };

test('the check is off by default and never calls the lookup', async () => {
  const outcome = await runWorldCheck({ ...ids, env: {}, lookup: never });
  assert.equal(outcome.status, 'disabled');
  assert.match(worldCheckLine(outcome), /^off/);
});

test('turned on with no wallet, it records an error and does not look up', async () => {
  const outcome = await runWorldCheck({ ...ids, env: { PETRI_WORLD_ID: '1' }, lookup: never });
  assert.equal(outcome.status, 'done');
  if (outcome.status !== 'done') return;
  assert.equal(outcome.record.result, 'error');
  assert.match(outcome.record.reason, /PETRI_WORLD_ADDRESS/);
});

test('a registered wallet records the human id with the report it belongs to', async () => {
  const outcome = await runWorldCheck({
    ...ids, env: { PETRI_WORLD_ID: '1', PETRI_WORLD_ADDRESS: WALLET }, lookup: async () => '0xhuman',
  });
  assert.equal(outcome.status, 'done');
  if (outcome.status !== 'done') return;
  assert.deepEqual(
    { result: outcome.record.result, humanId: outcome.record.humanId, report: outcome.record.report },
    { result: 'human', humanId: '0xhuman', report: ids.report },
  );
});

test('an unregistered wallet and a failed lookup are both recorded, never thrown', async () => {
  const env = { PETRI_WORLD_ID: '1', PETRI_WORLD_ADDRESS: WALLET };
  const missing = await runWorldCheck({ ...ids, env, lookup: async () => null });
  const broken = await runWorldCheck({ ...ids, env, lookup: async () => { throw new Error('rpc down'); } });
  assert.equal(missing.status === 'done' && missing.record.result, 'not-registered');
  assert.equal(broken.status === 'done' && broken.record.result, 'error');
  assert.match(broken.status === 'done' ? broken.record.reason : '', /rpc down/);
});
