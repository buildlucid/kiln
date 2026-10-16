import { describe, expect, test } from "vite-plus/test";
import { render } from "../helpers.js";

const context = { page: { author: { name: "ada" } }, none: null };

describe("?.", () => {
	test("reads through present values", async () => {
		expect(await render("{{ page?.author?.name }}", { context })).toBe("ada");
	});

	test("stops the whole chain at null", async () => {
		expect(await render("[{{ none?.a.b.c }}]", { context })).toBe("[]");
	});

	test("works with brackets", async () => {
		expect(
			await render('[{{ none?.["x"] }}]|{{ page?.["author"].name }}', {
				context,
			}),
		).toBe("[]|ada");
	});

	test("leaves keys and arguments after it unevaluated", async () => {
		let calls = 0;
		const count = () => {
			calls++;
			return "x";
		};
		expect(
			await render(
				"[{{ none?.[count()] }}][{{ none?.excerpt(count()) }}][{{ none?.a[count()] }}][{{ page?.[count()] }}]",
				{ context, functions: { count } },
			),
		).toBe("[][][][]");
		expect(calls).toBe(1);
	});

	test("guards missing variables and properties in its chain", async () => {
		expect(
			await render("[{{ missing?.b }}][{{ page?.nope.deep }}]", { context }),
		).toBe("[][]");
	});

	test("guards missing objects before a method call", async () => {
		expect(
			await render(
				'{{ missing?.run() ?? "a" }}|{{ page?.nope.run() ?? "b" }}',
				{ context },
			),
		).toBe("a|b");
	});

	test("ends before a filter, which then receives null", async () => {
		expect(
			await render("{{ page?.author?.name|upper }}|[{{ none?.name|upper }}]", {
				context,
			}),
		).toBe("ADA|[]");
	});
});

describe("edge cases", () => {
	test("a missing property after ?. on a present object is null", async () => {
		expect(await render("[{{ obj?.missing }}]", { context: { obj: {} } })).toBe(
			"[]",
		);
	});

	test("stops before a method call", async () => {
		expect(await render("[{{ none?.excerpt(3) }}]", { context })).toBe("[]");
	});
});
