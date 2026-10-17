# Changelog

## Unreleased

- Go to definition no longer sends you to the wrong file when a project has no `kiln.json`. Without one, it only finds macros in the same template. ([0541b63](https://github.com/buildlucid/kiln/commit/0541b63f3454db32100fd09de95f9de40f8ded3f))
- Go to definition now underlines the whole template name, such as `layouts/base`, instead of one word of it. ([0541b63](https://github.com/buildlucid/kiln/commit/0541b63f3454db32100fd09de95f9de40f8ded3f))
- Go to definition now works for variables. It goes to the prop, `set`, `for`, macro argument or import that brings the variable into scope.
- Completions for variables now follow Kiln's scope rules, so a loop's variables stop at `endfor`.
- With TypeScript 6 or later, the editor reads the types of your functions, filters, tests, globals and prop types. It completes properties after a dot, shows types and doc comments on hover, and goes to the TypeScript source. See [Types from TypeScript](https://kilnlang.com/docs/tooling/editors/#types-from-typescript).

## 1.0.0

- The first release. Read the [editor docs](https://kilnlang.com/docs/tooling/editors/) to get started.
