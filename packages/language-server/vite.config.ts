import { defineConfig } from "vite-plus";

export default defineConfig({
	pack: {
		entry: ["src/main.ts"],
		format: "esm",
		platform: "node",
		fixedExtension: false,
		sourcemap: true,
		clean: true,
	},
	run: {
		tasks: {
			build: {
				command: ["tsc --noEmit", "vp pack"],
				dependsOn: ["@lucidkiln/core#build"],
				cache: false,
			},
		},
	},
});
