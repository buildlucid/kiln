import { describe, expect, test } from "vite-plus/test";
import { errorCode, render } from "../helpers.js";

describe("slice", () => {
	test("uses a start and an exclusive end", async () => {
		expect(await render('{{ [1, 2, 3, 4]|slice(1, 3)|join(",") }}')).toBe(
			"2,3",
		);
	});

	test("counts negative positions from the end", async () => {
		expect(await render('{{ [1, 2, 3, 4]|slice(-2)|join(",") }}')).toBe("3,4");
	});

	test("slices strings by code point", async () => {
		expect(await render('{{ "héllo"|slice(1, 3) }}')).toBe("él");
	});

	test("needs integer positions", async () => {
		expect(await errorCode("{{ [1]|slice(0.5) }}")).toBe("type-error");
	});
});

describe("edge cases", () => {
	test("negative ends, out-of-range starts and crossed positions", async () => {
		expect(
			await render(
				"{{ [1, 2, 3]|slice(1, -1)|join }}|{{ [1, 2]|slice(5)|length }}|{{ [1, 2, 3]|slice(2, 1)|length }}",
			),
		).toBe("2|0|0");
	});

	test("works by code point on strings", async () => {
		expect(await render('{{ "a😀b"|slice(1, 2) }}')).toBe("😀");
	});

	test("cannot slice a hash", async () => {
		expect(await errorCode("{{ {a: 1}|slice(0, 1) }}")).toBe("type-error");
	});
});
