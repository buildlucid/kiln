import { describe, expect, test } from "vite-plus/test";
import { render } from "../helpers.js";

describe("reverse", () => {
	test("reverses arrays and strings", async () => {
		expect(
			await render('{{ [1, 2, 3]|reverse|join(",") }}|{{ "abc"|reverse }}'),
		).toBe("3,2,1|cba");
	});
});

describe("unicode", () => {
	test("reverses strings by code point", async () => {
		expect(await render('{{ "a😀"|reverse }}')).toBe("😀a");
	});
});
