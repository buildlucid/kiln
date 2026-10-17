# Changelog

## Unreleased

- New `KilnFunctions`, `KilnFilters`, `KilnTests` and `KilnGlobals` interfaces. Add your own to them so your editor can show their types. See [Types from TypeScript](https://kilnlang.com/docs/tooling/editors/#types-from-typescript).
- `withRender` now keeps the types of your function's arguments and result.
- Cache tags. A function wrapped in `withRender` can call `render.tagCache("collection:pages")` to tag the `cache` section it runs in. The store's `set` now receives the section's `tags`, so it can clear copies when that data changes. See [Tags](https://kilnlang.com/docs/tags/cache/#tags).
- `memoryCache` has a `clear` method, which removes every copy, or those with any of the tags you pass.
- Copies saved by an earlier version of Kiln are treated as missing, so each section renders once more and is saved again.
- New `@lucidkiln/core/syntax` entry point with Kiln's parser, for editor tools. Its shapes can change in any minor release.

## 1.0.0

- The first stable release. Read the [documentation](https://kilnlang.com/docs/) to get started.
