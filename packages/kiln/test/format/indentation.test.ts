import { describe, expect, test } from "vite-plus/test";
import { format } from "../../src/format.js";

describe("format: indentation", () => {
	test("indents inside block tags and HTML elements", () => {
		expect(
			format(
				'<ul>\n{% for post in posts %}\n<li><a href="{{ post.url }}">{{ post.title }}</a></li>\n{% endfor %}\n</ul>',
			),
		).toBe(
			'<ul>\n\t{% for post in posts %}\n\t\t<li><a href="{{ post.url }}">{{ post.title }}</a></li>\n\t{% endfor %}\n</ul>',
		);
	});

	test("lines up branches with their opening tag", () => {
		expect(
			format(
				"{% if a %}\none\n{% elseif b %}\ntwo\n{% else %}\nthree\n{% endif %}",
			),
		).toBe(
			"{% if a %}\n\tone\n{% elseif b %}\n\ttwo\n{% else %}\n\tthree\n{% endif %}",
		);
	});

	test("indents a component's fills inside it", () => {
		expect(
			format(
				'{% component "card" %}\n{% fill "footer" %}\n<p>Hi</p>\n{% endfill %}\n{% endcomponent %}',
			),
		).toBe(
			'{% component "card" %}\n\t{% fill "footer" %}\n\t\t<p>Hi</p>\n\t{% endfill %}\n{% endcomponent %}',
		);
	});

	test("tags without a body don't indent", () => {
		expect(
			format(
				'{% set a = 1 %}\n{% block title "Home" %}\n{% include "nav" %}\n<p>{{ a }}</p>',
			),
		).toBe(
			'{% set a = 1 %}\n{% block title "Home" %}\n{% include "nav" %}\n<p>{{ a }}</p>',
		);
	});

	test("void elements and self-closing tags don't indent", () => {
		expect(format('<div>\n<img src="a.png">\n<br/>\n<x-icon />\n</div>')).toBe(
			'<div>\n\t<img src="a.png">\n\t<br/>\n\t<x-icon />\n</div>',
		);
	});

	test("a sibling closes an element left open", () => {
		expect(format("<ul>\n<li>One\n<li>Two\n</ul>")).toBe(
			"<ul>\n\t<li>One\n\t<li>Two\n</ul>",
		);
	});

	test("indents attributes on their own lines, and lines a lone > up with its tag", () => {
		expect(
			format(
				'<input\ntype="checkbox"\n{% if checked %}\nchecked\n{% endif %}\n>',
			),
		).toBe(
			'<input\n\ttype="checkbox"\n\t{% if checked %}\n\t\tchecked\n\t{% endif %}\n>',
		);
	});

	test("an element opened in a branch only counts until the branch ends", () => {
		const source =
			'{% if wrap %}\n<div class="wrap">\n{% else %}\n<section>\n{% endif %}\n<p>Hi</p>\n{% if wrap %}\n</div>\n{% else %}\n</section>\n{% endif %}';
		expect(format(source)).toBe(
			'{% if wrap %}\n\t<div class="wrap">\n{% else %}\n\t<section>\n{% endif %}\n<p>Hi</p>\n{% if wrap %}\n\t</div>\n{% else %}\n\t</section>\n{% endif %}',
		);
	});

	test("indents with spaces when asked", () => {
		expect(
			format("<div>\n<p>Hi</p>\n</div>", { useTabs: false, tabWidth: 2 }),
		).toBe("<div>\n  <p>Hi</p>\n</div>");
	});

	test("replaces indentation of any length", () => {
		const source = `<div>\n${" ".repeat(250)}<p>x</p>\n</div>`;
		expect(format(source)).toBe("<div>\n\t<p>x</p>\n</div>");
	});
});
