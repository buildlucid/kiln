import { describe, expect, test } from "vite-plus/test";
import { errorCode, render } from "../helpers.js";

describe("..", () => {
	test("is inclusive", async () => {
		expect(await render('{{ (1..5)|join(",") }}')).toBe("1,2,3,4,5");
	});

	test("counts down when the end is smaller", async () => {
		expect(await render('{{ (3..1)|join(",") }}')).toBe("3,2,1");
	});

	test("binds looser than arithmetic", async () => {
		expect(
			await render('{{ (1..n + 1)|join(",") }}', { context: { n: 2 } }),
		).toBe("1,2,3");
	});

	test("a range of one item", async () => {
		expect(await render('{{ (4..4)|join(",") }}')).toBe("4");
	});

	test("needs integers", async () => {
		expect(await errorCode("{{ (1..2.5)|join }}")).toBe("type-error");
	});

	test("does not support letters", async () => {
		expect(await errorCode("{{ ('a'..'c')|join }}")).toBe("type-error");
	});
});

describe("precedence", () => {
	test("filters bind tighter than ..", async () => {
		expect(await errorCode('{{ 1..3|join(",") }}')).toBe("type-error");
	});

	test(".. binds looser than + on both sides", async () => {
		expect(await render('{{ (1 + 1..2 + 2)|join(",") }}')).toBe("2,3,4");
	});

	test("ranges can start below zero", async () => {
		expect(await render('{{ (-2..1)|join(",") }}')).toBe("-2,-1,0,1");
	});
});
