import { describe, expect, test } from "vite-plus/test";
import { errorCode, render } from "../helpers.js";

describe("map", () => {
	test("transforms each array item", async () => {
		expect(await render('{{ [1, 2]|map(n => n * 10)|join(",") }}')).toBe(
			"10,20",
		);
	});

	test("keeps the keys of a hash", async () => {
		expect(
			await render(
				"{% set h = { a: 1, b: 2 }|map(v => v + 1) %}{{ h.a }}{{ h.b }}",
			),
		).toBe("23");
	});

	test("needs an arrow function", async () => {
		expect(await errorCode('{{ [1]|map("upper") }}')).toBe("type-error");
	});
});
