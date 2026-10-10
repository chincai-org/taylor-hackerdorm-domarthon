# Parse CSV text into rows of fields

Write a file named `solution.mjs`. Export one named function, `parseCsv`.

## Signature

```js
export function parseCsv(text) { /* ... */ }
```

## Behaviour

`parseCsv` returns an array of records. Each record is an array of field strings.

A comma separates two fields. A record terminator ends a record. The terminator is
either `\n` or `\r\n`.

```js
parseCsv('a,b\nc,d')   // [['a', 'b'], ['c', 'd']]
parseCsv('a,b\r\nc,d') // [['a', 'b'], ['c', 'd']]
parseCsv('a,,b')       // [['a', '', 'b']]
parseCsv(',')          // [['', '']]
```

A field may be quoted with `"`. The opening quote must be the first character of the
field. Inside a quoted field, a comma, a `\n` and a `\r` are ordinary characters, and
two quotes `""` mean one literal quote.

```js
parseCsv('"a,b",c')          // [['a,b', 'c']]
parseCsv('"line1\nline2"')   // [['line1\nline2']]
parseCsv('"say ""hi""",b')   // [['say "hi"', 'b']]
parseCsv('""')               // [['']]
```

## Rules

1. One record terminator at the very end of `text` is ignored. It does not make an
   extra empty record.

   ```js
   parseCsv('a,b\n')   // [['a', 'b']]
   parseCsv('a\n\n')   // [['a'], ['']]
   parseCsv('\n')      // [['']]
   parseCsv('')        // []
   ```

2. In an unquoted field every character is literal. Spaces are kept. A quote that is
   not the first character of the field is a literal quote, so `a"b` is the field
   `a"b`.
3. A `\r` that is not directly before a `\n` is an ordinary character.
4. If a quoted field never closes, throw a `SyntaxError`.
5. If a character other than a comma or a record terminator follows the closing
   quote of a quoted field, throw a `SyntaxError`. So `"a"b` is invalid.
6. If `text` is not a string, throw a `TypeError`.
7. Use no imports. Use no I/O.

## Output format

Write only the file `solution.mjs`. Use ESM syntax. Export the symbol `parseCsv`.
