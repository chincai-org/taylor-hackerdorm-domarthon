# Chunk an array into fixed-size groups

Write a file named `solution.mjs`. Export one named function, `chunk`.

## Signature

```js
export function chunk(input, size) { /* ... */ }
```

## Behaviour

`chunk` splits `input` into consecutive groups of `size` elements.
It returns an array of arrays. The last group holds the remainder.
It may be shorter than `size`.

```js
chunk([1, 2, 3, 4], 2)     // [[1, 2], [3, 4]]
chunk([1, 2, 3, 4, 5], 2)  // [[1, 2], [3, 4], [5]]
chunk([1, 2], 5)           // [[1, 2]]
chunk([], 3)               // []
```

## Rules

1. Do not change `input`. The caller keeps using it.
2. Return new arrays. Do not return views into `input`.
3. If `input` is not an array, throw a `TypeError`.
4. If `size` is not an integer, or is less than 1, throw a `RangeError`.
5. Use no imports. Use no I/O.

## Output format

Write only the file `solution.mjs`. Use ESM syntax. Export the symbol `chunk`.
