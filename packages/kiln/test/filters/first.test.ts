import { describe, expect, test } from "vite-plus/test";
import { render } from "../helpers.js";

describe("first", () => {
	test("returns the first item or character", async () => {
		expect(
			await render('{{ [1, 2, 3]|first }}|{{ "abc"|first }}|{{ "😀b"|first }}'),
		).toBe("1|a|😀");
	});

	test("is null for empty values", async () => {
		expect(await render('[{{ []|first }}][{{ ""|first }}]')).toBe("[][]");
	});
});

describe("hashes", () => {
	test("returns the first value a template can read", async () => {
		const map = new Map<unknown, unknown>([
			["__proto__", "x"],
			[1, "y"],
			["a", "z"],
		]);
		expect(
			await render("{{ { b: 1, a: 2 }|first }}|{{ map|first }}", {
				context: { map },
			}),
		).toBe("1|y");
	});
});
