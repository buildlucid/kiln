import { writeFile } from "node:fs/promises";
import benchmarks from "@lucidkiln/benchmarks/results.json" with { type: "json" };
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite-plus";
import { kilnPages } from "./plugin/index.js";
import { comparison } from "./src/comparison.js";
import { EDITOR_DOCS_FILE, generateEditorDocs } from "./src/editor-docs.js";
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
				comparison,
			},
			context: (page) => pageContext(page.url, page.template),
			files: siteFiles,
			search: true,
		}),
		tailwindcss(),
		{
			// The language server's hover and completion docs come from these pages. See src/editor-docs.ts.
			name: "editor-docs",
			apply: "build",
			async buildStart() {
				await writeFile(EDITOR_DOCS_FILE, await generateEditorDocs());
			},
		},
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
