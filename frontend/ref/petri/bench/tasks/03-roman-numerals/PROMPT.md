# Convert between integers and Roman numerals

Write a file named `solution.mjs`. Export two named functions, `toRoman` and
`fromRoman`.

## Signature

```js
export function toRoman(value) { /* ... */ }
export function fromRoman(text) { /* ... */ }
```

## Behaviour

`toRoman` converts an integer from 1 to 3999 into the standard Roman numeral. Use
upper case letters only. Use the six subtractive pairs `CM`, `CD`, `XC`, `XL`, `IX`
and `IV`.

```js
toRoman(1)     // 'I'
toRoman(4)     // 'IV'
toRoman(14)    // 'XIV'
toRoman(1990)  // 'MCMXC'
toRoman(2024)  // 'MMXXIV'
toRoman(3999)  // 'MMMCMXCIX'
```

`fromRoman` converts a numeral back to its integer.

```js
fromRoman('XIV')        // 14
fromRoman('MMMCMXCIX')  // 3999
```

`fromRoman` accepts **only the one standard form** that `toRoman` produces. For every
integer `n` from 1 to 3999, `fromRoman(toRoman(n))` must equal `n`.

## Rules

1. A numeral that is not in standard form is invalid. Throw a `SyntaxError`.
   These are all invalid:
   - `'IIII'` and `'VIIII'` — four copies of the same letter in a row;
   - `'IC'`, `'IL'` and `'VX'` — a subtractive pair that is not one of the six;
   - `'VV'` and `'DD'` — `V`, `L` and `D` repeat;
   - `''` — the empty string;
   - `'xiv'` — lower case;
   - `'ABC'` — a letter that is not `M`, `D`, `C`, `L`, `X`, `V` or `I`.
2. If `value` is not a number, throw a `TypeError`. If `value` is not an integer, or
   is less than 1, or is greater than 3999, throw a `RangeError`.
3. If `text` is not a string, throw a `TypeError`.
4. Do not trim the input. A leading or trailing space makes the numeral invalid.
5. Use no imports. Use no I/O.

## Output format

Write only the file `solution.mjs`. Use ESM syntax. Export `toRoman` and `fromRoman`.
