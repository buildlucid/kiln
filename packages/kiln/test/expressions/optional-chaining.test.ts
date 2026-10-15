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

	test("guards missing variables and properties in its chain", async () => {
		expect(
			await render("[{{ missing?.b }}][{{ page?.nope.deep }}]", { context }),
		).toBe("[][]");
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
