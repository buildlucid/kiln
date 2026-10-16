import { defineConfig } from "vite-plus";

export default defineConfig({
	run: {
		tasks: {
			bench: {
				command: "node src/run.ts",
				dependsOn: ["@lucidcms/kiln#build"],
				cache: false,
			},
		},
	},
});
