import { describe, expect, test } from "vite-plus/test";
import { render } from "../helpers.js";

describe("reduce", () => {
	test("combines items, starting from an initial value", async () => {
		expect(
			await render("{{ [1, 2, 3]|reduce((sum, n) => sum + n, 10) }}"),
		).toBe("16");
	});

	test("starts from null without an initial value", async () => {
		expect(await render('{{ ["a", "b"]|reduce((s, v) => s ~ v) }}')).toBe("ab");
	});

	test("returns the initial value for no items", async () => {
		expect(await render("{{ []|reduce((s, v) => s + v, 5) }}")).toBe("5");
	});
});

describe("hashes", () => {
	test("the arrow receives each key", async () => {
		const template =
			'{{ {a: 200, b: 400}|reduce((c, v, k) => code >= v ? k : c, "") }}';
		expect(await render(template, { context: { code: 404 } })).toBe("b");
	});
});
