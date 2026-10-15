import { describe, expect, test } from "vite-plus/test";
import { errorCode, render } from "../helpers.js";

describe("merge", () => {
	test("concatenates arrays", async () => {
		expect(await render('{{ [1, 2]|merge([3], [4])|join(",") }}')).toBe(
			"1,2,3,4",
		);
	});

	test("shallow-merges hashes, with later keys winning", async () => {
		expect(
			await render(
				"{% set h = { a: 1, b: 1 }|merge({ b: 2 }) %}{{ h.a }}{{ h.b }}",
			),
		).toBe("12");
	});

	test("cannot mix arrays and hashes", async () => {
		expect(await errorCode("{{ [1]|merge({ a: 1 }) }}")).toBe("type-error");
	});

	test("does not change the original", async () => {
		const items = [1];
		await render("{% set x = items|merge([2]) %}", { context: { items } });
		expect(items).toEqual([1]);
	});
});

describe("key order", () => {
	test("overwritten keys keep their first position", async () => {
		expect(await render("{{ {a: 1, b: 2}|merge({a: 3})|keys|join }}")).toBe(
			"ab",
		);
	});
});
