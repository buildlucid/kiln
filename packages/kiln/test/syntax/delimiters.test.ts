import { describe, expect, test } from "vite-plus/test";
import { errorCode, lines, render } from "../helpers.js";

describe("text", () => {
	test("passes through unchanged", async () => {
		expect(await render('<p class="a">Hello { world } %}</p>')).toBe(
			'<p class="a">Hello { world } %}</p>',
		);
	});

	test("is never escaped", async () => {
		expect(await render("<b>&amp;</b>")).toBe("<b>&amp;</b>");
	});

	test("an empty template renders nothing", async () => {
		expect(await render("")).toBe("");
	});
});

describe("output", () => {
	test("prints an expression", async () => {
		expect(await render("{{ 1 + 2 }}")).toBe("3");
	});

	test("can hold a hash literal directly", async () => {
		expect(await render("{{ {a: {b: 1}}.a.b }}")).toBe("1");
	});

	test("must be closed", async () => {
		expect(await errorCode(lines("{{ name", "<p>{{ other }}</p>"))).toBe(
			"unclosed-tag",
		);
	});

	test("must not be empty", async () => {
		expect(await errorCode("{{ }}")).toBe("unexpected-token");
	});
});

describe("comments", () => {
	test("produce nothing", async () => {
		expect(await render("a{# a comment #}b")).toBe("ab");
	});

	test("may span lines", async () => {
		expect(await render(lines("a{# one", "two #}b"))).toBe("ab");
	});

	test("may contain delimiters", async () => {
		expect(await render("a{# {{ x }} {% if %} #}b")).toBe("ab");
	});

	test("must be closed", async () => {
		expect(await errorCode("a {# never closed")).toBe("unclosed-comment");
	});
});

describe("tags", () => {
	test("must be closed", async () => {
		expect(await errorCode("{% if true ")).toBe("unclosed-tag");
	});

	test("unknown tags are errors", async () => {
		expect(await errorCode("{% sandbox %}{% endsandbox %}")).toBe(
			"unknown-tag",
		);
	});

	test("an end tag without its opening tag is an error", async () => {
		expect(await errorCode("{% endif %}")).toBe("unexpected-tag");
	});

	test("unexpected characters are errors", async () => {
		expect(await errorCode("{{ a @ b }}")).toBe("unexpected-character");
	});
});

describe("delimiters in text and strings", () => {
	test("a text node holding only 0 is kept", async () => {
		expect(await render("{{ a }}0{{ a }}", { context: { a: "x" } })).toBe(
			"x0x",
		);
	});

	test("delimiters inside strings are plain text", async () => {
		expect(
			await render('{{ "}}" ~ "{%" ~ "#}" }}{% set s = "%}" %}{{ s }}'),
		).toBe("}}{%#}%}");
	});

	test("comments end at the first #} and do not nest", async () => {
		expect(await render('a{# x {# "#}" b #}')).toBe('a" b #}');
	});

	test("a brace next to a delimiter is read correctly", async () => {
		expect(await render('{{{a: 1}.a }}|{{ "a" }}}')).toBe("1|a}");
	});

	test("text that looks like a JavaScript template literal is copied unchanged", async () => {
		// Built from parts so neither TypeScript nor the linter reads it as a template literal.
		const text = ["$" + "{a}", "`b`", "\\u{41}"].join(" ");
		expect(await render(text)).toBe(text);
	});
});

describe("malformed tags", () => {
	test("unbalanced brackets are errors", async () => {
		expect(await errorCode("{{ (1 + 3 }}")).toBe("unexpected-token");
		expect(await errorCode("{{ 1 + 3) }}")).toBe("unexpected-token");
	});

	test("a tag needs a name", async () => {
		expect(await errorCode("{% %}")).toBe("unexpected-token");
		expect(await errorCode("{% 5 %}")).toBe("unexpected-token");
	});

	test("an end tag cannot repeat a name it does not have", async () => {
		expect(await errorCode("{% if true %}{% endif x %}")).toBe(
			"unexpected-token",
		);
	});
});
