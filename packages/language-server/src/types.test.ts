import { rm } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { expressionPathAt, templateScopes } from "./scopes.js";
import { createTestProject, TYPESCRIPT_VERSIONS } from "./test-project.js";
import {
	checkArguments,
	describeCallable,
	parametersType,
	typeWriter,
	withTypes,
} from "./types.js";
import { openTypeScript, type TypeScriptProject } from "./typescript.js";

/** Reads what TypeScript makes of the value of `{{ expression }}` in `text`, as the alias `Value`. */
const readValue = <T>(
	typescript: TypeScriptProject,
	text: string,
	expression: string,
	type: (value: string) => string,
	use: Parameters<typeof withTypes<T>>[2],
) => {
	const scopes = templateScopes(text, () => false);
	const at = text.lastIndexOf(`{{ ${expression} }}`) + 3;
	const found = expressionPathAt(scopes.ast, at)[0];
	if (!found) throw new Error(`no {{ ${expression} }}`);
	const types = typeWriter({
		scopes,
		functions: ["documents", "locale", "first", "latest"],
		filters: ["markdown", "pick"],
		macros: new Set(),
	});
	const value = types.expression(found);
	return withTypes(typescript, { Value: type(value) }, use, types.statements);
};

/** The names of the properties TypeScript finds on the value of `expression` in `text`. */
const membersOf = (
	typescript: TypeScriptProject,
	text: string,
	expression: string,
) =>
	readValue(
		typescript,
		text,
		expression,
		(value) => `Members<${value}>`,
		(read) => read.members("Value").map((member) => member.name),
	);

/** The type TypeScript gives the value of `expression` in `text`. */
const typeOf = (
	typescript: TypeScriptProject,
	text: string,
	expression: string,
) =>
	readValue(
		typescript,
		text,
		expression,
		(value) => value,
		(read) => read.describe("Value"),
	);

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

	test("works out a generic function's result from its arguments", () => {
		expect(
			membersOf(typescript, '{{ first("pages") }}', 'first("pages")'),
		).toEqual(["title", "bricks"]);
		expect(
			membersOf(
				typescript,
				'{% set brick = latest("bricks")|first %}{{ brick }}',
				"brick",
			),
		).toEqual(["key", "fields"]);
		expect(
			membersOf(
				typescript,
				'{% props page: Page %}{{ page|pick("bricks")|last }}',
				'page|pick("bricks")|last',
			),
		).toEqual(["key", "fields"]);
		expect(
			typeOf(
				typescript,
				'{{ documents("pages", limit: 2) }}',
				'documents("pages", limit: 2)',
			),
		).toBe("Page[]");
	});

	test("gives a literal its exact value as its type", () => {
		const text =
			'{% set title = "Home" %}{% set count = 2 %}{% set big = true %}';
		expect(typeOf(typescript, `${text}{{ title }}`, "title")).toBe('"Home"');
		expect(typeOf(typescript, `${text}{{ count }}`, "count")).toBe("2");
		expect(typeOf(typescript, `${text}{{ big }}`, "big")).toBe("true");
		expect(typeOf(typescript, "{{ [1, 2]|first }}", "[1, 2]|first")).toBe(
			"1 | 2",
		);
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
