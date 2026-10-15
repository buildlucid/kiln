import { describe, expect, test } from "vite-plus/test";
import { errorCode, render } from "../helpers.js";

describe("~", () => {
	test("joins values as strings", async () => {
		expect(await render('{{ "a" ~ null ~ true ~ 1.5 }}')).toBe("atrue1.5");
	});

	test("binds looser than plus", async () => {
		expect(await render('{{ "Total: " ~ 1 + 2 }}')).toBe("Total: 3");
	});

	test("binds looser than filters", async () => {
		expect(await render('{{ "a" ~ "b"|upper }}')).toBe("aB");
	});

	test("cannot join an array", async () => {
		expect(await errorCode('{{ "a" ~ [1] }}')).toBe("not-printable");
	});

	test("never produces markup", async () => {
		expect(await render('{% set b %}<b>{% endset %}{{ b ~ "<i>" }}')).toBe(
			"&lt;b&gt;&lt;i&gt;",
		);
	});
});

describe("precedence", () => {
	test("plus on both sides of ~ runs first", async () => {
		expect(await render('{{ "a" ~ 1 + 2 ~ "b" }}|{{ 1 + 2 ~ 3 }}')).toBe(
			"a3b|33",
		);
	});
});
