import { describe, expect, test } from "vite-plus/test";
import { errorCode, render } from "../helpers.js";

describe("divisible by", () => {
	test("is true for multiples", async () => {
		expect(
			await render(
				"{{ 10 is divisible by(5) }}|{{ 10 is not divisible by(3) }}",
			),
		).toBe("true|true");
	});

	test("dividing by zero is an error", async () => {
		expect(await errorCode("{{ 1 is divisible by(0) }}")).toBe(
			"invalid-argument",
		);
	});
});

describe("edge cases", () => {
	test("zero, fractions and floating-point remainders", async () => {
		expect(
			await render(
				"{{ 0 is divisible by(3) }}|{{ 10 is divisible by(2.5) }}|{{ 0.3 is divisible by(0.1) }}",
			),
		).toBe("true|true|false");
	});
});
