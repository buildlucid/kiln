import { describe, expect, test } from "vite-plus/test";
import { errorCode, lines, render } from "../helpers.js";

describe("standalone lines", () => {
	test("a line holding only a tag is removed", async () => {
		const template = lines(
			"<ul>",
			"\t{% for item in items %}",
			"\t<li>{{ item }}</li>",
			"\t{% endfor %}",
			"</ul>",
		);
		expect(await render(template, { context: { items: ["a", "b"] } })).toBe(
			lines("<ul>", "\t<li>a</li>", "\t<li>b</li>", "</ul>"),
		);
	});

	test("several tags and comments on one line are removed together", async () => {
		const template = lines(
			"a",
			"  {% if true %}{% set x = 1 %}  {# note #}",
			"b",
			"{% endif %}",
			"c",
		);
		expect(await render(template)).toBe(lines("a", "b", "c"));
	});

	test("a line holding only a comment is removed", async () => {
		expect(await render(lines("a", "{# note #}", "b"))).toBe(lines("a", "b"));
	});

	test("a tag sharing its line with text is kept", async () => {
		expect(await render(lines("a {% if true %}yes{% endif %}", "b"))).toBe(
			lines("a yes", "b"),
		);
	});

	test("output tags never make a line standalone", async () => {
		expect(await render(lines("a", '{{ "" }}', "b"))).toBe(lines("a", "", "b"));
	});

	test("works at the start and end of the template", async () => {
		const template = lines("{% set x = 1 %}", "x={{ x }}", "{% set y = 2 %}");
		expect(await render(template)).toBe("x=1\n");
	});

	test("works with Windows line endings", async () => {
		expect(await render("a\r\n{% if true %}\r\nb\r\n{% endif %}\r\nc")).toBe(
			"a\r\nb\r\nc",
		);
	});
});

describe("indentation inside tags", () => {
	test("the extra indentation inside a tag on its own line is removed", async () => {
		const template = lines(
			"<ul>",
			"\t{% for item in items %}",
			"\t\t<li>{{ item }}</li>",
			"\t{% endfor %}",
			"</ul>",
		);
		expect(await render(template, { context: { items: ["a", "b"] } })).toBe(
			lines("<ul>", "\t<li>a</li>", "\t<li>b</li>", "</ul>"),
		);
	});

	test("nested tags each remove their own step", async () => {
		const template = lines(
			"<ul>",
			"\t{% for item in items %}",
			"\t\t{% if item %}",
			"\t\t\t<li>",
			"\t\t\t\t{{ item }}",
			"\t\t\t</li>",
			"\t\t{% endif %}",
			"\t{% endfor %}",
			"</ul>",
		);
		expect(await render(template, { context: { items: ["a"] } })).toBe(
			lines("<ul>", "\t<li>", "\t\ta", "\t</li>", "</ul>"),
		);
	});

	test("branches share their tag's indentation", async () => {
		const template = lines(
			"{% if flag %}",
			"  <b>yes</b>",
			"{% else %}",
			"  <i>no</i>",
			"{% endif %}",
		);
		expect(await render(template, { context: { flag: false } })).toBe(
			"<i>no</i>\n",
		);
	});

	test("works in components, fills and captures", async () => {
		const template = lines(
			'{% component "card" %}',
			"\tBody",
			'\t{% fill "footer" %}',
			"\t\tFooter",
			"\t{% endfill %}",
			"{% endcomponent %}",
			"{% set note %}",
			"\tNote",
			"{% endset %}",
			"{{ note }}",
		);
		const templates = {
			card: lines(
				"{% slot %}{% endslot %}",
				'{% slot "footer" %}{% endslot %}',
			),
		};
		expect(await render(template, { templates })).toBe(
			lines("Body", "Footer", "Note", ""),
		);
	});

	test("lines that start with an output or share a line with a comment count", async () => {
		const template = lines(
			"{% if true %}",
			"\t\t{{ 'a' }}",
			"\t\t{# note #}b",
			"\t\t{{ 'c'",
			"~ 'd' }}",
			"{% endif %}",
		);
		expect(await render(template)).toBe(lines("a", "b", "cd", ""));
	});

	test("blank lines don't count", async () => {
		const template = lines("{% if true %}", "\ta", "", "\tb", "{% endif %}");
		expect(await render(template)).toBe(lines("a", "", "b", ""));
	});

	test("nothing is removed when a line is indented less", async () => {
		const template = lines(
			"{% if true %}",
			"\t<pre>",
			"x",
			"\t</pre>",
			"{% endif %}",
		);
		expect(await render(template)).toBe(lines("\t<pre>", "x", "\t</pre>", ""));
		const output = lines("{% if true %}", "\t\ta", "{{ 'b' }}", "{% endif %}");
		expect(await render(output)).toBe(lines("\t\ta", "b", ""));
	});

	test("nothing is removed when tabs and spaces are mixed", async () => {
		const template = lines("{% if true %}", "\ta", "  b", "{% endif %}");
		expect(await render(template)).toBe(lines("\ta", "  b", ""));
	});

	test("nothing is removed when the tag shares its line", async () => {
		const template = lines(
			"<ul>{% if true %}",
			"\t\t<li></li>",
			"{% endif %}</ul>",
		);
		expect(await render(template)).toBe(
			lines("<ul>", "\t\t<li></li>", "</ul>"),
		);
	});

	test("values and included templates keep their whitespace", async () => {
		const template = lines(
			"{% if true %}",
			"\t\t{{ value }}",
			'\t\t{% include "part" %}',
			"{% endif %}",
		);
		expect(
			await render(template, {
				context: { value: "x\n\t\ty" },
				templates: { part: "\t\tz" },
			}),
		).toBe(lines("x", "\t\ty", "\t\tz"));
	});

	test("works with Windows line endings", async () => {
		expect(await render("{% if true %}\r\n\ta\r\n\tb\r\n{% endif %}\r\n")).toBe(
			"a\r\nb\r\n",
		);
	});
});

describe("trim markers", () => {
	test("remove whitespace on their side of output", async () => {
		expect(
			await render("<a>  {{- label -}}  </a>", { context: { label: "Label" } }),
		).toBe("<a>Label</a>");
	});

	test("remove newlines around tags", async () => {
		const template = lines("a", "{%- if true -%}", "   b", "{%- endif %}");
		expect(await render(template)).toBe("ab");
	});

	test("work on comments", async () => {
		expect(await render("a   {#- note -#}   b")).toBe("ab");
	});

	test("only trim the side they are on", async () => {
		expect(await render("a  {{- 'x' }}  b")).toBe("ax  b");
	});
});

describe("unsupported whitespace syntax", () => {
	test("Twig's ~ trim modifier is not Kiln syntax", async () => {
		expect(await errorCode("{%~ if true %}{% endif %}")).toBe(
			"unexpected-token",
		);
	});

	test("trailing Windows line endings are kept", async () => {
		expect(await render("a\r\n{% if true %}\r\nb\r\n{% endif %}\r\n")).toBe(
			"a\r\nb\r\n",
		);
	});
});
