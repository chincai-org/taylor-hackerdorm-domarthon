# A least recently used cache with a fixed capacity

Write a file named `solution.mjs`. Export one named function, `createCache`.

## Signature

```js
export function createCache(capacity) { /* ... */ }
```

`createCache` returns a new cache object with six methods:

```js
cache.get(key)        // the value, or undefined
cache.set(key, value) // returns undefined
cache.has(key)        // true or false
cache.delete(key)     // true if the key was there, false if not
cache.size()          // the number of entries now held
cache.keys()          // an array of the keys
```

## Behaviour

The cache holds at most `capacity` entries. When a `set` would make the cache larger
than `capacity`, the cache first removes the **least recently used** entry.

```js
const c = createCache(2);
c.set('a', 1);
c.set('b', 2);
c.set('c', 3);   // 'a' is removed
c.has('a');      // false
```

## Rules

1. `get` and `set` both count as a use. The key they touch becomes the most recently
   used key.

   ```js
   const c = createCache(2);
   c.set('a', 1);
   c.set('b', 2);
   c.get('a');    // 'a' is now the most recently used
   c.set('c', 3); // so 'b' is removed, not 'a'
   ```

2. `has`, `delete`, `size` and `keys` do **not** count as a use. They never change
   the order.
3. A `get` of a key that is not held returns `undefined` and changes nothing.
4. A `set` of a key that is already held replaces the value and counts as a use. It
   never removes another entry, because the number of entries does not grow.
5. `keys` returns a new array, ordered from the least recently used key to the most
   recently used key.
6. Compare keys the way a `Map` does. Any value may be a key, and any value may be a
   value, including `undefined`. So `has` is the only way to tell a stored
   `undefined` from a missing key.
7. A `capacity` of `0` is allowed. Such a cache stores nothing: after any `set`, its
   `size()` is `0` and `has` is `false`.
8. If `capacity` is not a number, throw a `TypeError`. If it is not an integer, or is
   less than `0`, throw a `RangeError`. Throw at the call to `createCache`.
9. Two caches made by two calls share no state.
10. Use no imports. Use no I/O.

## Output format

Write only the file `solution.mjs`. Use ESM syntax. Export the symbol `createCache`.
