import { defineConfig } from "vite-plus";

export default defineConfig({
	pack: {
		entry: ["src/index.ts", "src/node.ts"],
		dts: true,
		format: "esm",
		platform: "neutral",
		shims: false,
		sourcemap: true,
		clean: true,
		metafile: true,
		deps: {
			// Only the Node entry imports these, and Node provides them.
			neverBundle: [/^node:/],
		},
	},
});
