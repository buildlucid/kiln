import { rm } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { expressionPathAt, templateScopes } from "./scopes.js";
import { createTestProject, TYPESCRIPT_VERSIONS } from "./test-project.js";
import {
	checkArguments,
	describeCallable,
	expressionType,
	parametersType,
	withTypes,
} from "./types.js";
import { openTypeScript, type TypeScriptProject } from "./typescript.js";

/** The names of the properties TypeScript finds on the value of `expression` in `text`. */
const membersOf = (
	typescript: TypeScriptProject,
	text: string,
	expression: string,
) => {
	const scopes = templateScopes(text, () => false);
	const at = text.lastIndexOf(`{{ ${expression} }}`) + 3;
	const found = expressionPathAt(scopes.ast, at)[0];
	if (!found) throw new Error(`no {{ ${expression} }}`);
	const type = expressionType(found, {
		scopes,
		functions: ["documents", "locale"],
		filters: ["markdown"],
		macros: new Set(),
	});
	return withTypes(typescript, { Value: `Members<${type}>` }, (read) =>
		read.members("Value").map((member) => member.name),
	);
};

describe.each(Object.keys(TYPESCRIPT_VERSIONS))("TypeScript %s", (version) => {
	let dir: string;
	let typescript: TypeScriptProject;

	beforeAll(async () => {
		dir = await createTestProject(Number(version) as 6 | 7);
		const opened = await openTypeScript(dir, (message) => {
			throw new Error(message);
		});
		if (!opened) throw new Error("TypeScript didn't open");
		typescript = opened;
	});
	afterAll(async () => {
		typescript.close();
		await rm(dir, { recursive: true });
	});

	test("follows props, loops, sets, calls, filters and arrow functions", () => {
		const page = "{% props page: Page %}";
		expect(membersOf(typescript, `${page}{{ page }}`, "page")).toEqual([
			"title",
			"bricks",
		]);
		expect(
			membersOf(
				typescript,
				`${page}{% for brick in page.bricks %}{{ brick }}{% endfor %}`,
				"brick",
			),
		).toEqual(["key", "fields"]);
		expect(
			membersOf(
				typescript,
				'{% set pages = documents("pages") %}{{ pages|first }}',
				"pages|first",
			),
		).toEqual(["title", "bricks"]);
		expect(
			membersOf(
				typescript,
				'{{ documents("pages")|filter(p => p.title)|map(p => p.bricks[0])|last }}',
				'documents("pages")|filter(p => p.title)|map(p => p.bricks[0])|last',
			),
		).toEqual(["key", "fields"]);
		expect(membersOf(typescript, "{{ site }}", "site")).toEqual([
			"name",
			"url",
		]);
	});

	test("completes nothing for lists, text and unknown values", () => {
		const text = "{% props items: string[], name: string, other %}";
		expect(membersOf(typescript, `${text}{{ items }}`, "items")).toEqual([]);
		expect(membersOf(typescript, `${text}{{ name }}`, "name")).toEqual([]);
		expect(membersOf(typescript, `${text}{{ other }}`, "other")).toEqual([]);
	});

	test("describes functions and filters with their docs and source", () => {
		const documents = describeCallable(typescript, "function", "documents");
		expect(documents?.label).toBe(
			"documents(collection: string, query?: { limit?: number | undefined; } | undefined): Promise<Page[]>",
		);
		expect(documents?.member.docs).toBe(
			"Finds the published documents in a collection.",
		);
		expect(documents?.member.tags).toEqual([
			{ name: "param", text: "collection The collection's key." },
		]);
		expect(documents?.member.location?.path).toMatch(/src\/kiln\.ts$/);
		expect(describeCallable(typescript, "function", "locale")?.label).toBe(
			"locale(fallback: string): string",
		);
		expect(describeCallable(typescript, "filter", "markdown")?.label).toBe(
			"|markdown(options?: { inline?: boolean | undefined; } | undefined): string",
		);
	});

	test("checks arguments against their parameters", () => {
		const parameters = parametersType("function", "documents");
		expect(
			checkArguments(typescript, [
				{ type: "string", parameters, index: 0 },
				{ type: "number", parameters, index: 0 },
				{ type: "unknown", parameters, index: 0 },
				{ type: "number", parameters, name: "limit" },
				{ type: "string", parameters, name: "limit" },
				{ type: "number", parameters, name: "limt" },
				{
					type: "number",
					parameters: parametersType("function", "missing"),
					index: 0,
				},
			]),
		).toEqual([
			null,
			{ kind: "mismatch", expected: "string", actual: "number" },
			null,
			null,
			{ kind: "mismatch", expected: "number", actual: "string" },
			{ kind: "missing" },
			null,
		]);
	});
});
