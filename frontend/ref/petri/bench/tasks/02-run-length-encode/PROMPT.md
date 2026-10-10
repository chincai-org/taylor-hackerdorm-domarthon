# Run-length encode and decode a string

Write a file named `solution.mjs`. Export two named functions, `encode` and `decode`.

## Signature

```js
export function encode(input) { /* ... */ }
export function decode(input) { /* ... */ }
```

## Behaviour

`encode` replaces each run of one repeated character with three parts, in this order:

1. the run length, in decimal digits;
2. the single letter `x`;
3. the character that was repeated.

**Write this for every run, including a run of length 1.** The `x` separates the
count from the character, so the input may itself hold digits and still decode.

```js
encode('aaab')          // '3xa1xb'
encode('abc')           // '1xa1xb1xc'
encode('3')             // '1x3'
encode('xx')            // '2xx'
encode('')              // ''
encode('aaaaaaaaaaaa')  // '12xa'
```

`decode` is the exact inverse. It reads one or more decimal digits, then one `x`,
then takes the single next character, and repeats that character that many times.

```js
decode('3xa1xb')  // 'aaab'
decode('1x3')     // '3'
decode('1xx')     // 'x'
decode('')        // ''
```

For every string `s`, `decode(encode(s))` must equal `s`.

## Rules

1. A count is written in plain decimal digits. Write no leading zero.
2. `encode` compares characters by their UTF-16 code unit, one unit at a time.
3. If the argument of `encode` or of `decode` is not a string, throw a `TypeError`.
4. If the argument of `decode` is not a valid encoding, throw a `SyntaxError`.
   These inputs are all invalid:
   - `'xa'` — no digits before the `x`;
   - `'3a'` — no `x` after the digits;
   - `'3x'` — no character after the `x`;
   - `'0xa'` — a count of zero;
   - `'01xa'` — a leading zero in the count.
5. Use no imports. Use no I/O.

## Output format

Write only the file `solution.mjs`. Use ESM syntax. Export `encode` and `decode`.
