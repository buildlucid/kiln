import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vite-plus/test";
import { EDITOR_DOCS_FILE, generateEditorDocs } from "./editor-docs.js";

describe("editor docs", () => {
	test("the language server's docs.json matches the docs. Build the docs to update it", async () => {
		expect(await readFile(EDITOR_DOCS_FILE, "utf8")).toBe(
			await generateEditorDocs(),
		);
	}, 30_000);

	test("takes each name's section up to the end of its first example, with a link to the section", async () => {
		const docs = JSON.parse(await generateEditorDocs());
		expect(docs.filters.lower).toEqual(docs.filters.upper);
		expect(docs.filters.upper.url).toBe(
			"https://kilnlang.com/docs/filters/strings/#upper-and-lower",
		);
		expect(docs.filters.truncate.markdown).toMatch(
			/^Shortens text[\s\S]*\n\n---\n\n\*page\.kiln\*\n\n```kiln\n[\s\S]*\*Output\*\n\n```html\nKiln is a tem…\nShort\n```$/,
		);
		expect(docs.tags.for.markdown).toMatch(/^Loop over arrays/);
		expect(docs.tags.block.url).toBe(
			"https://kilnlang.com/docs/tags/extends/#blocks",
		);
	}, 30_000);
});
