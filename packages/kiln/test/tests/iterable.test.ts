import { describe, expect, test } from "vite-plus/test";
import { render } from "../helpers.js";

describe("iterable", () => {
	test("is true for arrays, hashes, sets and maps, but not strings", async () => {
		const context = { set: new Set(), map: new Map() };
		expect(
			await render(
				'{{ [] is iterable }}{{ {} is iterable }}{{ set is iterable }}{{ map is iterable }}{{ "s" is iterable }}{{ 1 is iterable }}',
				{ context },
			),
		).toBe("truetruetruetruefalsefalse");
	});
});
