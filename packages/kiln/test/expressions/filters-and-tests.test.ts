import { describe, expect, test } from "vite-plus/test";
import { errorCode, render } from "../helpers.js";

describe("applying filters", () => {
	test("filters chain left to right", async () => {
		expect(await render('{{ "  hello  "|trim|upper|replace("L", "_") }}')).toBe(
			"HE__O",
		);
	});

	test("parentheses are optional without arguments", async () => {
		expect(await render('{{ "a"|upper() }}{{ "b"|upper }}')).toBe("AB");
	});

	test("filters bind tighter than operators", async () => {
		expect(await render("{{ 2 * -3|abs }}")).toBe("-6");
	});

	test("an unknown filter is an error", async () => {
		expect(await errorCode("{{ 1|nope }}")).toBe("unknown-filter");
	});

	test("host filters receive the value first", async () => {
		expect(
			await render("{{ 3|times(4) }}", {
				filters: { times: (a: number, b: number) => a * b },
			}),
		).toBe("12");
	});
});

describe("applying tests", () => {
	test("return booleans and can be negated", async () => {
		expect(await render("{{ 4 is even }}|{{ 4 is not even }}")).toBe(
			"true|false",
		);
	});

	test("can be two words", async () => {
		expect(await render("{{ 9 is divisible by(3) }}")).toBe("true");
	});

	test("hosts can register two-word tests", async () => {
		const tests = { "same as": (a: unknown, b: unknown) => a === b };
		expect(await render("{{ 1 is same as(1) }}", { tests })).toBe("true");
	});

	test("an unknown test is an error", async () => {
		expect(await errorCode("{{ 1 is nope }}")).toBe("unknown-test");
	});

	test("host test results are converted to booleans", async () => {
		expect(
			await render("{{ 1 is truthy }}", { tests: { truthy: () => "yes" } }),
		).toBe("true");
	});
});

describe("test names", () => {
	test("test names are case-sensitive", async () => {
		expect(await errorCode("{{ x is Defined }}")).toBe("unknown-test");
	});

	test("an unknown two-word test is reported by its full name", async () => {
		expect(await errorCode("{{ 1 is foo bar }}")).toBe("unknown-test");
	});

	test("test arguments need parentheses", async () => {
		expect(await errorCode("{{ 9 is divisible by 3 }}")).toBe(
			"unexpected-token",
		);
	});
});
