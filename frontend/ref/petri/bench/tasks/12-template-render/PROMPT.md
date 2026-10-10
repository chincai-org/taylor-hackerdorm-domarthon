# Render a template with dotted placeholders

Write a file named `solution.mjs`. Export one named function, `render`.

## Signature

```js
export function render(template, data) { /* ... */ }
```

## Behaviour

`render` scans `template` from left to right and returns a new string. A
placeholder `{{path}}` is replaced by a value read from `data`. All other
characters are copied unchanged.

`path` is one or more segments joined by a dot. Each segment matches
`[A-Za-z0-9_]+`. Spaces and tabs directly inside the braces are ignored.

```js
render('Hi {{name}}!', { name: 'Ada' })                 // 'Hi Ada!'
render('{{ user.city }}', { user: { city: 'Bath' } })   // 'Bath'
render('{{a.0.b}}', { a: [{ b: 7 }] })                  // '7'
render('nothing here', {})                              // 'nothing here'
```

A numeric segment reads an array element by index. Read only own properties. An
inherited property, such as `toString` or `constructor`, counts as missing.

The output is never rescanned. A value that itself contains `{{x}}` is copied
into the output as literal text.

## Escapes

A backslash before `{{` produces a literal `{{` and the backslash disappears.

```js
render('\\{{name}}', { name: 'Ada' })   // '{{name}}'
```

A backslash anywhere else is a literal backslash. A `}}` with no open
placeholder is literal text.

## Errors

1. If `template` is not a string, throw a `TypeError`.
2. If `data` is `null`, or is not an object, throw a `TypeError`.
3. If a placeholder is opened and never closed, throw a `SyntaxError`.
4. If the path is empty, has an empty segment, or holds a character outside
   `[A-Za-z0-9_.]`, throw a `SyntaxError`.
5. If any segment of the path is missing, or if an intermediate value is not an
   object or an array, throw a `ReferenceError`.
6. If the final value is not a string, a number, or a boolean, throw a
   `TypeError`. An own key that exists and holds `null` gives this `TypeError`,
   not the `ReferenceError` of rule 5.

A resolved number or boolean is converted with `String(value)`.

## Rules

1. Do not change `data`.
2. Use no imports. Use no I/O.

## Output format

Write only the file `solution.mjs`. Use ESM syntax. Export the symbol `render`.
