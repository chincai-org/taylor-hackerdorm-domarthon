# Run events through a state transition table

Write a file named `solution.mjs`. Export one named function, `createMachine`.

## Signature

```js
export function createMachine(config) { /* ... */ }
```

## The config

```js
const config = {
  initial: 'idle',
  states: {
    idle: {
      onEntry: 'enterIdle',          // optional action name
      onExit: 'exitIdle',            // optional action name
      on: {
        START: { target: 'running', action: 'begin' },
      },
    },
    running: {
      on: {
        // An array is tried in order. The first transition whose guard passes wins.
        STOP: [
          { target: 'idle', guard: (event) => event.force === true, action: 'hardStop' },
          { target: 'running', action: 'ignore' },
        ],
      },
    },
  },
};
```

Every action is a **string name**, never a function. A `guard` is a function. It
receives the event object and returns a truthy or falsy value.

## The machine

`createMachine` returns an object with:

- `state` — the name of the current state, as a string.
- `log` — an array of action names, in the order they ran.
- `send(event)` — feed one event. It returns `true` when a transition happened,
  and `false` when none did.

An `event` is a string, or an object with a string `type` property. A string
`'START'` behaves exactly like `{ type: 'START' }`. A guard always receives an
object.

## Order of work

1. When `createMachine` returns, `state` is `config.initial` and `log` already
   holds the `onEntry` action of that state, if it has one.
2. `send(event)` finds the transitions listed for `event.type` in the current
   state. A single object counts as a list of one.
3. It tries them in order and takes the first whose `guard` returns a truthy
   value. A transition with no `guard` always passes.
4. If no transition passes, nothing is logged, `state` does not change, and
   `send` returns `false`.
5. Otherwise three actions run, in this exact order, and each one that exists is
   appended to `log`: the `onExit` of the current state, then the `action` of
   the transition, then the `onEntry` of the target state.
6. `state` becomes the target. `send` returns `true`.

A transition whose target is the current state is a real transition. Its `onExit`
and `onEntry` both run.

## Errors

1. If `config` is not an object, or `config.states` is not an object, throw a
   `TypeError`.
2. If `config.initial` names a state that `config.states` does not hold, throw a
   `ReferenceError`.
3. If any transition names a target that `config.states` does not hold, throw a
   `ReferenceError`. Check this when the machine is created, not when the event
   arrives.
4. If a `guard` is present and is not a function, throw a `TypeError` when the
   machine is created.
5. If `send` gets neither a string nor an object with a string `type`, throw a
   `TypeError`.

## Rules

1. Do not change `config`.
2. Two machines built from one config are independent. They do not share `log`
   or `state`.
3. Use no imports. Use no I/O.

## Output format

Write only the file `solution.mjs`. Use ESM syntax. Export the symbol
`createMachine`.
