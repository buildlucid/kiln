import { describe, expect, test } from "vite-plus/test";
import { check, lines } from "../helpers.js";

describe("html-lang", () => {
	test("reports an html element with no lang attribute", async () => {
		expect(await check(lines("<!doctype html>", "<html>"))).toMatchObject([
			{
				code: "html-lang",
				message: '<html> has no lang attribute. Add one, such as lang="en"',
				severity: "warning",
				start: { line: 2, column: 1 },
			},
		]);
	});

	test("accepts a written-out or output lang", async () => {
		expect(await check('<html lang="en-GB">')).toEqual([]);
		expect(await check('<html lang="{{ locale }}" dir="ltr">')).toEqual([]);
	});
});
