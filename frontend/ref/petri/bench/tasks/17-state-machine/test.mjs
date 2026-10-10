import test from 'node:test';
import assert from 'node:assert/strict';
import { createMachine } from './solution.mjs';

const config = () => ({
  initial: 'idle',
  states: {
    idle: {
      onEntry: 'enterIdle',
      onExit: 'exitIdle',
      on: { START: { target: 'running', action: 'begin' } },
    },
    running: {
      onEntry: 'enterRunning',
      onExit: 'exitRunning',
      on: {
        STOP: [
          { target: 'idle', guard: (e) => e.force === true, action: 'hardStop' },
          { target: 'running', action: 'ignore' },
        ],
        PING: { target: 'running' },
      },
    },
  },
});

test('starts in the initial state and logs its entry action', () => {
  const m = createMachine(config());
  assert.equal(m.state, 'idle');
  assert.deepEqual(m.log, ['enterIdle']);
});

test('a transition runs exit, action and entry in order', () => {
  const m = createMachine(config());
  assert.equal(m.send('START'), true);
  assert.equal(m.state, 'running');
  assert.deepEqual(m.log, ['enterIdle', 'exitIdle', 'begin', 'enterRunning']);
});

test('an object event works like a string event', () => {
  const m = createMachine(config());
  assert.equal(m.send({ type: 'START' }), true);
  assert.equal(m.state, 'running');
});

test('an unknown event changes nothing', () => {
  const m = createMachine(config());
  assert.equal(m.send('NOPE'), false);
  assert.equal(m.state, 'idle');
  assert.deepEqual(m.log, ['enterIdle']);
});

test('a failed guard falls through to the next transition', () => {
  const m = createMachine(config());
  m.send('START');
  assert.equal(m.send({ type: 'STOP' }), true);
  assert.equal(m.state, 'running');
  assert.deepEqual(m.log.slice(-3), ['exitRunning', 'ignore', 'enterRunning']);
});

test('a passing guard takes the first transition', () => {
  const m = createMachine(config());
  m.send('START');
  assert.equal(m.send({ type: 'STOP', force: true }), true);
  assert.equal(m.state, 'idle');
  assert.deepEqual(m.log.slice(-3), ['exitRunning', 'hardStop', 'enterIdle']);
});

test('a self transition still runs exit and entry', () => {
  const m = createMachine(config());
  m.send('START');
  const before = m.log.length;
  assert.equal(m.send('PING'), true);
  assert.equal(m.state, 'running');
  assert.deepEqual(m.log.slice(before), ['exitRunning', 'enterRunning']);
});

test('a state with no actions logs nothing', () => {
  const m = createMachine({
    initial: 'a',
    states: { a: { on: { GO: { target: 'b' } } }, b: {} },
  });
  assert.deepEqual(m.log, []);
  assert.equal(m.send('GO'), true);
  assert.deepEqual(m.log, []);
  assert.equal(m.state, 'b');
  assert.equal(m.send('GO'), false);
});

test('two machines from one config are independent', () => {
  const shared = config();
  const m1 = createMachine(shared);
  const m2 = createMachine(shared);
  m1.send('START');
  assert.equal(m2.state, 'idle');
  assert.deepEqual(m2.log, ['enterIdle']);
  assert.deepEqual(shared.states.idle.on.START, { target: 'running', action: 'begin' });
});

test('rejects a bad config when the machine is created', () => {
  assert.throws(() => createMachine(null), TypeError);
  assert.throws(() => createMachine({ initial: 'a', states: 'nope' }), TypeError);
  assert.throws(() => createMachine({ initial: 'zzz', states: { a: {} } }), ReferenceError);
  assert.throws(
    () => createMachine({ initial: 'a', states: { a: { on: { GO: { target: 'zzz' } } } } }),
    ReferenceError,
  );
  assert.throws(
    () => createMachine({
      initial: 'a',
      states: { a: { on: { GO: { target: 'a', guard: 'yes' } } } },
    }),
    TypeError,
  );
});

test('rejects a bad event', () => {
  const m = createMachine(config());
  assert.throws(() => m.send(7), TypeError);
  assert.throws(() => m.send(null), TypeError);
  assert.throws(() => m.send({ kind: 'START' }), TypeError);
});
