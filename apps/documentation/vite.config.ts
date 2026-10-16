import benchmarks from "@lucidkiln/benchmarks/results.json" with { type: "json" };
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite-plus";
import { kilnPages } from "./plugin/index.js";
import { siteFiles } from "./src/files.js";
import { navigation, pageContext } from "./src/navigation.js";
import { site } from "./src/site.js";

export default defineConfig({
	plugins: [
		kilnPages({
			globals: {
				site,
				navigation,
				benchmarks,
			},
			context: (page) => pageContext(page.url, page.template),
			files: siteFiles,
			search: true,
		}),
		tailwindcss(),
	],
	run: {
		tasks: {
			build: {
				command: ["tsc --noEmit", "vp build"],
				dependsOn: ["@lucidkiln/core#build"],
				cache: false,
			},
		},
	},
});
