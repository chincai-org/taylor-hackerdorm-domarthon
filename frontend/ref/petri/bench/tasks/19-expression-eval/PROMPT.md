# Evaluate an arithmetic expression string

Write a file named `solution.mjs`. Export one named function, `evaluate`.

## Signature

```js
export function evaluate(expr) { /* ... */ }
```

## Behaviour

`evaluate` parses `expr` and returns its value as a `number`.

```js
evaluate('1 + 2 * 3')        // 7
evaluate('(1 + 2) * 3')      // 9
evaluate('2 - 3 - 4')        // -5
evaluate('-2 * 3')           // -6
evaluate('2 * -3')           // -6
evaluate('7 % 3')            // 1
evaluate('-7 % 3')           // -1
evaluate('1 / 4')            // 0.25
```

## The grammar

- A number is one or more digits, then optionally a dot and one or more digits.
  `12` and `3.5` are numbers. `.5`, `1.`, `1e3` and `0x10` are not.
- The binary operators are `+`, `-`, `*`, `/` and `%`.
- `*`, `/` and `%` bind tighter than `+` and `-`.
- Operators of equal precedence group to the left.
- `(` and `)` group a sub-expression. They may nest to any depth.
- A `+` or `-` directly before a value is a unary sign. It binds tighter than any
  binary operator and looser than parentheses. Signs may repeat: `--3` is `3`.
- Spaces and tabs may appear anywhere between tokens. They mean nothing.

Arithmetic is ordinary JavaScript arithmetic on `number` values. So `%` takes the
sign of its left operand, and `evaluate('0.1 + 0.2')` returns the same value as
the JavaScript expression `0.1 + 0.2`.

## Errors

1. If `expr` is not a string, throw a `TypeError`.
2. If dividing or taking the remainder by zero, throw a `RangeError`.
3. On any malformed input, throw a `SyntaxError`. This covers an empty string, a
   missing operand, two numbers in a row, an unmatched parenthesis, an empty pair
   of parentheses and any character outside the grammar.

## Rules

1. Never call `eval`, `Function`, or any other way of running the string as code.
2. Use no imports. Use no I/O.
3. The function must handle an expression with 5000 operators, and 500 levels of
   nested parentheses, inside a few seconds.

## Output format

Write only the file `solution.mjs`. Use ESM syntax. Export the symbol `evaluate`.
