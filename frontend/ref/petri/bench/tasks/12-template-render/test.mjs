import test from 'node:test';
import assert from 'node:assert/strict';
import { render } from './solution.mjs';

test('substitutes a simple key', () => {
  assert.equal(render('Hi {{name}}!', { name: 'Ada' }), 'Hi Ada!');
});

test('substitutes a dotted path and trims spaces', () => {
  assert.equal(render('{{ user.city }}', { user: { city: 'Bath' } }), 'Bath');
});

test('indexes an array with a numeric segment', () => {
  assert.equal(render('{{a.0.b}}', { a: [{ b: 7 }] }), '7');
});

test('stringifies numbers and booleans', () => {
  assert.equal(render('{{n}}/{{t}}/{{f}}', { n: 0, t: true, f: false }), '0/true/false');
});

test('copies text with no placeholder', () => {
  assert.equal(render('nothing here', {}), 'nothing here');
  assert.equal(render('', {}), '');
});

test('a backslash escapes an opening brace pair', () => {
  assert.equal(render('\\{{name}}', { name: 'Ada' }), '{{name}}');
  assert.equal(render('a\\{{b}}c{{name}}', { name: 'Ada' }), 'a{{b}}cAda');
});

test('a lone backslash and a lone closing pair stay literal', () => {
  assert.equal(render('a\\b}}c', {}), 'a\\b}}c');
});

test('the output is never rescanned', () => {
  assert.equal(render('{{a}}', { a: '{{b}}', b: 'no' }), '{{b}}');
});

test('inherited properties count as missing', () => {
  assert.throws(() => render('{{toString}}', {}), ReferenceError);
  const proto = { hidden: 'x' };
  assert.throws(() => render('{{hidden}}', Object.create(proto)), ReferenceError);
});

test('rejects a missing key and a non-object on the way', () => {
  assert.throws(() => render('{{a.b}}', { a: 1 }), ReferenceError);
  assert.throws(() => render('{{a.b}}', {}), ReferenceError);
});

test('rejects a value of the wrong type', () => {
  assert.throws(() => render('{{a}}', { a: null }), TypeError);
  assert.throws(() => render('{{a}}', { a: { b: 1 } }), TypeError);
  assert.throws(() => render('{{a}}', {}), ReferenceError);
});

test('rejects bad templates, bad paths and bad arguments', () => {
  assert.throws(() => render('{{a', { a: 1 }), SyntaxError);
  assert.throws(() => render('{{}}', {}), SyntaxError);
  assert.throws(() => render('{{a..b}}', {}), SyntaxError);
  assert.throws(() => render('{{a-b}}', {}), SyntaxError);
  assert.throws(() => render(42, {}), TypeError);
  assert.throws(() => render('x', null), TypeError);
});
