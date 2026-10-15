import { describe, expect, test } from "vite-plus/test";
import { render } from "../helpers.js";

describe("odd", () => {
	test("is true for odd integers only", async () => {
		expect(
			await render(
				"{{ 3 is odd }}{{ 2 is odd }}{{ -3 is odd }}{{ 1.5 is odd }}",
			),
		).toBe("truefalsetruefalse");
	});
});
