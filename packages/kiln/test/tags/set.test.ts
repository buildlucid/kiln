import { describe, expect, test } from "vite-plus/test";
import { errorCode, render } from "../helpers.js";

describe("set", () => {
	test("assigns an expression", async () => {
		expect(await render('{% set title = "Home" %}{{ title }}')).toBe("Home");
	});

	test("can reassign a variable", async () => {
		expect(await render("{% set n = 1 %}{% set n = n + 1 %}{{ n }}")).toBe("2");
	});

	test("the block form captures output as safe markup", async () => {
		const template =
			'{% set title = "A & B" %}{% set html %}<b>{{ title }}</b>{% endset %}{{ html }}';
		expect(await render(template)).toBe("<b>A &amp; B</b>");
	});

	test("the block form can be empty", async () => {
		expect(await render("{% set empty %}{% endset %}[{{ empty }}]")).toBe("[]");
	});

	test("shadows a context variable without changing the caller's data", async () => {
		const page = { title: "Old" };
		expect(
			await render('{% set page = { title: "New" } %}{{ page.title }}', {
				context: { page },
			}),
		).toBe("New");
		expect(page.title).toBe("Old");
	});

	test("cannot assign to a global", async () => {
		expect(
			await errorCode('{% set site = "x" %}', { globals: { site: "Example" } }),
		).toBe("assign-global");
	});

	test("cannot use a reserved name", async () => {
		expect(await errorCode("{% set slots = 1 %}")).toBe("reserved-name");
	});

	test("the block form must be closed", async () => {
		expect(await errorCode("{% set x %}text")).toBe("unclosed-block");
	});
});

describe("captures", () => {
	test("can read the variable's old value", async () => {
		expect(
			await render("{% set foo %}[{{ foo }}]{% endset %}{{ foo }}", {
				context: { foo: "x" },
			}),
		).toBe("[x]");
	});

	test("do not create a scope", async () => {
		expect(
			await render(
				'{% set foo = "a" %}{% set cap %}{% set foo = "b" %}{% endset %}{{ foo }}',
			),
		).toBe("b");
	});
});

describe("unsupported forms", () => {
	test("multiple targets, member targets and missing values are errors", async () => {
		expect(await errorCode("{% set a, b = 1, 2 %}")).toBe("unexpected-token");
		expect(await errorCode("{% set h.a = 1 %}")).toBe("unexpected-token");
		expect(await errorCode("{% set x = %}")).toBe("unexpected-token");
	});
});
