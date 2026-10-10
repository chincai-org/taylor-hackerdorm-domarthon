/**
 * The shipped fixture store. SPEC.md sections 4.3, 10.10 and 11.5.
 *
 * These checks keep design rule 6 honest: a fresh clone with no ANTHROPIC_API_KEY
 * and no Hedera account must be able to measure two harness versions, and the gap
 * between them must clear the acceptance margin of section 9.
 *
 * The checks are cheap on purpose. They read the store and the schemas. They never
 * spawn a sandbox, so `pnpm test` stays fast. The real measurement is proved by
 * running the benchmark, not by this file.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { DEFAULT_POLICY } from '../src/config.js';
import { sha256Hex } from '../src/core/canonical.js';
import { harnessId } from '../src/core/ids.js';
import { REPO_ROOT } from '../src/core/root.js';
import { scoreBp } from '../src/core/schema.js';
import {
  assertFixtureBench,
  FIXTURES_DIR,
  FixtureMissingError,
  loadFixture,
  loadFixtureHarnesses,
  loadFixtureIndex,
} from '../src/model/replay.js';
import { createModelClient, detectMode } from '../src/model/client.js';
import { readHarness } from '../src/cli/snapshot.js';
import { buildBench } from '../bench/src/benchSpec.js';
import { listTaskIds } from '../bench/src/taskLoader.js';

const index = loadFixtureIndex();
const sidecar = loadFixtureHarnesses();
const taskIds = listTaskIds();

test('the fixtures were recorded against the tasks on disk', () => {
  assert.doesNotThrow(() => assertFixtureBench(index, buildBench().id));
});

test('every recorded harness ships the files its id names', () => {
  assert.notEqual(sidecar, null);
  assert.ok(sidecar!.harnesses.length >= 2, 'two harness versions are needed for a delta');
  for (const version of sidecar!.harnesses) {
    assert.equal(harnessId(version.files), version.harness, `${version.label} does not hash to its id`);
  }
});

test('every harness covers all 20 tasks, and every fixture matches its hash', () => {
  for (const version of sidecar!.harnesses) {
    for (const taskId of taskIds) {
      const entry = index.entries.find((e) => e.harness === version.harness && e.taskId === taskId);
      assert.notEqual(entry, undefined, `${version.label} has no index entry for ${taskId}`);
      assert.equal(entry!.contentHashes.length, entry!.attempts);
      for (let attempt = 0; attempt < entry!.attempts; attempt += 1) {
        // loadFixture re-checks contentHash against source and throws on a mismatch.
        const fixture = loadFixture(FIXTURES_DIR, version.harness, taskId, attempt);
        assert.equal(fixture.contentHash, entry!.contentHashes[attempt]);
        assert.equal(sha256Hex(fixture.source), fixture.contentHash);
        assert.ok(fixture.source.trim().length > 0, `${taskId} attempt ${attempt} is empty`);
      }
    }
  }
});

test('a miss is a hard error that names the harnesses the store does hold', () => {
  let missing: FixtureMissingError | null = null;
  try {
    loadFixture(FIXTURES_DIR, 'a'.repeat(64), taskIds[0]!, 0);
  } catch (err) {
    assert.ok(err instanceof FixtureMissingError, 'a miss must not be a plain Error');
    missing = err;
  }
  assert.notEqual(missing, null, 'a miss must throw, never return junk');
  assert.equal(missing!.fatal, true, 'a miss must stop the command, not score the task 0');
  assert.match(missing!.message, /no fixture/);
  assert.match(missing!.message, /--allow-graded/);
  for (const version of sidecar!.harnesses) {
    assert.ok(missing!.message.includes(version.harness), 'the error must list the recorded harnesses');
  }
});

test('the harness on disk is still the baseline the fixtures were recorded for', () => {
  const onDisk = harnessId(readHarness(join(REPO_ROOT, 'harness')));
  const recorded = sidecar!.harnesses.map((v) => v.harness);
  assert.ok(
    recorded.includes(onDisk),
    'harness/ hashes to an id the fixture store does not hold. Editing harness/ makes '
    + 'the genesis node unmeasurable in replay mode. Either revert the edit, or record '
    + 'fixtures for the new harness and add it to bench/fixtures/harnesses.json.',
  );
});

test('no key means replay, and the caller is told which mode it got', () => {
  const env = { ...process.env };
  delete env['ANTHROPIC_API_KEY'];
  assert.equal(detectMode(env), 'replay');

  const selection = createModelClient({
    env,
    run: {
      harnessId: sidecar!.harnesses[0]!.harness,
      taskId: taskIds[0]!,
      attemptIndex: 0,
      seed: 'b'.repeat(64),
    },
  });
  assert.equal(selection.mode, 'replay');
  assert.equal(selection.model, 'none');
  assert.equal(selection.effectiveModel(), 'none', 'no fixture was missed, so nothing is graded');

  assert.equal(detectMode({ ...env, ANTHROPIC_API_KEY: 'sk-test' }), 'live');
});

test('the two versions are far enough apart to decide a node', () => {
  const scores = sidecar!.harnesses.map((v) => scoreBp(v.expectedPassed, taskIds.length));
  const gap = Math.max(...scores) - Math.min(...scores);
  assert.ok(
    gap >= DEFAULT_POLICY.minDeltaBp * 2,
    `the gap is ${gap}bp and the margin is ${DEFAULT_POLICY.minDeltaBp}bp. `
    + 'A demo inside the noise band decides nothing.',
  );
  assert.ok(
    Math.min(...scores) >= DEFAULT_POLICY.minDeltaBp,
    'the weaker version must still clear the margin over the empty harness, '
    + 'or the root node can never be accepted',
  );
});
