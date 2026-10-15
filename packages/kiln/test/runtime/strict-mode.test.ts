import { describe, expect, test } from "vite-plus/test";
import { errorCode, render } from "../helpers.js";

describe("strict mode", () => {
	test("is on by default: unknown variables are errors", async () => {
		expect(await errorCode("{{ titel }}", { context: { title: "x" } })).toBe(
			"undefined-variable",
		);
	});

	test("guards never raise missing errors", async () => {
		const template =
			'{{ a.b.c ?? "x" }}|{{ a?.b }}|{{ a.b|default("y") }}|{{ a.b is defined ? "d" : "u" }}';
		expect(await render(template)).toBe("x||y|u");
	});
});

describe("lenient mode", () => {
	test("prints null for missing variables and properties", async () => {
		const template = "[{{ missing }}][{{ obj.missing }}][{{ none.deep }}]";
		expect(
			await render(template, {
				strict: false,
				context: { obj: {}, none: null },
			}),
		).toBe("[][][]");
	});

	test("still reports type errors", async () => {
		expect(await errorCode('{{ "a" + 1 }}', { strict: false })).toBe(
			"type-error",
		);
	});

	test("still reports unknown filters", async () => {
		expect(await errorCode("{{ 1|nope }}", { strict: false })).toBe(
			"unknown-filter",
		);
	});
});

describe("names that exist on Object.prototype", () => {
	test("are never found as variables", async () => {
		expect(
			await render('{{ constructor ?? "none" }}|{{ toString ?? "none" }}'),
		).toBe("none|none");
		expect(await errorCode("{{ hasOwnProperty }}")).toBe("undefined-variable");
	});
});

describe("lenient mode edge cases", () => {
	test("still rejects unknown functions", async () => {
		expect(await errorCode("{{ nope() }}", { strict: false })).toBe(
			"unknown-function",
		);
	});

	test("loops over a missing variable render else", async () => {
		expect(
			await render("{% for x in missing %}{% else %}e{% endfor %}", {
				strict: false,
			}),
		).toBe("e");
	});
});
