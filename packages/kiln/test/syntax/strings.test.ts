import { describe, expect, test } from "vite-plus/test";
import { errorCode, errorCodes, render, renderError } from "../helpers.js";

describe("strings", () => {
	test("can use single or double quotes", async () => {
		expect(await render(`{{ 'single' }} {{ "double" }}`)).toBe("single double");
	});

	test("support escapes", async () => {
		const template = String.raw`{{ "tab\there|line\nnext|\u{263A}|\\|\"|\'" }}`;
		expect(await render(template, { autoescape: false })).toBe(
			"tab\there|line\nnext|☺|\\|\"|'",
		);
	});

	test("unknown escapes are errors", async () => {
		expect(await errorCode(String.raw`{{ "\q" }}`)).toBe("invalid-escape");
	});

	test("must be closed", async () => {
		expect(await errorCodes('{{ "abc }}')).toContain("unclosed-string");
	});
});

describe("interpolation", () => {
	test("inserts expressions into double-quoted strings", async () => {
		const template =
			'{{ "Hello #{ name|upper }, you have #{ count + 1 } messages" }}';
		expect(await render(template, { context: { name: "ada", count: 2 } })).toBe(
			"Hello ADA, you have 3 messages",
		);
	});

	test("can contain hashes and strings", async () => {
		expect(await render(`{{ "#{ {a: "x"}.a }-#{ 'y' }" }}`)).toBe("x-y");
	});

	test("does not happen in single-quoted strings", async () => {
		expect(await render("{{ '#{ name }' }}")).toBe("#{ name }");
	});

	test("can be escaped with a backslash", async () => {
		expect(await render(String.raw`{{ "\#{ name }" }}`)).toBe("#{ name }");
	});

	test("a backslash-hash is only an escape before an interpolation", async () => {
		expect(await errorCode(String.raw`{{ '\#' }}`)).toBe("invalid-escape");
	});

	test("must be closed", async () => {
		expect(await errorCodes('{{ "#{ name" }}')).toContain(
			"unclosed-interpolation",
		);
	});

	test("cannot be used where a tag needs a plain string", async () => {
		const error = await renderError('{% import "macros/#{ name }" as m %}');
		expect(error.message).toContain(
			"Expected a template name as a string but found an interpolated string",
		);
	});

	test("cannot insert an array", async () => {
		expect(await errorCode('{{ "#{ [1] }" }}')).toBe("not-printable");
	});
});

describe("escape sequences", () => {
	test("a backslash-u escape needs braces and a valid code point", async () => {
		expect(await errorCode(String.raw`{{ "\u0041" }}`)).toBe("invalid-escape");
		expect(await errorCode(String.raw`{{ "\u{110000}" }}`)).toBe(
			"invalid-escape",
		);
	});

	test("# without a following { is plain text", async () => {
		expect(await render('{{ "a # b #c" }}')).toBe("a # b #c");
	});
});

describe("nested interpolation", () => {
	test("interpolations can contain strings with interpolations", async () => {
		expect(
			await render('{{ "a#{ "b#{ x }c" }d" }}', { context: { x: "X" } }),
		).toBe("abXcd");
	});

	test("interpolated markup is not safe", async () => {
		expect(await render('{% set m %}<b>{% endset %}{{ "x#{ m }" }}')).toBe(
			"x&lt;b&gt;",
		);
	});
});
