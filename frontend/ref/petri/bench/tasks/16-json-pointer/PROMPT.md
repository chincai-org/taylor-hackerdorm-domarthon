# Resolve an RFC 6901 JSON pointer

Write a file named `solution.mjs`. Export one named function, `resolvePointer`.

## Signature

```js
export function resolvePointer(doc, pointer) { /* ... */ }
```

## Behaviour

`resolvePointer` walks `doc` along `pointer` and returns the value it finds. It
returns the value itself, not a copy.

A pointer is either the empty string, or a run of tokens. Each token starts with
a `/`. The empty pointer `''` selects the whole document.

```js
const doc = { a: { b: [10, 20] }, '': 'empty key', 'm~n': 1, 'a/b': 2 };

resolvePointer(doc, '')          // the whole doc
resolvePointer(doc, '/a/b/1')    // 20
resolvePointer(doc, '/')         // 'empty key'   (the token is the empty key)
resolvePointer(doc, '/m~0n')     // 1
resolvePointer(doc, '/a~1b')     // 2
```

## Unescaping

Inside a token, `~1` means `/` and `~0` means `~`. Replace `~1` first, then
`~0`. The order matters: `~01` unescapes to `~1`, not to `~` followed by a
separator.

A `~` that is not followed by `0` or `1` is an error.

## Walking

- On a plain object, the token is a key. It must be an **own** key. An inherited
  key, such as `toString`, counts as missing.
- On an array, the token is an index. It must be `0`, or a digit run with no
  leading zero. `01`, `-`, `+1` and `length` are all errors.
- The token may be the empty string. That is a legal object key.

## Errors

1. If `pointer` is not a string, throw a `TypeError`.
2. If `pointer` is neither empty nor starting with `/`, throw a `SyntaxError`.
3. If a token holds a `~` that is not followed by `0` or `1`, throw a
   `SyntaxError`.
4. If a token is used as an array index and is not a well-formed index, throw a
   `SyntaxError`.
5. If a key is missing from an object, or an index is outside the array, throw a
   `ReferenceError`.
6. If a token has to be applied to something that is not a plain object and not
   an array, such as a number, a string or `null`, throw a `ReferenceError`.

## Rules

1. Do not change `doc`.
2. A resolved value of `null`, `0`, `''` or `false` is a normal result. Return
   it. Do not treat it as missing.
3. Use no imports. Use no I/O.

## Output format

Write only the file `solution.mjs`. Use ESM syntax. Export the symbol
`resolvePointer`.
