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
