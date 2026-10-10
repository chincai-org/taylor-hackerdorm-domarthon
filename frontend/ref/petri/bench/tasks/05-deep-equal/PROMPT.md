# Compare two values deeply without hanging on cycles

Write a file named `solution.mjs`. Export one named function, `deepEqual`.

## Signature

```js
export function deepEqual(a, b) { /* ... */ }
```

## Behaviour

`deepEqual` returns `true` when `a` and `b` hold the same data, and `false`
otherwise. It never throws and it always ends.

```js
deepEqual({ x: [1, { y: 2 }] }, { x: [1, { y: 2 }] })  // true
deepEqual([1, 2], [1, 2, 3])                            // false
```

## Rules

1. Compare two values that are not objects with `Object.is`. So `NaN` equals `NaN`,
   and `+0` does **not** equal `-0`. Values of different types are never equal, so
   `1` does not equal `'1'`.
2. `null` equals only `null`. `null` does not equal `{}`.
3. Two arrays are equal when they have the same `length` and every element at the
   same index is equal. An array never equals a non-array.
4. Two `Date` objects are equal when `getTime()` gives the same value, compared with
   `Object.is`. A `Date` never equals a value that is not a `Date`.
5. Two other objects are equal when they have the same set of own enumerable string
   keys, and the value at every key is equal. Key order does not matter.
6. A key that is present with the value `undefined` is **not** the same as a missing
   key. `deepEqual({ a: undefined }, {})` is `false`.
7. Ignore symbol keys and keys that are not enumerable.
8. The input may contain cycles. `deepEqual` must return an answer, not loop for
   ever and not overflow the stack. While a pair of objects is being compared,
   treat meeting that same pair again as equal.
9. The same object on both sides is equal to itself.
10. Do not change `a` or `b`. Use no imports. Use no I/O.

## Output format

Write only the file `solution.mjs`. Use ESM syntax. Export the symbol `deepEqual`.
