import { describe, expect, test } from "vite-plus/test";
import { errorCode, lines, render } from "../helpers.js";

const base = lines(
	"<html>",
	"	<head>",
	"		<title>{{ title }}</title>",
	'		{% outlet "head" %}',
	"	</head>",
	"	<body>",
	"		{% block content %}{% endblock %}",
	"	</body>",
	"</html>",
);

const card = lines(
	"{% props title %}",
	'{% add to "head" once %}',
	'	<link rel="stylesheet" href="/card.css">',
	"{% endadd %}",
	'<article class="card">{{ title }}</article>',
	"",
);

describe("outlet", () => {
	test("holds content added after it, at its indentation", async () => {
		const page = lines(
			'{% extends "layouts/base" %}',
			'{% set title = "Home" %}',
			"{% block content %}",
			'	{% include "components/card" with { title: "One" } %}',
			'	{% include "components/card" with { title: "Two" } %}',
			"{% endblock %}",
		);
		expect(
			await render(page, {
				templates: { "layouts/base": base, "components/card": card },
			}),
		).toBe(
			lines(
				"<html>",
				"	<head>",
				"		<title>Home</title>",
				'		<link rel="stylesheet" href="/card.css">',
				"	</head>",
				"	<body>",
				'		<article class="card">One</article>',
				'		<article class="card">Two</article>',
				"	</body>",
				"</html>",
			),
		);
	});

	test("holds content added before it", async () => {
		expect(
			await render(
				'{% add to "end" %}a{% endadd %}[{% outlet "end" %}]{% add to "end" %}b{% endadd %}',
			),
		).toBe("[ab]");
	});

	test("content lines up the same whether it is added before or after the outlet", async () => {
		const add = lines('{% add to "head" %}', "<a>", "  <b>", "{% endadd %}");
		const page = lines("<head>", '	{% outlet "head" %}', "</head>");
		const expected = lines("<head>", "	<a>", "	  <b>", "</head>");
		expect(await render(lines(add, page))).toBe(expected);
		expect(await render(lines(page, add))).toBe(`${expected}\n`);
	});

	test("outputs nothing when nothing was added", async () => {
		expect(
			await render(lines("<head>", '	{% outlet "head" %}', "</head>")),
		).toBe(lines("<head>", "</head>"));
	});

	test("can share a line", async () => {
		const template = lines(
			'<head>{% outlet "head" %}</head>',
			'{% add to "head" %}',
			"	<link>",
			"{% endadd %}",
		);
		expect(await render(template)).toBe("<head><link>\n</head>\n");
	});

	test("leaves its indentation marker alone in added data", async () => {
		const add = lines(
			'{% add to "head" %}',
			"<meta content={{ v }}>",
			"{% endadd %}",
		);
		const page = lines("<head>", '	{% outlet "head" %}', "</head>");
		expect(await render(lines(page, add), { context: { v: "a\uFDD0b" } })).toBe(
			lines("<head>", "	<meta content=a\uFDD0b>", "</head>", ""),
		);
	});

	test("indents added lines that continue a line", async () => {
		// The include lines are standalone, so their line endings are removed and the second include continues the
		// first's line. Each include still starts with the outlet's indentation, as it would without an outlet.
		const add = lines(
			'{% add to "head" %}',
			'{% include "p" with { v: 1 } %}',
			'{% include "p" with { v: 2 } %}',
			"{% endadd %}",
		);
		const page = lines("<head>", '	{% outlet "head" %}', "</head>");
		expect(
			await render(lines(page, add), { templates: { p: "<{{ v }}>" } }),
		).toBe(lines("<head>", "	<1>	<2></head>", ""));
	});

	test("can only be used once per render", async () => {
		expect(await errorCode('{% outlet "a" %}{% outlet "a" %}')).toBe(
			"duplicate-outlet",
		);
	});

	test("can't be inside a capture or a cached section", async () => {
		expect(await errorCode('{% set x %}{% outlet "a" %}{% endset %}')).toBe(
			"misplaced-outlet",
		);
		expect(
			await errorCode('{% macro m() %}{% outlet "a" %}{% endmacro %}{{ m() }}'),
		).toBe("misplaced-outlet");
		expect(
			await errorCode('{% cache "k" %}{% outlet "a" %}{% endcache %}'),
		).toBe("misplaced-outlet");
	});

	test("needs a string name", async () => {
		expect(await errorCode("{% outlet head %}")).toBe("unexpected-token");
	});
});
