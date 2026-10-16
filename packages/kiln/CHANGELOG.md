# Changelog

All notable changes to `@lucidkiln/core` are listed here.

## Unreleased

- Kiln never calls a `then` method on your data. Waiting for an async call could call one before.
- Spreads count the items they copy against `maxSteps`. `json`, `dump` and island props count every item they convert.
- A failing render no longer leaves an unhandled promise rejection from a `cache` key or an import still loading.
- `?.` no longer evaluates keys or method arguments after a chain stops.
- Precompiled templates read a variable again after a block inside `if` changes it.
- `slots` includes the slots of a layout a component extends.
- `generateTypes` writes valid TypeScript for nested list props such as `number[][]`.
- Long `??` chains and deeply nested prop types report `too-deep` instead of overflowing the stack.
- `replace` checks the length of its result correctly against `maxOutputLength`.
- `renderStream` never splits a character between parts.
- Kiln never calls an unexposed `toString` or `toJSON` while converting a value, such as a formatting option or the method passed to `round`. Formatting option values must be strings, numbers or booleans.
- `urlEncode` counts the items it encodes against `maxSteps`, stops at `maxOutputLength` and refuses a value that contains itself.
- `truncate` checks its result against `maxOutputLength`, as its ending can make the text longer.
- Precompiled templates keep variables set in a loop pass after an include that waits, and read a variable again after a component's fill changes it.
- An error a getter in your data throws is a located `host-error` with the original as `cause`, however the property is read. So is an error from your cache store.

## 1.0.0 - 2026-10-16

- The first stable release. Read the [documentation](https://kilnlang.com/docs/) to get started.
