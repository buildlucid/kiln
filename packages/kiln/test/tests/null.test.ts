import { describe, expect, test } from "vite-plus/test";
import { errorCode, render } from "../helpers.js";

describe("null", () => {
	test("is true for null and missing data", async () => {
		expect(
			await render(
				"{{ value is null }}|{{ 1 is null }}|{{ obj.none is null }}",
				{ context: { value: null, obj: { none: undefined } } },
			),
		).toBe("true|false|true");
	});
});

describe("strict mode", () => {
	test("is not a guard, so missing values are still errors", async () => {
		expect(await errorCode("{{ missing is null }}")).toBe("undefined-variable");
		expect(
			await errorCode("{{ obj.missing is null }}", { context: { obj: {} } }),
		).toBe("missing-property");
	});
});
