# Wrap text to a maximum line width

Write a file named `solution.mjs`. Export one named function, `wrapText`.

## Signature

```js
export function wrapText(text, width) { /* ... */ }
```

## Behaviour

`wrapText` breaks `text` into lines of at most `width` characters and returns the
result as one string, with `\n` between the lines.

No output line is ever longer than `width`.

## How the text is read

1. `\n` is the only line separator. Split `text` on `\n` first, wrap each part on
   its own, then join the wrapped parts back with `\n`. An empty part stays an
   empty line, so blank lines survive.
2. Inside one part, a word is a run of characters with no space. A run of one or
   more spaces separates two words. Leading and trailing spaces disappear. A run
   of several spaces becomes one space.
3. A part that holds only spaces becomes an empty line.

## How the lines are filled

Fill greedily, from left to right. Put the next word on the current line when the
line, plus one space, plus the word, is still at most `width` characters. Start a
new line otherwise.

A word longer than `width` cannot fit anywhere. It is hard-split:

1. Finish the current line first, if it holds anything.
2. Cut the word into pieces of exactly `width` characters, from the start.
3. The final short piece stays on the current line. Later words may join it.

```js
wrapText('the quick brown fox', 10)   // 'the quick\nbrown fox'
wrapText('abc def', 7)                // 'abc def'
wrapText('abcdefghij', 4)             // 'abcd\nefgh\nij'
wrapText('ab cdefgh', 4)              // 'ab\ncdef\ngh'
wrapText('abcdefgh x', 6)             // 'abcdef\ngh x'
wrapText('  a   b  ', 10)             // 'a b'
wrapText('a\n\nb', 5)                 // 'a\n\nb'
wrapText('', 5)                       // ''
```

## Errors

1. If `text` is not a string, throw a `TypeError`.
2. If `width` is not an integer, or is less than 1, throw a `RangeError`.

## Rules

1. Use no imports. Use no I/O.

## Output format

Write only the file `solution.mjs`. Use ESM syntax. Export the symbol
`wrapText`.
