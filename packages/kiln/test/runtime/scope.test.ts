import { describe, expect, test } from "vite-plus/test";
import { render } from "../helpers.js";

describe("globals", () => {
	test("are visible everywhere and can be shadowed by the context", async () => {
		const options = {
			globals: { site: "S", shadow: "global" },
			context: { shadow: "context" },
		};
		expect(await render("{{ site }}|{{ shadow }}", options)).toBe("S|context");
	});

	test("are visible in includes, components and macros", async () => {
		const template =
			'{% macro m() %}{{ site }}{% endmacro %}{% include "p" %}{{ m() }}';
		expect(
			await render(template, {
				globals: { site: "S" },
				templates: { p: "{{ site }}" },
			}),
		).toBe("SS");
	});
});

describe("isolation", () => {
	test("the render context is never changed", async () => {
		const context = { list: [1], title: "T" };
		await render(
			'{% set title = "changed" %}{% set list = list|merge([2]) %}',
			{ context },
		);
		expect(context).toEqual({ list: [1], title: "T" });
	});

	test("globals are not changed between renders", async () => {
		const globals = { site: "S" };
		expect(await render("{{ site }}", { globals })).toBe("S");
		expect(globals).toEqual({ site: "S" });
	});
});

describe("blocks and includes", () => {
	test("set in one block is not visible in a sibling block", async () => {
		expect(
			await render(
				'{% block a %}{% set x = 1 %}{% endblock %}{% block b %}{{ x ?? "none" }}{% endblock %}',
			),
		).toBe("none");
	});

	test("set in an included template does not leak back", async () => {
		expect(
			await render('{% include "p" %}{{ x ?? "none" }}', {
				templates: { p: "{% set x = 1 %}" },
			}),
		).toBe("none");
	});
});
