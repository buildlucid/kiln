# Changelog

## 1.7.1

- Supports Node 26 as well as Node 24. ([de608f3](https://github.com/buildlucid/kiln/commit/de608f35b8e5a022eb28e03e8083e8c64f4e3d15))

## 1.7.0

- Cache stores now receive the render's `state` in `get` and `set`, so a store can keep something per request, such as the connection it reads with. See [Cache stores](https://kilnlang.com/docs/tags/cache/#cache-stores). ([2fa3f0a](https://github.com/buildlucid/kiln/commit/2fa3f0a37d8f9b1e5dd51c1ece78e5938998f72e))

## 1.6.0

- New host components. A loader can return a component written in JavaScript with `hostComponent`, such as one made with React or Svelte. ([8d43019](https://github.com/buildlucid/kiln/commit/8d43019e8a0278449232b518d9e0a0f22547d83e))
- `withRender` functions and host components can add HTML to an outlet with `render.addTo`. ([8d43019](https://github.com/buildlucid/kiln/commit/8d43019e8a0278449232b518d9e0a0f22547d83e))
- `generateManifest` takes a `components` list of the files your loader returns as host components. ([8d43019](https://github.com/buildlucid/kiln/commit/8d43019e8a0278449232b518d9e0a0f22547d83e))

## 1.5.0

- New `globals` render option, which adds globals for one render on top of the environment's. ([8560145](https://github.com/buildlucid/kiln/commit/8560145ff40508c0fff2390677bfb75d0d51e306))
- Deferred island manifest entries now record the render's `locale` and `timeZone`, and both are part of the island's id, so ids from earlier versions change. ([8560145](https://github.com/buildlucid/kiln/commit/8560145ff40508c0fff2390677bfb75d0d51e306))

## 1.4.0

- New `builtins` export, which lists Kiln's own function, filter and test names. ([8d99639](https://github.com/buildlucid/kiln/commit/8d99639916ce3dfb920d567ed4de9069ec739cd7))
- New `export` tag. A template can give your code a value without rendering, which `evaluate` works out and `analyze` lists in `exports`. ([1e5cff7](https://github.com/buildlucid/kiln/commit/1e5cff72e7416abbc4695334e405bd38e5986f01))

## 1.3.0

- `analyze` now reports each function call and its arguments in `calls`, with the value of every literal argument. ([72780ec](https://github.com/buildlucid/kiln/commit/72780ec6a827a8d416141b0e8921efa22bcd5a65))

## 1.2.0

- Inserted content is no longer re-indented to line up with its tag. ([46e6cae](https://github.com/buildlucid/kiln/commit/46e6cae3afbbc88ded8a19dcd9018f8559d4e7ce))
- `withRender` now keeps your function's type parameters, and `RenderAware` takes the whole function type. ([08f192c](https://github.com/buildlucid/kiln/commit/08f192cd0fcf7913039bd065d9ced29d5453a73a))

## 1.1.0

- New `KilnFunctions`, `KilnFilters`, `KilnTests` and `KilnGlobals` interfaces. Add your own to them so your editor can show their types. See [Types from TypeScript](https://kilnlang.com/docs/tooling/editors/#types-from-typescript). ([d55ef63](https://github.com/buildlucid/kiln/commit/d55ef63677df3b34ea247f3b9f25562b201a18b0))
- `withRender` now keeps the types of your function's arguments and result. ([d55ef63](https://github.com/buildlucid/kiln/commit/d55ef63677df3b34ea247f3b9f25562b201a18b0))
- Cache tags. A function wrapped in `withRender` can call `render.tagCache("collection:pages")` to tag the `cache` section it runs in. The store's `set` now receives the section's `tags`, so it can clear copies when that data changes. See [Tags](https://kilnlang.com/docs/tags/cache/#tags). ([6a9b26f](https://github.com/buildlucid/kiln/commit/6a9b26f4d8beadc6d04f358e617a11b237a1487e))
- `memoryCache` has a `clear` method, which removes every copy, or those with any of the tags you pass. ([6a9b26f](https://github.com/buildlucid/kiln/commit/6a9b26f4d8beadc6d04f358e617a11b237a1487e))
- Copies saved by an earlier version of Kiln are treated as missing, so each section renders once more and is saved again. ([6a9b26f](https://github.com/buildlucid/kiln/commit/6a9b26f4d8beadc6d04f358e617a11b237a1487e))
- New `@lucidkiln/core/syntax` entry point with Kiln's parser, for editor tools. Its shapes can change in any minor release. ([d55ef63](https://github.com/buildlucid/kiln/commit/d55ef63677df3b34ea247f3b9f25562b201a18b0))

## 1.0.0

- The first stable release. Read the [documentation](https://kilnlang.com/docs/) to get started.
