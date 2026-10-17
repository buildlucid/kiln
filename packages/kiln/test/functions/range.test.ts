import { describe, expect, test } from "vite-plus/test";
import { errorCode, render, renderError } from "../helpers.js";

describe("range", () => {
	test("is inclusive, with a step", async () => {
		expect(
			await render(
				'{{ range(0, 10, 5)|join(",") }}|{{ range(1, 2, 0.5)|join(",") }}',
			),
		).toBe("0,5,10|1,1.5,2");
	});

	test("counts down when the end is smaller", async () => {
		expect(await render('{{ range(5, 1)|join(",") }}')).toBe("5,4,3,2,1");
	});

	test("a step pointing away from the end gives no items", async () => {
		expect(await render("{{ range(1, 5, -1)|length }}")).toBe("0");
	});

	test("a zero step is an error", async () => {
		expect(await errorCode("{{ range(1, 5, 0) }}")).toBe("invalid-argument");
	});

	test("ranges larger than the step limit are refused", async () => {
		expect(
			await errorCode("{{ range(1, 100000000)|length }}", {
				limits: { maxSteps: 1000 },
			}),
		).toBe("limit-steps");
	});
});

describe("edge cases", () => {
	test("needs numbers", async () => {
		expect(await errorCode('{{ range("a", "c") }}')).toBe("type-error");
	});

	test("a range of one number", async () => {
		expect(await render("{{ range(1, 1)|join }}")).toBe("1");
	});
});

describe("fractional steps", () => {
	test("reach the end despite rounding", async () => {
		expect(await render('{{ range(0, 0.3, 0.1)|join(", ") }}')).toBe(
			"0, 0.1, 0.2, 0.3",
		);
	});
});

describe("huge integer ranges", () => {
	test("are counted exactly before they are refused", async () => {
		for (const template of [
			"{% for i in 0..9007199254740993 %}{% endfor %}",
			"{{ range(0, 9007199254740993)|length }}",
		]) {
			expect((await renderError(template)).message).toContain(
				"Range of 9007199254740992 items",
			);
		}
	});
});
