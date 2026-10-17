import { describe, expect, test } from "vite-plus/test";
import { render } from "../helpers.js";

describe("min", () => {
	test("returns the smallest argument", async () => {
		expect(await render("{{ min(4, 2, 8) }}|{{ min([4, 2, 8]) }}")).toBe("2|2");
	});
});

describe("hashes", () => {
	test("compares the values of one hash", async () => {
		expect(await render("{{ min({ a: 4, b: 2 }) }}")).toBe("2");
	});
});
