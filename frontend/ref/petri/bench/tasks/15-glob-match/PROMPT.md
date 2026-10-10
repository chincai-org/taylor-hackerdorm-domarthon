# Match a path against a glob pattern

Write a file named `solution.mjs`. Export one named function, `matchGlob`.

## Signature

```js
export function matchGlob(pattern, path) { /* ... */ }
```

## Behaviour

`matchGlob` returns `true` when `pattern` matches the whole of `path`, and
`false` otherwise. A partial match is not a match.

The path separator is `/`. Every other character is an ordinary character.

## Pattern syntax

| Token | Matches |
|---|---|
| `?` | Exactly one character, but never `/`. |
| `*` | Zero or more characters, but never `/`. |
| `**` | Zero or more characters, including `/`. |
| `[...]` | Exactly one character from the set, but never `/`. |
| `\x` | The literal character `x`, whatever `x` is. |
| anything else | Itself. |

A run of two or more `*` characters behaves as one `**`.

Inside `[...]`:

- `a-z` is an inclusive range of character codes.
- A `!` directly after the `[` negates the whole set.
- A `]` directly after the `[`, or directly after the `!`, is a literal `]`.
- Any other character is itself. A `-` first or last in the set is a literal `-`.
- A negated set still never matches `/`.

```js
matchGlob('*.js', 'app.js')          // true
matchGlob('*.js', 'src/app.js')      // false
matchGlob('**/*.js', 'src/a/app.js') // true
matchGlob('a/**', 'a/b/c')           // true
matchGlob('a/*', 'a/b/c')            // false
matchGlob('a?c', 'abc')              // true
matchGlob('a?c', 'a/c')              // false
matchGlob('[a-c]at', 'bat')          // true
matchGlob('[!a-c]at', 'dat')         // true
matchGlob('\\*x', '*x')              // true
matchGlob('\\*x', 'ax')              // false
matchGlob('', '')                    // true
```

`**` is a plain wildcard. It is not segment aware. So `**/x` needs a real `/` in
the path: it matches `a/x`, and it does not match `x`.

## Errors

1. If `pattern` or `path` is not a string, throw a `TypeError`.
2. If a `[` is never closed, throw a `SyntaxError`.
3. If the pattern ends with a single `\`, throw a `SyntaxError`.

## Rules

1. The function must answer in well under a second for every pattern, including
   a pattern with many wildcards over a long path that does not match. A plain
   backtracking search takes exponential time on such input and will time out.
2. Use no imports. Use no I/O. Do not build a `RegExp`.

## Output format

Write only the file `solution.mjs`. Use ESM syntax. Export the symbol
`matchGlob`.
