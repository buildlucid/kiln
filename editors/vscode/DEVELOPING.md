# Developing the VS Code extension

This file stays out of the published extension. `README.md` is the extension's page on the Marketplace and Open VSX, so it only covers using the extension.

## Building and trying it

From the repository root, build the extension and the packages it needs:

```sh
npx vp run --filter ./editors/vscode build
```

To try it, start VS Code with the extension loaded from this folder. Rebuild and reload the window after each change.

```sh
code --extensionDevelopmentPath="$PWD/editors/vscode" apps/documentation
```

The grammar's tests run with the rest of the repository's tests (`npm test`). They tokenise templates with Shiki, which uses the same grammar engine and HTML grammar as VS Code.
