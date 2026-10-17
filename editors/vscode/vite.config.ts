import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";

export default defineConfig({
	pack: {
		// The extension and the language server it starts, each bundled with everything it needs. VS Code ships
		// without a package manager, so nothing is installed at runtime. VS Code provides `vscode` itself.
		entry: {
			extension: "src/extension.ts",
			server: fileURLToPath(
				import.meta.resolve("@lucidkiln/language-server/dist/main.js"),
			),
		},
		format: "cjs",
		platform: "node",
		minify: true,
		clean: true,
		deps: {
			neverBundle: ["vscode"],
			onlyBundle: false,
		},
		// `vscode-html-languageservice` and friends point `main` at UMD builds, whose requires can't be bundled.
		inputOptions: {
			resolve: { mainFields: ["module", "main"] },
		},
	},
	run: {
		tasks: {
			build: {
				command: [
					"tsc --noEmit",
					"vp pack",
					"cp ../zed/snippets/kiln.json dist/snippets.json",
				],
				dependsOn: ["@lucidkiln/language-server#build"],
				cache: false,
			},
		},
	},
});
