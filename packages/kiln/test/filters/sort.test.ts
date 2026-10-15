import { describe, expect, test } from "vite-plus/test";
import { errorCode, render } from "../helpers.js";

describe("sort", () => {
	test("sorts numbers and strings naturally", async () => {
		expect(
			await render(
				'{{ [3, 1, 2]|sort|join(",") }}|{{ ["b", "a"]|sort|join(",") }}',
			),
		).toBe("1,2,3|a,b");
	});

	test("sorts by a key", async () => {
		const posts = [
			{ t: "c", n: 3 },
			{ t: "a", n: 1 },
			{ t: "b", n: 2 },
		];
		expect(
			await render('{{ posts|sort(p => p.n)|column("t")|join(",") }}', {
				context: { posts },
			}),
		).toBe("a,b,c");
	});

	test("sorts with a comparator", async () => {
		expect(
			await render('{{ [1, 3, 2]|sort((a, b) => b - a)|join(",") }}'),
		).toBe("3,2,1");
	});

	test("is stable", async () => {
		const items = [
			{ k: 1, id: "a" },
			{ k: 0, id: "b" },
			{ k: 1, id: "c" },
		];
		expect(
			await render('{{ items|sort(i => i.k)|column("id")|join }}', {
				context: { items },
			}),
		).toBe("bac");
	});

	test("refuses mixed types", async () => {
		expect(await errorCode("{{ [1, 'a']|sort|join }}")).toBe("type-error");
	});

	test("a comparator must return a number", async () => {
		expect(await errorCode('{{ [1, 2]|sort((a, b) => "x")|join }}')).toBe(
			"type-error",
		);
	});
});

describe("ordering", () => {
	test("strings sort by code unit, so upper case comes first", async () => {
		expect(await render('{{ ["b", "B", "a"]|sort|join }}')).toBe("Bab");
	});

	test("null cannot be sorted with numbers", async () => {
		expect(await errorCode("{{ [2, null, 1]|sort|join }}")).toBe("type-error");
	});
});
