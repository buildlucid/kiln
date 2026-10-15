import { describe, expect, test } from "vite-plus/test";
import { render } from "../helpers.js";

describe("split", () => {
	test("splits on a separator", async () => {
		expect(await render('{{ "a,b,c"|split(",")|join("|") }}')).toBe("a|b|c");
	});

	test("returns at most limit items", async () => {
		expect(await render('{{ "a,b,c"|split(",", 2)|join("|") }}')).toBe("a|b");
	});

	test("an empty separator splits into characters", async () => {
		expect(await render('{{ "a😀c"|split("")|join("|") }}')).toBe("a|😀|c");
	});

	test("a string without the separator gives one item", async () => {
		expect(await render('{{ "abc"|split(",")|length }}')).toBe("1");
	});
});

describe("edge cases", () => {
	test("an empty string or a trailing separator", async () => {
		expect(
			await render('{{ ""|split(",")|length }}|{{ "a,b,"|split(",")|length }}'),
		).toBe("1|3");
	});

	test("characters with a limit", async () => {
		expect(await render('{{ "12345"|split("", 2)|join("|") }}')).toBe("1|2");
	});
});
