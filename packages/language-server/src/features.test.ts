import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "vite-plus/test";
import { TextDocument } from "vscode-languageserver-textdocument";
import {
	argumentWarnings,
	complete,
	definition,
	hover,
	type OpenTemplate,
	signatureHelp,
} from "./features.js";
import { diagnose, openProject, type Project } from "./project.js";
import { createTestProject } from "./test-project.js";

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

	test("goes from a variable to where the template declares it", async () => {
		const project = await openProject(null, dir, () => {});
		const text = [
			"{% props page, tags = [] %}",
			"{% set title = page.title %}",
			"{% for i, brick in page.bricks %}{{ brick }}{{ i }}{% endfor %}",
			"{% macro card(heading) %}{{ heading }}{% endmacro %}",
			"{{ tags|map(tag => tag.name) }}{{ title }}",
		].join("\n");
		const document = page(text);
		const open = { document, project, name: "page.kiln" };
		/** The text a definition at the nth `word` points to. */
		const target = async (word: string, nth = 1) => {
			let at = -1;
			for (let count = 0; count < nth; count++) at = text.indexOf(word, at + 1);
			const link = await definition(open, at);
			if (!link) return null;
			const start = document.offsetAt(link.targetRange.start);
			return [start, document.offsetAt(link.targetRange.end)];
		};
		const spanOf = (word: string, nth = 1) => {
			let at = -1;
			for (let count = 0; count < nth; count++) at = text.indexOf(word, at + 1);
			return [at, at + word.length];
		};
		expect(await target("page", 2)).toEqual(spanOf("page"));
		expect(await target("brick", 3)).toEqual(spanOf("brick"));
		const index = text.indexOf("i,");
		expect(await target("i }}")).toEqual([index, index + 1]);
		expect(await target("heading", 2)).toEqual(spanOf("heading"));
		const tag = text.indexOf("tag =>");
		expect(await target("tag.name")).toEqual([tag, tag + 3]);
		expect(await target("title", 3)).toEqual(spanOf("title"));
	});
});

describe("TypeScript types", () => {
	let dir: string;
	let project: Project;
	const open = (text: string): OpenTemplate => ({
		document: TextDocument.create(
			pathToFileURL(join(dir, "src/templates/page.kiln")).href,
			"kiln",
			1,
			text,
		),
		project,
		name: "page.kiln",
	});
	const hoverText = async (text: string, at: string) => {
		const result = await hover(open(text), text.indexOf(at));
		return result &&
			typeof result.contents === "object" &&
			"value" in result.contents
			? result.contents.value
			: null;
	};

	beforeAll(async () => {
		dir = await createTestProject(7);
		project = await openProject(join(dir, "kiln.json"), dir, (message) => {
			throw new Error(message);
		});
	});
	afterAll(async () => {
		project.close();
		await rm(dir, { recursive: true });
	});

	test("completes the properties of typed values after a dot", async () => {
		const text = "{% props page: Page %}{{ page. }}";
		const items = await complete(open(text), text.indexOf(". }}") + 1);
		expect(items.map((item) => [item.label, item.detail])).toEqual([
			["title", "title: string"],
			["bricks", "bricks: Brick[]"],
		]);
		expect(items[0]?.documentation).toMatchObject({
			value: "The page's title.",
		});

		const loop =
			"{% props page: Page %}{% for brick in page.bricks %}{{ brick.ke }}{% endfor %}";
		const fromLoop = await complete(open(loop), loop.indexOf("ke }}") + 2);
		expect(fromLoop.map((item) => item.label)).toEqual(["key", "fields"]);
	});

	test("shows types and doc comments on hover", async () => {
		const text =
			'{% props page: Page %}{% set pages = documents("pages") %}{{ page.title }}{{ site.name }}{{ pages }}';
		expect(await hoverText(text, "documents")).toBe(
			[
				"```ts\ndocuments(collection: string, query?: { limit?: number | undefined; } | undefined): Promise<Page[]>\n```",
				"Finds the published documents in a collection.\n\n*@param* collection The collection's key.",
			].join("\n\n---\n\n"),
		);
		expect(await hoverText(text, "title }}")).toBe(
			"```ts\ntitle: string\n```\n\n---\n\nThe page's title.",
		);
		expect(await hoverText(text, "site")).toContain("About the site.");
		expect(await hoverText(text, "pages }}")).toBe(
			"```ts\npages: Page[]\n```\n\n---\n\nSet in this template.",
		);
	});

	test("goes to the TypeScript source of functions and properties", async () => {
		const text =
			'{% props page: Page %}{{ documents("pages") }}{{ page.title }}';
		const kilnTs = pathToFileURL(join(dir, "src/kiln.ts")).href;
		const fn = await definition(open(text), text.indexOf("documents"));
		expect(fn?.targetUri).toBe(kilnTs);
		const property = await definition(open(text), text.indexOf("title"));
		expect(property).toMatchObject({
			targetUri: kilnTs,
			originSelectionRange: {
				start: { character: text.indexOf("title") },
				end: { character: text.indexOf("title") + 5 },
			},
		});
	});

	test("shows a function's parameters as you type its arguments", async () => {
		const text = '{{ documents("pages", ';
		const help = await signatureHelp(open(text), text.length);
		const signature = help?.signatures[0];
		const [start, end] = (signature?.parameters?.[1]?.label ?? [0, 0]) as [
			number,
			number,
		];
		expect(help?.activeParameter).toBe(1);
		expect(signature?.label.slice(start, end)).toBe(
			"query?: { limit?: number | undefined; } | undefined",
		);
		expect(signature?.parameters?.[0]?.documentation).toMatchObject({
			value: "The collection's key.",
		});

		const named = '{{ documents("pages", limit: ';
		const fromNamed = await signatureHelp(open(named), named.length);
		expect(fromNamed?.activeParameter).toBe(1);
		expect(
			fromNamed?.signatures[0]?.parameters?.[1]?.documentation,
		).toMatchObject({
			value: "```ts\nlimit?: number | undefined\n```",
		});

		const builtin = "{{ 1.5|round(";
		const fromBuiltin = await signatureHelp(open(builtin), builtin.length);
		expect(fromBuiltin?.signatures[0]?.label).toBe(
			"|round(precision?, method?)",
		);
	});

	test("completes named arguments with their types", async () => {
		const text = '{{ documents("pages", li }}';
		const items = await complete(open(text), text.indexOf(" }}"));
		expect(items[0]).toMatchObject({
			label: "limit:",
			detail: "limit?: number | undefined",
			textEdit: { newText: "limit: " },
		});
	});

	test("warns about arguments that don't fit their parameters", async () => {
		const text = [
			"{% props page: Page, other %}",
			'{{ documents(2) }}{{ documents("pages", limit: "2") }}{{ documents("pages", limt: 2) }}',
			'{{ 2|markdown }}{{ "ok"|markdown(inline: true) }}{{ documents(other, limit: other) }}{{ 2|round }}',
			'{{ first("pages") }}{{ first("pgaes") }}',
		].join("\n");
		const warnings = await argumentWarnings(open(text));
		expect(
			warnings.map((warning) => [
				text.slice(warning.start, warning.end),
				warning.message,
			]),
		).toEqual([
			["2", "This argument should be `string`, not `2`."],
			['"2"', '`limit` should be `number`, not `"2"`.'],
			["limt", "`documents` doesn't take `limt`."],
			["2", "`markdown` needs `string` before the `|`, not `2`."],
			[
				'"pgaes"',
				'This argument should be `keyof Collections`, not `"pgaes"`.',
			],
		]);
	});
});

describe("host components", () => {
	let dir: string;
	let project: Project;
	const open = (text: string): OpenTemplate => ({
		document: TextDocument.create(
			pathToFileURL(join(dir, "src/templates/page.kiln")).href,
			"kiln",
			1,
			text,
		),
		project,
		name: "page.kiln",
	});

	beforeAll(async () => {
		dir = await createTestProject(7);
		await writeFile(
			join(dir, "kiln.json"),
			JSON.stringify({
				root: "src/templates",
				components: [
					{
						extensions: [".tsx"],
						props: "Parameters<typeof import($file).default>[0]",
					},
					{ extensions: [".vue"] },
				],
			}),
		);
		await writeFile(
			join(dir, "src/templates/Card.tsx"),
			"/** A card. */\nexport default (props: { /** Shown on top. */ title: string; count?: number }) => null;\n",
		);
		await writeFile(
			join(dir, "src/templates/Note.vue"),
			"<template></template>",
		);
		project = await openProject(join(dir, "kiln.json"), dir, (message) => {
			throw new Error(message);
		});
	});
	afterAll(async () => {
		project.close();
		await rm(dir, { recursive: true });
	});

	test("completes their names with their extensions", async () => {
		const text = '{% include "" %}';
		const items = await complete(open(text), text.indexOf('" %}'));
		expect(items.map((item) => item.label)).toEqual(
			expect.arrayContaining(["Card.tsx", "Note.vue"]),
		);
	});

	test("completes and describes their props from TypeScript", async () => {
		const text = '{% include "Card.tsx" with { } %}';
		const items = await complete(open(text), text.indexOf("} %}"));
		expect(items.map((item) => [item.label, item.detail])).toEqual([
			["title", "title: string"],
			["count", "count?: number | undefined"],
		]);
		const result = await hover(open(text), text.indexOf("Card"));
		expect(result?.contents).toMatchObject({
			value: expect.stringContaining("props title: string, count?: number"),
		});
	});

	test("completes no props without a type, and isn't checked as a template", async () => {
		const text = '{% include "Note.vue" with { } %}';
		expect(await complete(open(text), text.indexOf("} %}"))).toEqual([]);
		const checked = '{% include "Note.vue" with { any: 1 } %}';
		expect(await diagnose(project, "page.kiln", checked)).toEqual([]);
	});
});
