import test from 'node:test';
import assert from 'node:assert/strict';
import { createDebouncer } from './solution.mjs';

const spy = () => {
  const seen = [];
  const fn = (...args) => {
    seen.push(args);
    return 'ignored';
  };
  return { seen, fn };
};

test('runs once at the end of the wait, with the newest args', () => {
  const { seen, fn } = spy();
  const d = createDebouncer(fn, 100);
  d.call(1);
  d.call(2);
  assert.deepEqual(seen, []);
  d.tick(100);
  assert.deepEqual(seen, [[2]]);
});

test('each call restarts the timer', () => {
  const { seen, fn } = spy();
  const d = createDebouncer(fn, 100);
  d.call(1);
  d.tick(60);
  d.call(2);
  d.tick(60);
  assert.deepEqual(seen, []);
  d.tick(40);
  assert.deepEqual(seen, [[2]]);
});

test('a single leading call runs once only', () => {
  const { seen, fn } = spy();
  const d = createDebouncer(fn, 100, { leading: true });
  d.call('a');
  assert.deepEqual(seen, [['a']]);
  d.tick(500);
  assert.deepEqual(seen, [['a']]);
});

test('leading and trailing give two runs for two calls', () => {
  const { seen, fn } = spy();
  const d = createDebouncer(fn, 100, { leading: true, trailing: true });
  d.call('a');
  d.call('b');
  d.call('c');
  assert.deepEqual(seen, [['a']]);
  d.tick(100);
  assert.deepEqual(seen, [['a'], ['c']]);
});

test('trailing false means no run at the end', () => {
  const { seen, fn } = spy();
  const d = createDebouncer(fn, 100, { leading: true, trailing: false });
  d.call('a');
  d.call('b');
  d.tick(500);
  assert.deepEqual(seen, [['a']]);

  const quiet = spy();
  const q = createDebouncer(quiet.fn, 10, { leading: false, trailing: false });
  q.call(1);
  q.tick(100);
  assert.deepEqual(quiet.seen, []);
});

test('cancel drops the waiting call', () => {
  const { seen, fn } = spy();
  const d = createDebouncer(fn, 100);
  d.call(1);
  d.cancel();
  d.tick(500);
  assert.deepEqual(seen, []);
  assert.equal(d.pending(), false);
});

test('flush runs the waiting call at once', () => {
  const { seen, fn } = spy();
  const d = createDebouncer(fn, 100);
  d.call(7);
  assert.equal(d.flush(), true);
  assert.deepEqual(seen, [[7]]);
  assert.equal(d.flush(), false);
  d.tick(500);
  assert.deepEqual(seen, [[7]]);
});

test('a stopped timer never runs again', () => {
  const { seen, fn } = spy();
  const d = createDebouncer(fn, 100);
  d.call(1);
  d.tick(250);
  d.tick(250);
  d.tick(0);
  assert.deepEqual(seen, [[1]]);
});

test('pending reports the waiting trailing call', () => {
  const { seen, fn } = spy();
  const d = createDebouncer(fn, 100);
  assert.equal(d.pending(), false);
  d.call(1);
  assert.equal(d.pending(), true);
  d.tick(100);
  assert.equal(d.pending(), false);
  assert.deepEqual(seen, [[1]]);

  const lead = spy();
  const l = createDebouncer(lead.fn, 100, { leading: true });
  l.call(1);
  assert.equal(l.pending(), false);
});

test('checks its arguments and keeps debouncers separate', () => {
  const { fn } = spy();
  assert.throws(() => createDebouncer(null, 10), TypeError);
  assert.throws(() => createDebouncer(fn, '10'), TypeError);
  assert.throws(() => createDebouncer(fn, 1.5), RangeError);
  assert.throws(() => createDebouncer(fn, -1), RangeError);
  assert.throws(() => createDebouncer(fn, 10, 'no'), TypeError);
  const d = createDebouncer(fn, 10);
  assert.throws(() => d.tick('5'), TypeError);
  assert.throws(() => d.tick(-5), RangeError);

  const a = spy();
  const b = spy();
  const da = createDebouncer(a.fn, 10);
  const db = createDebouncer(b.fn, 10);
  da.call(1);
  db.tick(100);
  assert.deepEqual(a.seen, []);
  assert.equal(da.pending(), true);
});
