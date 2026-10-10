# Add two decimal strings exactly

Write a file named `solution.mjs`. Export one named function, `addDecimal`.

## Signature

```js
export function addDecimal(a, b) { /* ... */ }
```

## Behaviour

`a` and `b` are decimal numbers written as strings. `addDecimal` returns their
exact sum, also as a string.

The result must be **exact** at any size. A number in this task can hold far
more digits than a JavaScript `number` can carry. Never convert an input to a
`number`, and never use floating point. Add the digits yourself, or use `BigInt`.

```js
addDecimal('0.1', '0.2')                        // '0.3'
addDecimal('1.5', '2.25')                       // '3.75'
addDecimal('99.99', '0.01')                     // '100'
addDecimal('12345678901234567890', '1')         // '12345678901234567891'
addDecimal('-1.5', '1.5')                       // '0'
addDecimal('3', '-5')                           // '-2'
```

## Accepted input

Each input matches this grammar and nothing else:

```
optional '+' or '-', then one or more digits, then optionally '.' and one or more digits
```

So `'007.10'`, `'+1.20'` and `'-0.5'` are accepted. `'.5'`, `'1.'`, `''`,
`'1e3'`, `'1.2.3'`, `'-'` and `'1 '` are not.

## The result format

1. Write the smallest correct text. Drop every trailing zero of the fraction.
   Drop the dot as well when no fraction digit is left.
2. Drop leading zeros of the integer part. Keep one digit, so a zero integer
   part is written `0`.
3. Write a leading `-` only when the sum is less than zero. Never write `+`.
   A sum of zero is always `'0'`, never `'-0'`.

```js
addDecimal('007.10', '0.90')   // '8'
addDecimal('+1.20', '0.80')    // '2'
addDecimal('0.10', '0.20')     // '0.3'
```

## Errors

1. If either argument is not a string, throw a `TypeError`.
2. If either argument does not match the grammar above, throw a `SyntaxError`.

## Rules

1. Use no imports. Use no I/O.

## Output format

Write only the file `solution.mjs`. Use ESM syntax. Export the symbol
`addDecimal`.
