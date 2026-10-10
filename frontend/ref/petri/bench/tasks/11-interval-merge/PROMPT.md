# Merge overlapping closed intervals

Write a file named `solution.mjs`. Export one named function, `mergeIntervals`.

## Signature

```js
export function mergeIntervals(intervals) { /* ... */ }
```

## Behaviour

`intervals` is an array of pairs. Each pair is an array of exactly two numbers,
`[start, end]`. Each pair is a **closed** interval. It contains both end points.

`mergeIntervals` returns a new array of pairs. It collapses every group of
intervals that overlap or touch into one interval. The result is sorted by
`start`, ascending.

Two intervals touch when the end of one equals the start of the other. Touching
intervals merge. `[1, 2]` and `[2, 3]` become `[1, 3]`.

The input is not sorted. Sort it yourself.

```js
mergeIntervals([[1, 3], [2, 6], [8, 10]])   // [[1, 6], [8, 10]]
mergeIntervals([[1, 2], [2, 3]])            // [[1, 3]]
mergeIntervals([[5, 6], [1, 2]])            // [[1, 2], [5, 6]]
mergeIntervals([[1, 10], [2, 3]])           // [[1, 10]]
mergeIntervals([[4, 4]])                    // [[4, 4]]
mergeIntervals([])                          // []
```

A zero-width interval such as `[4, 4]` is valid. It merges with any interval that
contains the point 4.

## Rules

1. Do not change `intervals`. Do not change any pair inside it. The caller keeps
   using them.
2. Return new arrays at both levels. No pair in the result may be a pair from the
   input.
3. If `intervals` is not an array, throw a `TypeError`.
4. If any element is not an array of exactly two values, throw a `TypeError`.
5. If either value of a pair is not a finite number, throw a `TypeError`.
   `NaN` and `Infinity` are not finite numbers.
6. If `start` is greater than `end` in any pair, throw a `RangeError`.
7. Validate every pair before you merge anything. A bad pair at the end of the
   input must still throw.
8. Use no imports. Use no I/O.

## Output format

Write only the file `solution.mjs`. Use ESM syntax. Export the symbol
`mergeIntervals`.
