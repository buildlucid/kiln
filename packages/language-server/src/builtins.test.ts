import { describe, expect, test } from "vite-plus/test";
import { builtinFilters } from "../../kiln/src/builtins/filters.js";
import {
	builtinFunctions,
	builtinTests,
} from "../../kiln/src/builtins/functions.js";
import { FILTERS, FUNCTIONS, TESTS } from "./builtins.js";

// `default`, `raw` and `escape`, `parent` and `block`, and `defined` are compiled specially, so the core lists them apart.
describe("builtins", () => {
	test("documents every built-in filter, function and test, and nothing else", () => {
		expect(Object.keys(FILTERS).sort()).toEqual(
			[...Object.keys(builtinFilters), "default", "raw", "escape"].sort(),
		);
		expect(Object.keys(FUNCTIONS).sort()).toEqual(
			[...Object.keys(builtinFunctions), "parent", "block"].sort(),
		);
		expect(Object.keys(TESTS).sort()).toEqual(
			[...Object.keys(builtinTests), "defined"].sort(),
		);
	});
});
