import { describe, expect, test } from "vite-plus/test";
import { KilnSyntaxError } from "../../src/index.js";
import { errorCode, render, renderError } from "../helpers.js";

describe("if", () => {
	test("chooses between if, elseif and else", async () => {
		const template =
			"{% for n in [1, 2, 3] %}{% if n == 1 %}one{% elseif n == 2 %}two{% else %}many{% endif %};{% endfor %}";
		expect(await render(template)).toBe("one;two;many;");
	});

	test("can have several elseif branches", async () => {
		const template =
			"{% if n == 1 %}a{% elseif n == 2 %}b{% elseif n == 3 %}c{% endif %}";
		expect(await render(template, { context: { n: 3 } })).toBe("c");
	});

	test("renders nothing when no branch matches and there is no else", async () => {
		expect(await render("[{% if false %}x{% endif %}]")).toBe("[]");
	});

	test("uses Kiln truthiness", async () => {
		const values = [0, "", "0", " ", [], {}, [0], { a: 1 }, null, false, true];
		const template =
			"{% for v in values %}{% if v %}T{% else %}F{% endif %}{% endfor %}";
		expect(await render(template, { context: { values } })).toBe("FFTTFFTTFFT");
	});

	test("does not create a scope", async () => {
		expect(
			await render('{% if true %}{% set x = "inside" %}{% endif %}{{ x }}'),
		).toBe("inside");
	});

	test("must be closed", async () => {
		expect(await errorCode("{% if true %}yes")).toBe("unclosed-block");
	});

	test("needs a condition", async () => {
		expect(await errorCode("{% if %}{% endif %}")).toBe("unexpected-token");
	});
});

describe("branch structure", () => {
	test("elseif cannot follow else, and else cannot repeat", async () => {
		expect(
			await errorCode("{% if a %}{% else %}{% elseif b %}{% endif %}"),
		).toBe("unexpected-tag");
		expect(await errorCode("{% if a %}{% else %}{% else %}{% endif %}")).toBe(
			"unexpected-tag",
		);
	});

	test("a repeated else is reported where it stands, inside other tags too", async () => {
		const error = await renderError(
			"{% for i in [1] %}{% if a %}{% else %}{% else %}{% endif %}{% endfor %}",
		);
		expect(error).toBeInstanceOf(KilnSyntaxError);
		expect((error as KilnSyntaxError).diagnostics).toMatchObject([
			{
				code: "unexpected-tag",
				message: '"else" cannot follow "else" in "if"',
				start: { column: 42 },
			},
		]);
	});

	test("other languages' spellings are errors", async () => {
		expect(await errorCode("{% if a %}{% elif b %}{% endif %}")).toBe(
			"unknown-tag",
		);
		expect(await errorCode("{% if a %}{% else if b %}{% endif %}")).toBe(
			"unexpected-token",
		);
	});

	test("branches not taken are not evaluated", async () => {
		expect(
			await render('{% if false %}{{ nope }}{{ 1 + "a" }}{% endif %}ok'),
		).toBe("ok");
	});
});
