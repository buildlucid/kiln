import { describe, expect, test } from "vite-plus/test";
import { errorCode, render } from "../helpers.js";

describe("escape", () => {
	test("escapes for html by default", async () => {
		expect(await render("{{ v|escape }}", { context: { v: "a b<'\"" } })).toBe(
			"a b&lt;&#39;&quot;",
		);
	});

	test("escapes for attributes, CSS and URLs", async () => {
		const template =
			'{{ v|escape("attr") }}|{{ v|escape("css") }}|{{ v|escape("url") }}';
		expect(await render(template, { context: { v: "a b<'\"" } })).toBe(
			"a&#x20;b&lt;&#x27;&quot;|a\\20 b\\3C \\27 \\22 |a%20b%3C%27%22",
		);
	});

	test("escapes for JavaScript strings", async () => {
		expect(
			await render('{{ v|escape("js") }}', { context: { v: 'a"<' } }),
		).toBe(String.raw`a\u0022\u003C`);
	});

	test("does not escape the same value twice", async () => {
		expect(await render("{{ v|escape|escape }}", { context: { v: "<" } })).toBe(
			"&lt;",
		);
	});

	test("an unknown strategy is an error", async () => {
		expect(
			await errorCode('{{ v|escape("xml") }}', { context: { v: "x" } }),
		).toBe("unknown-strategy");
	});
});

describe("edge cases", () => {
	test("escapes characters beyond ASCII for JavaScript and CSS", async () => {
		expect(await render('{{ "é😀"|escape("js") }}')).toBe(
			String.raw`\u00E9\uD83D\uDE00`,
		);
		expect(await render('{{ "é😀"|escape("css") }}')).toBe(
			String.raw`\E9 \1F600 `,
		);
	});

	test("null, numbers and booleans can be escaped", async () => {
		expect(
			await render("[{{ null|escape }}]|{{ 1|escape }}|{{ true|raw }}"),
		).toBe("[]|1|true");
	});

	test("arrays cannot be escaped", async () => {
		expect(await errorCode("{{ [1]|escape }}")).toBe("not-printable");
	});

	test("Twig's html_attr strategy is called attr", async () => {
		expect(await errorCode('{{ "x"|escape("html_attr") }}')).toBe(
			"unknown-strategy",
		);
	});
});
