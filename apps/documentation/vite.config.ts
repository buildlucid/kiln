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
		{
			// Preloads the body font, so it downloads with the stylesheet rather than after it. The
			// hero heading is the largest paint and it re-paints once this font arrives.
			name: "preload-font",
			apply: "build",
			transformIndexHtml: {
				order: "post",
				handler(_html, { bundle }) {
					const font = Object.values(bundle ?? {}).find(
						(file) =>
							file.type === "asset" &&
							file.names.includes("geist-latin-wght-normal.woff2"),
					);
					if (!font) throw new Error("preload-font: Geist's latin font is missing from the build");
					return [
						{
							tag: "link",
							attrs: {
								rel: "preload",
								href: `/${font.fileName}`,
								as: "font",
								type: "font/woff2",
								crossorigin: true,
							},
							injectTo: "head",
						},
					];
				},
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
