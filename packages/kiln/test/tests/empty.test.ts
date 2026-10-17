import { describe, expect, test } from "vite-plus/test";
import { render } from "../helpers.js";

describe("empty", () => {
	test("is true for null, false, empty strings, arrays and hashes", async () => {
		expect(
			await render(
				'{{ null is empty }}{{ false is empty }}{{ "" is empty }}{{ [] is empty }}{{ {} is empty }}',
			),
		).toBe("truetruetruetruetrue");
	});

	test("is false for 0 and non-empty values", async () => {
		expect(
			await render('{{ 0 is empty }}|{{ " " is empty }}|{{ [0] is empty }}'),
		).toBe("false|false|false");
	});
});

describe("edge cases", () => {
	test('NaN and "0" are not empty', async () => {
		expect(await render('{{ "0" is empty }}|{{ (0/0) is empty }}')).toBe(
			"false|false",
		);
	});
});

describe("maps", () => {
	test("a map is empty when a loop would see nothing in it", async () => {
		expect(
			await render("{{ blocked is empty }}|{{ numbered is empty }}", {
				context: {
					blocked: new Map([["__proto__", 1]]),
					numbered: new Map([[1, "x"]]),
				},
			}),
		).toBe("true|false");
	});
});
