import { describe, expect, test } from "vite-plus/test";
import { render } from "../helpers.js";

describe("defined", () => {
	test("is true for variables that exist, even when null", async () => {
		expect(
			await render("{{ missing is defined }}|{{ value is defined }}", {
				context: { value: null },
			}),
		).toBe("false|true");
	});

	test("works on property chains without raising errors", async () => {
		const context = { page: { title: "T", author: null } };
		expect(
			await render(
				"{{ page.author.name is defined }}|{{ page.title is defined }}|{{ page.title is not defined }}",
				{ context },
			),
		).toBe("false|true|false");
	});
});

describe("edge cases", () => {
	test("indexes, null values and prototype members", async () => {
		const context = { obj: { x: null }, items: [1] };
		expect(
			await render(
				"{{ obj.x is defined }}|{{ items[5] is defined }}|{{ items.0 is defined }}|{{ obj.toString is defined }}",
				{ context },
			),
		).toBe("true|false|true|false");
	});
});
