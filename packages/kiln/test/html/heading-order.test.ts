import { describe, expect, test } from "vite-plus/test";
import { check, lines } from "../helpers.js";

const codes = async (source: string, templates?: Record<string, string>) =>
	(await check(source, { templates })).map((d) => d.code);

describe("html-heading-order", () => {
	test("reports a heading that skips a level", async () => {
		expect(await check("<h2>Posts</h2>\n<h4>Hello</h4>")).toMatchObject([
			{
				code: "html-heading-order",
				message: "<h4> skips a level after <h2>. Use <h3>",
				severity: "warning",
				start: { line: 2, column: 1 },
				end: { line: 2, column: 4 },
			},
		]);
	});

	test("lets the first heading be any level, and lets headings go back up", async () => {
		expect(
			await codes(
				"<h3>A</h3><h4>B</h4><h5>C</h5><h2>D</h2><h3>E</h3><h1>F</h1>",
			),
		).toEqual([]);
	});

	test("starts again after an include, component, slot or output that may hold headings", async () => {
		expect(
			await codes(
				lines(
					'<h1>A</h1>{% include "part" %}<h3>B</h3>',
					'<h1>C</h1>{% component "part" %}{% endcomponent %}<h3>D</h3>',
					"<h1>E</h1>{% slot %}{% endslot %}<h3>F</h3>",
					"<h1>G</h1>{{ body|raw }}<h3>H</h3>",
				),
				{ part: "{% slot %}{% endslot %}" },
			),
		).toEqual([]);
	});

	test("keeps going past an output that can't hold headings", async () => {
		expect(
			await codes(
				"<h2>A {{ title }}</h2><p>{{ summary }}</p><span>{{ x }}</span><h4>B</h4>",
			),
		).toEqual(["html-heading-order"]);
	});

	test("follows branches that agree, and starts again after ones that don't", async () => {
		expect(
			await codes(
				"<h1>A</h1>{% if x %}<h2>B</h2>{% else %}<h2>C</h2>{% endif %}<h4>D</h4>",
			),
		).toEqual(["html-heading-order"]);
		expect(
			await codes(
				"<h1>A</h1>{% if x %}<h2>B</h2>{% endif %}<h3>C</h3>{% for p in ps %}<h4>D</h4>{% endfor %}<h6>E</h6>",
			),
		).toEqual([]);
	});

	test("checks a macro's headings on their own", async () => {
		expect(
			await codes(
				"<h1>A</h1>{% macro card() %}<h3>B</h3>{% endmacro %}<h2>C</h2>",
			),
		).toEqual([]);
	});
});
