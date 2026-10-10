# Order nodes so every edge points forward

Write a file named `solution.mjs`. Export one named function, `toposort`.

## Signature

```js
export function toposort(nodes, edges) { /* ... */ }
```

## Behaviour

`nodes` is an array of unique node names. `edges` is an array of pairs. The pair
`[from, to]` means `from` must come before `to`.

`toposort` returns a new array that holds every node exactly once, in an order that
respects every edge.

```js
toposort(['a', 'b', 'c'], [['a', 'b'], ['b', 'c']])  // ['a', 'b', 'c']
toposort(['c', 'a', 'b'], [])                        // ['c', 'a', 'b']
toposort([], [])                                     // []
```

## Rules

1. The result must be the same on every run. When more than one node is ready to be
   placed next, place the one that comes **earliest in `nodes`**. Repeat this choice
   after each placement, so a node that has just become ready can still win.

   ```js
   toposort(['a', 'b', 'c', 'd'], [['b', 'a']])  // ['b', 'a', 'c', 'd']
   ```

2. A duplicate edge is allowed. It changes nothing.
3. If the edges make a cycle, throw an `Error` whose message contains the word
   `cycle`. An edge from a node to itself is a cycle.
4. If `nodes` or `edges` is not an array, throw a `TypeError`. If a node name is not
   a string, or a name appears twice in `nodes`, throw a `TypeError`. If an edge is
   not an array of exactly two strings, throw a `TypeError`.
5. If an edge names a node that is not in `nodes`, throw a `RangeError`.
6. Do not change `nodes` or `edges`. Use no imports. Use no I/O.

## Output format

Write only the file `solution.mjs`. Use ESM syntax. Export the symbol `toposort`.
