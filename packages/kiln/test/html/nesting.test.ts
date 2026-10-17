import { describe, expect, test } from "vite-plus/test";
import { check, lines } from "../helpers.js";

const codes = async (source: string, templates?: Record<string, string>) =>
	(await check(source, { templates })).map((d) => d.code);

describe("what nesting checks can see", () => {
	test("don't know the parent of a template's top-level content", async () => {
		expect(await codes("<li>A</li><td>B</td><summary>C</summary>")).toEqual([]);
	});

	test("don't know the parent of content that renders somewhere else", async () => {
		expect(
			await codes(
				lines(
					"<ul>",
					"{% macro item() %}<li>A</li>{% endmacro %}",
					"{% set row %}<tr><td>B</td></tr>{% endset %}",
					'{% component "card" %}<li>C</li>{% fill "footer" %}<td>D</td>{% endfill %}{% endcomponent %}',
					"{% apply upper %}<li>E</li>{% endapply %}",
					"</ul>",
				),
				{ card: "{% slot %}{% endslot %}{% slot footer %}{% endslot %}" },
			),
		).toEqual([]);
	});

	test("don't know the parent of a page's blocks, but know a layout's", async () => {
		const templates = { base: "{% block content %}{% endblock %}" };
		expect(
			await codes(
				'{% extends "base" %}{% block content %}<li>A</li>{% endblock %}',
				templates,
			),
		).toEqual([]);
		expect(
			await codes("<span>{% block content %}<div>A</div>{% endblock %}</span>"),
		).toEqual(["html-permitted-content"]);
	});

	test("follow if branches and loops that open and close the same elements", async () => {
		expect(
			await codes(
				"<span>{% if a %}<b>A</b>{% else %}<i>B</i>{% endif %}{% for x in xs %}<em>{{ x }}</em>{% endfor %}<div>C</div></span>",
			),
		).toEqual(["html-permitted-content"]);
	});

	test("stop knowing what is open after branches that disagree, until those elements close", async () => {
		const source =
			"<div>{% if a %}<span>{% endif %}<li>A</li></div><div><li>B</li></div>";
		// Only the second <li>: after the if, Kiln doesn't know whether a <span> is open.
		expect(await check(source)).toMatchObject([
			{
				code: "html-permitted-content",
				start: { column: source.indexOf("<li>B") + 1 },
			},
		]);
	});

	test("ignore Kiln syntax inside a tag's attributes", async () => {
		expect(
			await codes(
				'<details class="{{ c }}"{% if open %} open{% endif %}><summary>A</summary></details>',
			),
		).toEqual([]);
	});
});
