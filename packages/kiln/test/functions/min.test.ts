import { describe, expect, test } from "vite-plus/test";
import { render } from "../helpers.js";

describe("min", () => {
	test("returns the smallest argument", async () => {
		expect(await render("{{ min(4, 2, 8) }}|{{ min([4, 2, 8]) }}")).toBe("2|2");
	});
});
