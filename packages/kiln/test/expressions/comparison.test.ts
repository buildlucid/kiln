import { describe, expect, test } from "vite-plus/test";
import { errorCode, render } from "../helpers.js";

describe("equality", () => {
	test("is strict", async () => {
		expect(await render('{{ 1 == "1" }}|{{ 1 == 1 }}|{{ "a" != "b" }}')).toBe(
			"false|true|true",
		);
	});

	test("treats null and missing data as equal", async () => {
		const template = "{{ item.value == null }}|{{ null == (missing ?? null) }}";
		expect(await render(template, { context: { item: { value: null } } })).toBe(
			"true|true",
		);
	});

	test("compares markup by its text", async () => {
		expect(await render('{% set x %}a{% endset %}{{ x == "a" }}')).toBe("true");
	});

	test("compares arrays and hashes by identity", async () => {
		const items = [1];
		expect(
			await render("{{ a == b }}|{{ a == a }}|{{ [1] == [1] }}", {
				context: { a: items, b: [1] },
			}),
		).toBe("false|true|false");
	});
});

describe("ordering", () => {
	test("compares numbers, strings and dates", async () => {
		const template =
			'{{ 2 < 10 }}|{{ "b" > "a" }}|{{ 3 <= 3 }}|{{ 4 >= 5 }}|{{ date("2024-01-01") < date("2025-01-01") }}';
		expect(await render(template)).toBe("true|true|true|false|true");
	});

	test("compares strings by code unit, not as numbers", async () => {
		expect(await render('{{ "10" < "9" }}')).toBe("true");
	});

	test("refuses mixed types", async () => {
		expect(await errorCode('{{ 1 < "2" }}')).toBe("type-error");
	});

	test("cannot be chained", async () => {
		expect(await errorCode("{{ 1 < 2 < 3 }}")).toBe("chained-comparison");
	});
});

describe("in", () => {
	test("checks arrays, strings and hash keys", async () => {
		const template =
			'{{ 2 in [1, 2] }}|{{ "ell" in "hello" }}|{{ "a" in {a: 1} }}|{{ 1 in {a: 1} }}|{{ 3 not in [1, 2] }}';
		expect(await render(template)).toBe("true|true|true|false|true");
	});

	test("uses strict equality", async () => {
		expect(await render('{{ "1" in [1, 2] }}')).toBe("false");
	});

	test("refuses other values", async () => {
		expect(await errorCode("{{ 1 in 5 }}")).toBe("type-error");
	});
});

describe("starts with and ends with", () => {
	test("check the start and end of a string", async () => {
		const template =
			'{{ "kiln" starts with "ki" }}|{{ "kiln" ends with "ln" }}|{{ "kiln" starts with "ln" }}';
		expect(await render(template)).toBe("true|true|false");
	});

	test("need strings", async () => {
		expect(await errorCode("{{ 12 starts with 1 }}")).toBe("type-error");
	});
});

describe("edge cases", () => {
	test("ordering null or booleans is an error", async () => {
		expect(await errorCode("{{ null < 1 }}")).toBe("type-error");
		expect(await errorCode("{{ true > false }}")).toBe("type-error");
	});

	test("strings order by code unit, so upper case comes first", async () => {
		expect(await render('{{ "a" < "B" }}')).toBe("false");
	});

	test("NaN equals nothing, and 1.0 equals 1", async () => {
		expect(
			await render("{{ (0/0) == (0/0) }}|{{ 1 == 1.0 }}|{{ {} == {} }}"),
		).toBe("false|true|false");
	});

	test("two captures with the same text are equal", async () => {
		expect(
			await render(
				"{% set a %}x{% endset %}{% set b %}x{% endset %}{{ a == b }}",
			),
		).toBe("true");
	});

	test("in finds empty strings, null and identical arrays only", async () => {
		expect(
			await render('{{ "" in "abc" }}|{{ null in [null] }}|{{ [] in [[]] }}'),
		).toBe("true|true|false");
	});

	test("in checks own hash keys only", async () => {
		expect(
			await render('{{ "toString" in {} }}|{{ "constructor" in { a: 1 } }}'),
		).toBe("false|false");
	});

	test("in null is an error", async () => {
		expect(await errorCode('{{ "a" in null }}')).toBe("type-error");
	});

	test("starts with an empty string is true", async () => {
		expect(await render('{{ "abc" starts with "" }}')).toBe("true");
	});
});
