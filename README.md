<p align="center">
	<img src="packages/kiln/assets/banner.png" alt="Kiln: fast, safe templates for server-rendered websites" width="100%">
</p>

# Kiln

Kiln is a template language for building websites on the server. The syntax will feel familiar if you know Twig, Jinja or Liquid.

**[Read the documentation at kilnlang.com](https://kilnlang.com)**

- **Async data.** Templates can call async functions to load what they need. Kiln only waits where a call returns a promise.
- **Server islands.** Build a page as static HTML and let the parts that need live data load on each visit, or stream them in from a server.
- **Runs anywhere.** No dependencies and no `eval`. Works on Node 24 and Cloudflare Workers.
- **Safe by default.** Templates only read what you give them, output is escaped, and limits stop runaway templates.
- **Layouts and components.** Blocks, includes, components with typed props and slots, and macros.
- **Clear errors.** Strict mode catches typos, and every error shows the template, line and column.

## Install

```bash
npm install @lucidkiln/core
```

Then follow the [quick start](https://kilnlang.com/docs/quick-start/) to render your first page.

## Learn more

- [Documentation](https://kilnlang.com/docs/)
- [Compared with other template languages](https://kilnlang.com/docs/comparison/)
- [Benchmarks](https://kilnlang.com/docs/benchmarks/)
- [Editor support](https://kilnlang.com/docs/tooling/editors/)
- [Changelog](packages/kiln/CHANGELOG.md)

## In this repository

| Folder | What it is |
| --- | --- |
| [`packages/kiln`](packages/kiln) | `@lucidkiln/core`, the template language |
| [`packages/language-server`](packages/language-server) | `@lucidkiln/language-server`, for errors, formatting and completions in your editor |
| [`packages/tree-sitter-kiln`](packages/tree-sitter-kiln) | `@lucidkiln/tree-sitter`, the grammar for syntax highlighting |
| [`packages/benchmarks`](packages/benchmarks) | Compares Kiln's render speed with other template engines |
| [`editors/zed`](editors/zed) | The Zed extension |
| [`apps/documentation`](apps/documentation) | The documentation site, [kilnlang.com](https://kilnlang.com) |
| [`apps/playground`](apps/playground) | A small app for trying features by hand |

## Licence

[MIT](LICENSE)
