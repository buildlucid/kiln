import { describe, expect, test } from "vite-plus/test";
import { errorCode, render } from "../helpers.js";

describe("round", () => {
	test("rounds half away from zero", async () => {
		expect(
			await render("{{ 2.5|round }}|{{ (-2.5)|round }}|{{ 2.4|round }}"),
		).toBe("3|-3|2");
	});

	test("rounds to a precision without floating-point surprises", async () => {
		expect(await render("{{ 1.005|round(2) }}|{{ 1234|round(-2) }}")).toBe(
			"1.01|1200",
		);
	});

	test("can round up or down", async () => {
		expect(
			await render('{{ 1.21|round(1, "ceil") }}|{{ 1.29|round(1, "floor") }}'),
		).toBe("1.3|1.2");
	});

	test("an unknown method is an error", async () => {
		expect(await errorCode('{{ 1|round(0, "up") }}')).toBe("invalid-argument");
	});
});

describe("negative numbers", () => {
	test("ceil and floor follow the number line", async () => {
		expect(
			await render(
				'{{ (-1.21)|round(1, "ceil") }}|{{ (-1.21)|round(1, "floor") }}|{{ (-0.4)|round }}',
			),
		).toBe("-1.2|-1.3|0");
	});
});
