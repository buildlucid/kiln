# Kiln language server

Errors, formatting, completions, hover and navigation for Kiln templates. Use the Kiln extension for VS Code or Zed, or install the server for another LSP client:

```sh
npm install --save-dev @lucidkiln/language-server
npx kiln-language-server --stdio
```

The server requires Node 24 or 26. It uses the project's installed copy of `@lucidkiln/core` when available, and otherwise its declared core dependency. Generate `kiln.json` with `generateManifest` so it knows your template root and registered functions, filters, tests, globals and types without running your app.

See [editor setup](https://kilnlang.com/docs/tooling/editors/) and the [Kiln documentation](https://kilnlang.com/docs/).
