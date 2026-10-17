import { describe, expect, test } from "vite-plus/test";
import { check } from "../helpers.js";

const codes = async (source: string) =>
	(await check(source)).map((d) => d.code);

describe("html-tabindex", () => {
	test("reports a tabindex above 0", async () => {
		expect(await check('<div tabindex="3">')).toMatchObject([
			{
				code: "html-tabindex",
				message:
					'tabindex="3" puts this element ahead of the rest of the page when tabbing. Use 0, or -1 to focus it only from script',
				severity: "warning",
				start: { line: 1, column: 6 },
				end: { line: 1, column: 18 },
			},
		]);
		expect(await codes("<div tabindex=1>")).toEqual(["html-tabindex"]);
	});

	test("accepts 0 and negative values", async () => {
		expect(await codes('<div tabindex="0"><div tabindex="-1">')).toEqual([]);
	});

	test("only checks written-out numbers", async () => {
		expect(
			await codes('<div tabindex="{{ order }}"><div tabindex="x">'),
		).toEqual([]);
	});
});
