# Check that brackets nest correctly outside strings

Write a file named `solution.mjs`. Export one named function, `isBalanced`.

## Signature

```js
export function isBalanced(source) { /* ... */ }
```

## Behaviour

`isBalanced` returns `true` when every `(`, `[` and `{` in `source` has a matching
`)`, `]` or `}` after it, and the pairs nest correctly. It returns `false` otherwise.

```js
isBalanced('a(b)[c]{d}')  // true
isBalanced('({[]})')      // true
isBalanced('([)]')        // false
isBalanced('(')           // false
isBalanced(')(')          // false
isBalanced('')            // true
```

Ignore every character inside a quoted string. A string starts at a `'` or a `"`
character and ends at the next **unescaped** copy of that same quote character. The
other quote character has no meaning inside a string.

```js
isBalanced('a = "]"')          // true, the bracket is inside a string
isBalanced("x = ('[') + '('")  // true
isBalanced('f("\\"(")')        // true, the escaped quote does not end the string
```

## Rules

1. A backslash inside a string escapes the next character. That next character never
   ends the string, whatever it is.
2. A backslash outside a string has no special meaning.
3. If a string never ends, return `false`.
4. Every character that is not a bracket and not part of a string is ignored.
5. If `source` is not a string, throw a `TypeError`.
6. Use no imports. Use no I/O.

## Output format

Write only the file `solution.mjs`. Use ESM syntax. Export the symbol `isBalanced`.
