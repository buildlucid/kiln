import { describe, expect, test } from "vite-plus/test";
import { errorCode, lines, render } from "../helpers.js";

describe("apply", () => {
	test("passes the rendered body through filters", async () => {
		const template = lines(
			"{% apply upper|trim %}",
			"\thello {{ name }}",
			"{% endapply %}",
		);
		expect(await render(template, { context: { name: "ada" } })).toBe(
			"HELLO ADA",
		);
	});

	test("filters can take arguments", async () => {
		expect(
			await render('{% apply replace("a", "o") %}banana{% endapply %}'),
		).toBe("bonono");
	});

	test("does not escape the already-escaped body again", async () => {
		expect(
			await render("{% apply trim %} {{ x }} {% endapply %}", {
				context: { x: "<b>" },
			}),
		).toBe("&lt;b&gt;");
	});

	test("escapes plain text a filter inserts, and plain results", async () => {
		expect(
			await render(
				'{% apply replace("X", name) %}<b>X</b>{% endapply %}|{% apply shout %}<b>x</b>{% endapply %}',
				{
					context: { name: "<i>Ada</i>" },
					filters: { shout: (value: unknown) => `${String(value)}!` },
				},
			),
		).toBe("<b>&lt;i&gt;Ada&lt;/i&gt;</b>|&lt;b&gt;x&lt;/b&gt;!");
	});

	test("case filters leave escaped characters alone", async () => {
		expect(
			await render('{% apply upper %}{{ "<b>" }} &amp; x{% endapply %}'),
		).toBe("&lt;B&gt; &amp; X");
	});

	test("an unknown filter is an error", async () => {
		expect(await errorCode("{% apply nope %}x{% endapply %}")).toBe(
			"unknown-filter",
		);
	});
});

describe("edge cases", () => {
	test("apply and autoescape do not create a scope", async () => {
		const template =
			'{% apply upper %}{% set x = "a" %}{% endapply %}{% autoescape "js" %}{% set y = "b" %}{% endautoescape %}{{ x }}{{ y }}';
		expect(await render(template)).toBe("ab");
	});

	test("escape leaves the already-safe body alone", async () => {
		expect(await render("{% apply escape %}<b>{% endapply %}")).toBe("<b>");
	});

	test("follows autoescape, and doesn't escape when it is off", async () => {
		expect(
			await render(
				'{% autoescape "js" %}{% apply upper %}{{ "a b" }}{% endapply %}{% endautoescape %}|{% autoescape false %}{% apply replace("x", "<i>") %}x{% endapply %}{% endautoescape %}',
			),
		).toBe(String.raw`A\u0020B|<i>`);
	});

	test("the result must be printable", async () => {
		expect(await errorCode('{% apply split(",") %}a,b{% endapply %}')).toBe(
			"not-printable",
		);
	});

	test("filters can take arrows, and apply tags can nest", async () => {
		expect(
			await render(
				'{% apply split("")|map(c => c|upper)|join("-") %}ab{% endapply %}',
			),
		).toBe("A-B");
		expect(
			await render(
				"{% apply lower %}A{% apply upper %}b{% endapply %}C{% endapply %}",
			),
		).toBe("abc");
	});

	test("needs a filter", async () => {
		expect(await errorCode("{% apply %}x{% endapply %}")).toBe(
			"unexpected-token",
		);
	});
});
