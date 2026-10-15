import { describe, expect, test } from "vite-plus/test";
import { render } from "../helpers.js";

const explode = () => {
	throw new Error("should not be called");
};

describe("and, or and not", () => {
	test("return booleans", async () => {
		expect(
			await render('{{ 1 and "x" }}|{{ 0 or "" }}|{{ not 0 }}|{{ not [] }}'),
		).toBe("true|false|true|true");
	});

	test("short-circuit", async () => {
		const template = "{{ false and explode() }}|{{ true or explode() }}";
		expect(await render(template, { functions: { explode } })).toBe(
			"false|true",
		);
	});

	test("not binds looser than comparison", async () => {
		expect(await render("{{ not 1 == 2 }}")).toBe("true");
	});

	test("and binds tighter than or", async () => {
		expect(await render("{{ true or false and false }}")).toBe("true");
	});
});

describe("null coalescing", () => {
	test("falls back for null and missing values only", async () => {
		const template =
			'{{ missing ?? "a" }}|{{ value ?? "b" }}|{{ zero ?? "c" }}|{{ empty ?? "d" }}';
		expect(
			await render(template, { context: { value: null, zero: 0, empty: "" } }),
		).toBe("a|b|0|");
	});

	test("guards a whole property chain", async () => {
		expect(
			await render('{{ obj.missing.deep ?? "deep" }}', {
				context: { obj: {} },
			}),
		).toBe("deep");
	});

	test("does not evaluate the fallback when it is not needed", async () => {
		expect(
			await render('{{ "set" ?? explode() }}', { functions: { explode } }),
		).toBe("set");
	});

	test("is right associative", async () => {
		expect(await render('{{ a ?? b ?? "c" }}')).toBe("c");
	});
});

describe("elvis", () => {
	test("returns the left side when it is truthy", async () => {
		expect(await render('{{ "" ?: "empty" }}|{{ "set" ?: "empty" }}')).toBe(
			"empty|set",
		);
	});
});

describe("ternary", () => {
	test("chooses a branch", async () => {
		const template = '{{ yes ? "a" : "b" }}|{{ no ? "a" : "b" }}';
		expect(await render(template, { context: { yes: true, no: false } })).toBe(
			"a|b",
		);
	});

	test("without an else branch gives null", async () => {
		expect(await render('[{{ false ? "a" }}]')).toBe("[]");
	});

	test("is right associative", async () => {
		const template = '{{ n == 1 ? "one" : n == 2 ? "two" : "many" }}';
		expect(await render(template, { context: { n: 2 } })).toBe("two");
	});

	test("only evaluates the chosen branch", async () => {
		expect(
			await render('{{ true ? "a" : explode() }}', { functions: { explode } }),
		).toBe("a");
	});
});

describe("precedence", () => {
	test("not binds looser than arithmetic", async () => {
		expect(await render("{{ not 1 * 2 }}")).toBe("false");
	});

	test("?? binds looser than or", async () => {
		expect(
			await render(
				"{{ missing ?? false or true }}|{{ zero ?? false or true }}",
				{ context: { zero: 0 } },
			),
		).toBe("true|0");
	});

	test("?: and ?? mix right to left", async () => {
		expect(
			await render('{{ false ?: "a" ?? "b" }}|{{ null ?: false ?: "c" }}'),
		).toBe("a|c");
	});

	test("is binds looser than +, and not wraps a guarded test", async () => {
		expect(
			await render("{{ 1 + 1 is even }}|{{ not missing is defined }}"),
		).toBe("true|true");
	});

	test("short-circuits avoid strict errors", async () => {
		expect(
			await render("{{ false and nope }}|{{ page is defined and page.title }}"),
		).toBe("false|false");
	});
});
