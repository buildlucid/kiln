import { describe, expect, test } from "vite-plus/test";
import { errorCode, render } from "../helpers.js";

describe("autoescape", () => {
	test("switches the escaping strategy for its body", async () => {
		const template = '{% autoescape "url" %}{{ q }}{% endautoescape %}|{{ q }}';
		expect(await render(template, { context: { q: "a b&c" } })).toBe(
			"a%20b%26c|a b&amp;c",
		);
	});

	test("false turns escaping off", async () => {
		const template = "{% autoescape false %}{{ html }}{% endautoescape %}";
		expect(await render(template, { context: { html: "<i>x</i>" } })).toBe(
			"<i>x</i>",
		);
	});

	test("with no argument uses html", async () => {
		const template =
			"{% autoescape false %}{% autoescape %}{{ x }}{% endautoescape %}{% endautoescape %}";
		expect(await render(template, { context: { x: "<" } })).toBe("&lt;");
	});

	test("an unknown strategy is an error", async () => {
		expect(await errorCode('{% autoescape "xml" %}{% endautoescape %}')).toBe(
			"unknown-strategy",
		);
	});
});

describe("strategies", () => {
	test("attr and url can be used as tag arguments", async () => {
		expect(
			await render('{% autoescape "attr" %}{{ "a b" }}{% endautoescape %}'),
		).toBe("a&#x20;b");
		expect(
			await render('{% autoescape "url" %}{{ "a b/é" }}{% endautoescape %}'),
		).toBe("a%20b%2F%C3%A9");
	});

	test("html markup is escaped again for another strategy", async () => {
		expect(
			await render(
				'{% autoescape "attr" %}{{ "<"|escape }}{% endautoescape %}',
			),
		).toBe("&amp;lt&#x3B;");
	});

	test("text in the template is never escaped", async () => {
		expect(await render('{% autoescape "js" %}<"x">{% endautoescape %}')).toBe(
			'<"x">',
		);
	});

	test("only a string or false is accepted", async () => {
		expect(
			await errorCode("{% autoescape true %}{% endautoescape %}"),
		).not.toBe("");
	});
});
