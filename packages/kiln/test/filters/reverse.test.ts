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

describe("hashes", () => {
	test("keeps the keys, in reverse order", async () => {
		expect(
			await render(
				'{% for k, v in { "1": "a", "2": "b", c: "c" }|reverse %}{{ k }}={{ v }} {% endfor %}',
			),
		).toBe("c=c 2=b 1=a ");
	});
});
