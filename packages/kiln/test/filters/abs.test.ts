import { describe, expect, test } from "vite-plus/test";
import { errorCode, render } from "../helpers.js";

describe("abs", () => {
	test("returns the absolute value", async () => {
		expect(await render("{{ (-3)|abs }}|{{ 2.5|abs }}")).toBe("3|2.5");
	});

	test("needs a number", async () => {
		expect(await errorCode('{{ "x"|abs }}')).toBe("type-error");
	});
});

describe("strings", () => {
	test("numeric strings are not numbers", async () => {
		expect(await errorCode('{{ "5"|abs }}')).toBe("type-error");
	});
});
