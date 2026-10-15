import { describe, expect, test } from "vite-plus/test";
import { render } from "../helpers.js";

describe("even", () => {
	test("is true for even integers only", async () => {
		expect(
			await render(
				"{{ 2 is even }}{{ 3 is even }}{{ 2.5 is even }}{{ -4 is even }}",
			),
		).toBe("truefalsefalsetrue");
	});
});

describe("edge cases", () => {
	test("2.0 is the integer 2", async () => {
		expect(await render("{{ 2.0 is even }}")).toBe("true");
	});
});
