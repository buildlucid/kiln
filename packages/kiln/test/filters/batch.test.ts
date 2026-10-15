import { describe, expect, test } from "vite-plus/test";
import { errorCode, render } from "../helpers.js";

describe("batch", () => {
	test("splits an array into groups", async () => {
		expect(
			await render(
				'{% for row in [1, 2, 3, 4, 5]|batch(2) %}[{{ row|join(",") }}]{% endfor %}',
			),
		).toBe("[1,2][3,4][5]");
	});

	test("pads the last group with a fill value", async () => {
		expect(
			await render(
				'{% for row in [1, 2, 3]|batch(2, 0) %}[{{ row|join(",") }}]{% endfor %}',
			),
		).toBe("[1,2][3,0]");
	});

	test("the size must be at least 1", async () => {
		expect(await errorCode("{{ [1]|batch(0) }}")).toBe("invalid-argument");
	});
});

describe("edge cases", () => {
	test("full groups need no padding, and no items give no groups", async () => {
		expect(
			await render("{{ [1, 2]|batch(2, 0)|length }}|{{ []|batch(3)|length }}"),
		).toBe("1|0");
	});
});
