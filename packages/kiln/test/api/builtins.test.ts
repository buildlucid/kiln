import { describe, expect, test } from "vite-plus/test";
import { builtins } from "../../src/index.js";

describe("builtins", () => {
	test("lists Kiln's own names in alphabetical order, reserved ones included", () => {
		expect(builtins.functions).toContain("range");
		expect(builtins.functions).toContain("parent");
		expect(builtins.filters).toContain("upper");
		expect(builtins.filters).toContain("default");
		expect(builtins.tests).toContain("divisible by");
		expect(builtins.tests).toContain("defined");
		for (const names of Object.values(builtins)) {
			expect(names).toEqual([...names].sort());
		}
	});
});
