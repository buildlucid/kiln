import { describe, expect, test } from "vite-plus/test";
import { render } from "../helpers.js";

describe("autoescaping", () => {
	test("escapes output for html by default", async () => {
		expect(
			await render("{{ text }}", { context: { text: `<a href='x'>&"</a>` } }),
		).toBe("&lt;a href=&#39;x&#39;&gt;&amp;&quot;&lt;/a&gt;");
	});

	test("can be turned off for the environment", async () => {
		expect(
			await render("{{ html }}", {
				autoescape: false,
				context: { html: "<b>" },
			}),
		).toBe("<b>");
	});

	test("can use another strategy for the environment", async () => {
		expect(
			await render("{{ q }}", { autoescape: "url", context: { q: "a b" } }),
		).toBe("a%20b");
	});
});

describe("safe markup", () => {
	test("markup for another strategy is escaped again", async () => {
		const template =
			'{% autoescape "url" %}{{ v|escape("html") }}{% endautoescape %}';
		expect(await render(template, { context: { v: "<" } })).toBe("%26lt%3B");
	});

	test("html output accepts markup of any strategy", async () => {
		expect(
			await render('{{ v|escape("url") }}', { context: { v: "a b" } }),
		).toBe("a%20b");
	});

	test("captured output, macros and includes are safe", async () => {
		const template =
			'{% set c %}<b>{% endset %}{% macro m() %}<i>{% endmacro %}{{ c }}{{ m() }}{% include "p" %}';
		expect(await render(template, { templates: { p: "<u>" } })).toBe(
			"<b><i><u>",
		);
	});

	test("~ with markup is not safe", async () => {
		expect(await render('{% set b %}<b>{% endset %}{{ b ~ "" }}')).toBe(
			"&lt;b&gt;",
		);
	});
});
