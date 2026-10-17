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
		const template = lines("{% if true %}", "\ta", "b", "{% endif %}");
		expect(await render(template)).toBe(lines("\ta", "b", ""));
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

describe("indentation of inserted content", () => {
	test("nested insertions add up", async () => {
		const templates = {
			page: lines(
				"<main>",
				'\t{% component "card" %}',
				"\t\t<p>Body</p>",
				"\t{% endcomponent %}",
				"</main>",
				"",
			),
			card: lines("<article>", "\t{% slot %}{% endslot %}", "</article>", ""),
		};
		expect(
			await render(lines("<body>", '\t{% include "page" %}', "</body>"), {
				templates,
			}),
		).toBe(
			lines(
				"<body>",
				"\t<main>",
				"\t\t<article>",
				"\t\t\t<p>Body</p>",
				"\t\t</article>",
				"\t</main>",
				"</body>",
			),
		);
	});

	test("a tag that shares its line indents no further", async () => {
		const templates = {
			icon: lines("<svg>", "\t<path/>", "</svg>"),
			button: lines('<button>{% include "icon" %}</button>', ""),
		};
		expect(
			await render(lines("<nav>", '\t{% include "button" %}', "</nav>"), {
				templates,
			}),
		).toBe(
			lines(
				"<nav>",
				"\t<button><svg>",
				"\t\t<path/>",
				"\t</svg></button>",
				"</nav>",
			),
		);
	});

	test("lines that start with an output or a tag are indented too", async () => {
		const part = lines("{{ a }}", "{% if true %}{{ b }}{% endif %}", "");
		expect(
			await render(
				lines(
					"<div>",
					'\t{% include "part" with { a: "x", b: "y" } %}',
					"</div>",
				),
				{ templates: { part } },
			),
		).toBe(lines("<div>", "\tx", "\ty", "</div>"));
	});

	test("values keep their own whitespace", async () => {
		const part = lines(
			"{% macro pair() %}",
			"<b>1</b>",
			"<b>2</b>",
			"{% endmacro %}",
			"{% set captured %}",
			"<i>1</i>",
			"<i>2</i>",
			"{% endset %}",
			"{{ value }}",
			"{{ pair() }}",
			"{{ captured }}",
			"",
		);
		expect(
			await render(
				lines(
					"<div>",
					'\t{% include "part" with { value: "a\\nb" } %}',
					"</div>",
				),
				{ templates: { part } },
			),
		).toBe(
			lines(
				"<div>",
				"\ta",
				"b",
				"\t<b>1</b>",
				"<b>2</b>",
				"",
				"\t<i>1</i>",
				"<i>2</i>",
				"",
				"</div>",
			),
		);
	});

	test("empty content leaves no indentation behind", async () => {
		const card = lines("<article>", "\t{% slot %}{% endslot %}", "</article>");
		expect(
			await render('{% component "card" %}{% endcomponent %}', {
				templates: { card },
			}),
		).toBe(lines("<article>", "</article>"));
	});

	test("lines inside pre and textarea keep their whitespace", async () => {
		const part = lines(
			"<pre>",
			"\tcode",
			"</pre>",
			"<textarea>",
			"text",
			"</textarea>",
			"<p>after</p>",
			"",
		);
		const template = lines(
			"<div>",
			"\t{% if true %}",
			"\t\t<pre>",
			"\t\tkept",
			"\t\t</pre>",
			'\t\t{% include "part" %}',
			"\t{% endif %}",
			"</div>",
		);
		expect(await render(template, { templates: { part } })).toBe(
			lines(
				"<div>",
				"\t<pre>",
				"\t\tkept",
				"\t\t</pre>",
				"\t<pre>",
				"\tcode",
				"</pre>",
				"\t<textarea>",
				"text",
				"</textarea>",
				"\t<p>after</p>",
				"</div>",
			),
		);
	});

	test("content inserted inside pre and textarea is not indented", async () => {
		const code = lines("a", "\tb", "");
		const template = lines("<pre>", '\t{% include "code" %}', "</pre>");
		expect(await render(template, { templates: { code } })).toBe(
			lines("<pre>", "a", "\tb", "</pre>"),
		);
	});

	test("pre and textarea in HTML comments and scripts are not elements", async () => {
		const template = lines(
			"{% if true %}",
			"\t<!-- <pre> -->",
			'\t<script>el.innerHTML = "<textarea>";</script>',
			"\t<p>a</p>",
			"{% endif %}",
		);
		expect(await render(template)).toBe(
			lines(
				"<!-- <pre> -->",
				'<script>el.innerHTML = "<textarea>";</script>',
				"<p>a</p>",
				"",
			),
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
