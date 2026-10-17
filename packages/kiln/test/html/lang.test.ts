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

	test("reports a lang that isn't a valid language tag, on any element", async () => {
		expect(await check('<html lang="en_GB">')).toMatchObject([
			{
				code: "html-lang",
				message: '"en_GB" is not a valid language tag. Use "en-GB"',
				start: { column: 7 },
				end: { column: 19 },
			},
		]);
		expect((await check('<p lang="en gb!">')).map((d) => d.message)).toEqual([
			'"en gb!" is not a valid language tag, such as "en" or "en-GB"',
		]);
	});

	test("accepts valid tags in any case, and an empty lang", async () => {
		expect(
			await check('<p lang="en-gb"><p lang="zh-Hant-TW"><span lang="">'),
		).toEqual([]);
	});

	test("accepts a written-out or output lang", async () => {
		expect(await check('<html lang="en-GB">')).toEqual([]);
		expect(await check('<html lang="{{ locale }}" dir="ltr">')).toEqual([]);
	});
});
