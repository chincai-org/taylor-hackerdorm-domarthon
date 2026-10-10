# A debouncer driven by an injected clock

Write a file named `solution.mjs`. Export one named function, `createDebouncer`.

## Signature

```js
export function createDebouncer(fn, waitMs, options) { /* ... */ }
```

`createDebouncer` returns a new object with five methods:

```js
d.call(...args)  // ask for fn to run
d.tick(ms)       // move the clock forward by ms milliseconds
d.cancel()       // drop the waiting call
d.flush()        // run the waiting call now; returns true if it ran one
d.pending()      // true when a trailing call is waiting
```

`options` may hold two booleans, `leading` and `trailing`. `leading` defaults to
`false`. `trailing` defaults to `true`.

**Use no real clock.** The only time that passes is the time given to `tick`. Do not
use `Date`, `setTimeout` or any timer.

## Behaviour

The debouncer holds one timer. The timer is either running with some time left, or
stopped.

`call(...args)` does this, in this order:

1. If the timer is stopped and `leading` is `true`, run `fn` at once with `args`.
2. Otherwise, if `trailing` is `true`, store `args` as the waiting call. Any earlier
   stored args are thrown away.
3. Start the timer, or restart it, with `waitMs` milliseconds left.

`tick(ms)` takes `ms` off the time left. When the time left reaches `0` or less, the
timer stops. If a call is waiting, the debouncer clears it and runs `fn` with the
stored args. A `tick` while the timer is stopped does nothing.

```js
const seen = [];
const d = createDebouncer((x) => seen.push(x), 100);
d.call(1);
d.tick(60);
d.call(2);   // this restarts the timer
d.tick(60);  // 60 < 100, so nothing runs yet
d.tick(40);  // now it runs
// seen is [2]
```

## Rules

1. Only the args of the newest `call` are used by the trailing run. Earlier args are
   lost.
2. With `leading: true` and one single `call`, `fn` runs **once**, at that call.
   There is no second run when the timer ends, because step 1 ran the call and step 2
   stored nothing.
3. With `leading: true` and `trailing: true`, two calls inside one wait period give
   two runs: one at the first call, one when the timer ends.
4. With `leading: false` and `trailing: false`, `fn` never runs.
5. `cancel()` stops the timer and drops the waiting call. Nothing runs.
6. `flush()` runs the waiting call at once with its stored args, clears it, and stops
   the timer. It returns `true` when it ran a call, and `false` when there was none.
7. `pending()` returns `true` only while a trailing call is stored.
8. `fn` is called with no `this` binding that matters, and its return value is
   thrown away.
9. If `fn` is not a function, throw a `TypeError`. If `options` is given and is not
   an object, throw a `TypeError`.
10. If `waitMs` is not a number, throw a `TypeError`. If it is not an integer, or is
    less than `0`, throw a `RangeError`. Check both at the call to `createDebouncer`.
11. If the argument of `tick` is not a number, throw a `TypeError`. If it is not an
    integer, or is less than `0`, throw a `RangeError`.
12. Two debouncers made by two calls share no state.
13. Use no imports. Use no I/O.

## Output format

Write only the file `solution.mjs`. Use ESM syntax. Export `createDebouncer`.
