# Set a deep value without mutating anything

Write a file named `solution.mjs`. Export one named function, `setIn`.

## Signature

```js
export function setIn(obj, path, value) { /* ... */ }
```

## Behaviour

`setIn` returns a copy of `obj` in which the position named by `path` holds
`value`. It never changes `obj` or anything inside it.

`path` is an array of keys. A string key addresses a plain object. A number key
addresses an array.

```js
const state = { user: { name: 'Ada', tags: ['x', 'y'] }, other: { deep: 1 } };

const next = setIn(state, ['user', 'name'], 'Bea');
next.user.name          // 'Bea'
state.user.name         // 'Ada'
next.other === state.other   // true
```

## Structural sharing

Copy only the containers on the path. Every branch that the path does not enter
must come through **reference identical**. This is the property the function
exists for, so it is checked closely.

An empty `path` returns `value` itself.

## The no-change short cut

If the position already holds a value that is `Object.is` equal to `value`,
return `obj` itself. Copy nothing. This makes `setIn(state, p, x) === state` true
whenever the write changes nothing.

`Object.is` is the test, not `===`. So writing `NaN` over `NaN` changes nothing,
and writing `-0` over `0` is a real change.

## Missing containers

A key in the middle of the path may address something that is missing, or
something that is not a container. Create a container in its place. The **next**
key decides the kind: a number key needs an array, a string key needs a plain
object.

```js
setIn({}, ['a', 'b'], 1)     // { a: { b: 1 } }
setIn({}, ['a', 0], 1)       // { a: [1] }
setIn({ a: 5 }, ['a', 'b'], 1)   // { a: { b: 1 } }
```

## Arrays

A number key must be an integer of at least 0. Copies of arrays stay arrays. An
index equal to the current length appends. An index above the length is an error,
so the result never holds a hole.

## Errors

1. If `path` is not an array, throw a `TypeError`.
2. If a key is neither a string nor an integer number of at least 0, throw a
   `TypeError`.
3. If `obj` is not a plain object and not an array, and `path` is not empty,
   throw a `TypeError`.
4. If a string key lands on an array, or a number key lands on a plain object,
   throw a `TypeError`.
5. If a number key is greater than the length of the array it lands on, throw a
   `RangeError`.

## Rules

1. Copy an object with its own enumerable keys, in their existing order, and add
   a new key at the end.
2. Use no imports. Use no I/O.

## Output format

Write only the file `solution.mjs`. Use ESM syntax. Export the symbol `setIn`.
