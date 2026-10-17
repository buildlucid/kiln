import { defineConfig } from "vite-plus";

export default defineConfig({
	pack: {
		entry: [
			"src/index.ts",
			"src/node.ts",
			"src/format.ts",
			"src/syntax.ts",
			"src/cli.ts",
		],
		dts: true,
		format: "esm",
		platform: "neutral",
		shims: false,
		sourcemap: true,
		clean: true,
		metafile: true,
		deps: {
			// Only the Node entry and the CLI import these, and Node provides them.
			neverBundle: [/^node:/],
		},
	},
});
