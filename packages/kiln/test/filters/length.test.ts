import { describe, expect, test } from "vite-plus/test";
import { errorCode, render } from "../helpers.js";

describe("length", () => {
	test("counts code points in a string", async () => {
		expect(await render('{{ "héllo"|length }}|{{ "😀"|length }}')).toBe("5|1");
	});

	test("counts items, keys and set members", async () => {
		const context = { set: new Set([1, 2]), map: new Map([["a", 1]]) };
		expect(
			await render(
				"{{ [1, 2]|length }}|{{ { a: 1, b: 2, c: 3 }|length }}|{{ set|length }}|{{ map|length }}",
				{ context },
			),
		).toBe("2|3|2|1");
	});

	test("counts a surrogate without its partner as one, as split does", async () => {
		expect(
			await render('{{ s|length }}|{{ s|split("")|length }}', {
				context: { s: "a\uDC00b\uD800" },
			}),
		).toBe("4|4");
	});

	test("is 0 for null", async () => {
		expect(await render("{{ null|length }}")).toBe("0");
	});

	test("cannot measure a number", async () => {
		expect(await errorCode("{{ 5|length }}")).toBe("type-error");
	});
});

describe("edge cases", () => {
	test("booleans have no length", async () => {
		expect(await errorCode("{{ true|length }}")).toBe("type-error");
	});
});

describe("hashes", () => {
	test("counts the keys a loop would see", async () => {
		const map = new Map<unknown, unknown>([
			["__proto__", 1],
			[1, "x"],
			["a", 2],
		]);
		expect(
			await render("{{ map|length }}|{% for v in map %}{{ v }}{% endfor %}", {
				context: { map },
			}),
		).toBe("2|x2");
	});

	test("counts each key against maxSteps", async () => {
		const hash = Object.fromEntries(
			Array.from({ length: 20 }, (_, i) => [`k${i}`, i]),
		);
		expect(
			await errorCode("{{ hash|length }}", {
				context: { hash },
				limits: { maxSteps: 10 },
			}),
		).toBe("limit-steps");
	});
});
