import { test } from 'node:test';
import assert from 'node:assert/strict';

import { taskConcurrency } from '../bench/src/runner.js';

test('tasks run six at a time unless the environment says otherwise', () => {
  assert.equal(taskConcurrency({}), 6);
});

test('PETRI_TASK_CONCURRENCY=1 restores one task at a time', () => {
  assert.equal(taskConcurrency({ PETRI_TASK_CONCURRENCY: '1' }), 1);
});

test('a value that is not a whole number between 1 and 32 falls back to the default', () => {
  for (const bad of ['0', '-4', '33', 'many', '2.5', '']) {
    assert.equal(taskConcurrency({ PETRI_TASK_CONCURRENCY: bad }), 6, bad);
  }
});
