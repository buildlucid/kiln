import { describe, expect, test } from "vite-plus/test";
import { errorCode, render } from "../helpers.js";

describe("arithmetic", () => {
	test("follows the usual precedence", async () => {
		expect(
			await render("{{ 1 + 2 * 3 }}|{{ (1 + 2) * 3 }}|{{ 10 - 4 - 3 }}"),
		).toBe("7|9|3");
	});

	test("divides, floor-divides and takes the remainder", async () => {
		expect(
			await render(
				"{{ 7 / 2 }}|{{ 7 // 2 }}|{{ -7 // 2 }}|{{ 7 % 3 }}|{{ -7 % 3 }}",
			),
		).toBe("3.5|3|-4|1|-1");
	});

	test("raises to a power, right to left", async () => {
		expect(await render("{{ 2 ** 3 ** 2 }}|{{ -2 ** 2 }}|{{ 2 ** -1 }}")).toBe(
			"512|-4|0.5",
		);
	});

	test("unary minus binds looser than filters", async () => {
		expect(await render("{{ -1|abs }}|{{ (-1)|abs }}")).toBe("-1|1");
	});

	test("division by zero follows JavaScript", async () => {
		expect(await render("{{ 1 / 0 }}|{{ 0 / 0 }}")).toBe("Infinity|NaN");
	});

	test("plus never joins strings", async () => {
		expect(await errorCode('{{ "a" + "b" }}')).toBe("type-error");
	});

	test("numeric strings are not numbers", async () => {
		expect(await errorCode('{{ "2" * 3 }}')).toBe("type-error");
	});

	test("null is not a number", async () => {
		expect(
			await errorCode("{{ value + 1 }}", { context: { value: null } }),
		).toBe("type-error");
	});

	test("unary minus needs a number", async () => {
		expect(await errorCode('{{ -"a" }}')).toBe("type-error");
	});
});

describe("edge cases", () => {
	test("chained unary minus", async () => {
		expect(await render("{{ - - 1 }}|{{ 5 - -1 }}|{{ 4 / -1 * 5 }}")).toBe(
			"1|6|-20",
		);
	});

	test("powers with negative bases and exponents", async () => {
		expect(
			await render("{{ 2 ** -1 }}|{{ (-2) ** 3 }}|{{ -a ** 0 }}", {
				context: { a: 4 },
			}),
		).toBe("0.5|-8|-1");
	});

	test("% keeps the sign of the left side and // rounds down", async () => {
		expect(
			await render("{{ -7 % 3 }}|{{ 7 // -2 }}|{{ 7.5 // 2 }}|{{ 1 % 0 }}"),
		).toBe("-1|-4|3|NaN");
	});

	test("booleans are not numbers", async () => {
		expect(await errorCode("{{ true + 1 }}")).toBe("type-error");
	});
});
