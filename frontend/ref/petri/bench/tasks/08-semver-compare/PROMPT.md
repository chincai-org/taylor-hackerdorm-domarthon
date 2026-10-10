# Compare two semantic version strings

Write a file named `solution.mjs`. Export one named function, `compare`.

## Signature

```js
export function compare(a, b) { /* ... */ }
```

## Behaviour

`compare` returns `-1` when `a` is lower than `b`, `1` when `a` is higher, and `0`
when the two have the same precedence. Return exactly these three numbers.

A version has the form `major.minor.patch`, then an optional prerelease after a `-`,
then optional build metadata after a `+`.

```js
compare('1.2.3', '1.2.4')            // -1
compare('2.0.0', '1.9.9')            // 1
compare('1.0.0', '1.0.0')            // 0
compare('1.0.0+build.1', '1.0.0')    // 0
```

## Precedence rules

1. Compare `major`, then `minor`, then `patch`. Compare them as numbers.
2. Build metadata is ignored. It never changes the result.
3. A version with a prerelease is **lower** than the same version without one.
   `1.0.0-alpha` is lower than `1.0.0`.
4. To compare two prereleases, split each on `.` into identifiers. Compare the
   identifiers one at a time:
   - an identifier of digits only is numeric. Compare two numeric identifiers as
     numbers, so `2` is lower than `10`;
   - a numeric identifier is always lower than an identifier with a letter or a `-`;
   - compare two non-numeric identifiers by ASCII order;
   - if all identifiers are equal, the version with **more** identifiers is higher.

```js
compare('1.0.0-2', '1.0.0-10')            // -1
compare('1.0.0-1', '1.0.0-alpha')         // -1
compare('1.0.0-alpha', '1.0.0-alpha.1')   // -1
compare('1.0.0-alpha.1', '1.0.0-beta')    // -1
```

## Rules

1. If `a` or `b` is not a string, throw a `TypeError`.
2. If `a` or `b` is not a valid version, throw a `SyntaxError`. A version is invalid
   when:
   - it does not have all three of major, minor and patch, as in `'1.0'`;
   - a number has a leading zero, as in `'01.0.0'`;
   - it starts with `v`, as in `'v1.0.0'`;
   - the prerelease or the build part is empty, as in `'1.0.0-'`;
   - a prerelease identifier is empty, as in `'1.0.0-a..b'`;
   - a numeric prerelease identifier has a leading zero, as in `'1.0.0-01'`;
   - an identifier holds a character other than `0-9`, `A-Z`, `a-z` and `-`.

   Note that `'1.0.0-0a'` is valid. It is not numeric, so the leading zero is fine.
3. Use no imports. Use no I/O.

## Output format

Write only the file `solution.mjs`. Use ESM syntax. Export the symbol `compare`.
