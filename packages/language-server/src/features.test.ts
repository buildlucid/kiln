import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import { TextDocument } from "vscode-languageserver-textdocument";
import { definition } from "./features.js";
import { openProject } from "./project.js";

describe("definition", () => {
	let dir: string;
	const page = (text: string) =>
		TextDocument.create(
			pathToFileURL(join(dir, "page.kiln")).href,
			"kiln",
			1,
			text,
		);

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "kiln-features-"));
	});
	afterEach(() => rm(dir, { recursive: true }));

	test("links from the whole template name to the template", async () => {
		await writeFile(join(dir, "kiln.json"), "{}");
		const project = await openProject(join(dir, "kiln.json"), dir, () => {});
		const document = page('{% include "islands/latest-pages" %}');
		const link = await definition({ document, project, name: "page.kiln" }, 20);
		expect(link).toMatchObject({
			targetUri: pathToFileURL(join(dir, "islands/latest-pages.kiln")).href,
			originSelectionRange: {
				start: { line: 0, character: 12 },
				end: { line: 0, character: 32 },
			},
		});
	});

	test("without kiln.json, finds macros in the template but not other templates", async () => {
		const project = await openProject(null, dir, () => {});
		const document = page(
			'{% include "islands/latest-pages" %}\n{% macro card() %}{% endmacro %}{{ card() }}',
		);
		const open = { document, project, name: "page.kiln" };
		expect(await definition(open, 20)).toBeNull();
		expect(
			await definition(open, document.getText().lastIndexOf("card")),
		).toMatchObject({
			targetUri: document.uri,
			targetRange: { start: { line: 1, character: 0 } },
		});
	});
});
