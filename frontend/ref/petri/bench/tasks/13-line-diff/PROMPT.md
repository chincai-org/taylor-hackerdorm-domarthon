# Build a minimal line edit script

Write a file named `solution.mjs`. Export one named function, `diffLines`.

## Signature

```js
export function diffLines(a, b) { /* ... */ }
```

## Behaviour

`a` and `b` are arrays of strings. `diffLines` returns an edit script that turns
`a` into `b`. The script is an array of plain objects. Each object holds exactly
two own properties, in this key order:

```js
{ op: 'keep',   line: '...' }   // the line is in both a and b
{ op: 'remove', line: '...' }   // the line is in a only
{ op: 'add',    line: '...' }   // the line is in b only
```

Read the script from start to end. The `keep` and `remove` lines, in order, must
rebuild `a` exactly. The `keep` and `add` lines, in order, must rebuild `b`
exactly.

```js
diffLines(['a', 'b', 'c'], ['a', 'c'])
// [{ op: 'keep', line: 'a' }, { op: 'remove', line: 'b' }, { op: 'keep', line: 'c' }]

diffLines([], ['x'])          // [{ op: 'add', line: 'x' }]
diffLines(['x'], [])          // [{ op: 'remove', line: 'x' }]
diffLines([], [])             // []
```

## Minimal, and always the same script

The script must be **minimal**: no other correct script has fewer `add` plus
`remove` entries. Equal lines are compared with `===`.

Many minimal scripts often exist. Exactly one of them is the answer. Produce it
with this rule. Let `L(i, j)` be the length of the longest common subsequence of
`a.slice(i)` and `b.slice(j)`. Start at `i = 0`, `j = 0`, and repeat:

1. If `i` and `j` are both at the end, stop.
2. If `i` is at the end, emit `add` for `b[j]` and advance `j`.
3. If `j` is at the end, emit `remove` for `a[i]` and advance `i`.
4. If `a[i] === b[j]`, emit `keep` for `a[i]` and advance both.
5. If `L(i + 1, j) >= L(i, j + 1)`, emit `remove` for `a[i]` and advance `i`.
6. Otherwise emit `add` for `b[j]` and advance `j`.

Step 5 carries the tie-break: when a removal and an addition both lead to a
minimal script, the removal comes first.

```js
diffLines(['a'], ['b'])
// [{ op: 'remove', line: 'a' }, { op: 'add', line: 'b' }]
```

## Rules

1. Do not change `a` or `b`.
2. If `a` or `b` is not an array, throw a `TypeError`.
3. If any element of either array is not a string, throw a `TypeError`.
4. The function must handle 500 lines on each side inside a few seconds. A plan
   that tries every subsequence is far too slow.
5. Use no imports. Use no I/O.

## Output format

Write only the file `solution.mjs`. Use ESM syntax. Export the symbol
`diffLines`.
