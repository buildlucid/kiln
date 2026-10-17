# Developing the VS Code extension

This file stays out of the published extension. `README.md` is the extension's page on the Marketplace and Open VSX, so it only covers using the extension.

## Building and trying it

From the repository root, build everything once, then build the extension:

```sh
npm run build
npm run build --workspace editors/vscode
```

To try it, start VS Code with the extension loaded from this folder. Rebuild and reload the window after each change.

```sh
code --extensionDevelopmentPath="$PWD/editors/vscode" apps/documentation
```

The grammar's tests run with the rest of the repository's tests (`npm test`). They tokenise templates with Shiki, which uses the same grammar engine and HTML grammar as VS Code.

## Publishing

The extension goes to two registries. The Visual Studio Marketplace serves VS Code. [Open VSX](https://open-vsx.org) serves Cursor, Windsurf, VSCodium and other editors built on VS Code.

1. Bump `version` in `package.json`.
2. Build, then package the extension into a `.vsix` file:

   ```sh
   npm run build --workspace editors/vscode
   npm run package --workspace editors/vscode
   ```

3. Publish the same `.vsix` file to both registries:

   ```sh
   npx @vscode/vsce publish --packagePath kiln-<version>.vsix
   npx ovsx publish kiln-<version>.vsix
   ```

`vsce` needs a personal access token from Azure DevOps for the `buildlucid` publisher, in `VSCE_PAT`. `ovsx` needs an Open VSX access token, in `OVSX_PAT`, and the `buildlucid` namespace must exist there first (`npx ovsx create-namespace buildlucid`).
