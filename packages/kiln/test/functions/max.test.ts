import { describe, expect, test } from "vite-plus/test";
import { errorCode, render } from "../helpers.js";

describe("max", () => {
	test("returns the largest argument", async () => {
		expect(await render('{{ max(1, 5, 3) }}|{{ max("apple", "pear") }}')).toBe(
			"5|pear",
		);
	});

	test("accepts one array", async () => {
		expect(await render("{{ max([4, 2, 8]) }}")).toBe("8");
	});

	test("is null for no values", async () => {
		expect(await render("[{{ max([]) }}]")).toBe("[]");
	});

	test("refuses mixed types", async () => {
		expect(await errorCode('{{ max(1, "a") }}')).toBe("type-error");
	});
});

describe("dates", () => {
	test("compares dates", async () => {
		expect(
			await render('{{ max(date("2020-01-01"), date("2021-01-01")) }}'),
		).toBe("2021-01-01T00:00:00.000Z");
	});
});

describe("null and hashes", () => {
	test("null is refused wherever it is", async () => {
		expect(await errorCode("{{ max(null, 3) }}")).toBe("type-error");
		expect(await errorCode("{{ max(3, null) }}")).toBe("type-error");
	});

	test("compares the values of one hash", async () => {
		expect(await render("{{ max({ a: 1, b: 5 }) }}")).toBe("5");
	});
});
