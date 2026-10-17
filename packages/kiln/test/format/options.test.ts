import { describe, expect, test } from "vite-plus/test";
import { formatEdits } from "../../src/format.js";
import { format } from "../../src/format.js";

describe("format: options", () => {
	test("range formats only the lines it overlaps", () => {
		const source = "<div>\n<p>a</p>\n<p>b</p>\n</div>\n";
		const start = source.indexOf("<p>b");
		expect(format(source, { range: { start, end: start + 1 } })).toBe(
			"<div>\n<p>a</p>\n\t<p>b</p>\n</div>\n",
		);
	});

	test("formatEdits returns the changes in order", () => {
		expect(formatEdits("<div>\n<p>{{x}}</p>\n</div>")).toEqual([
			{ start: 6, end: 6, text: "\t" },
			{ start: 9, end: 14, text: "{{ x }}" },
		]);
		expect(formatEdits("<p>a</p>\n")).toEqual([]);
	});

	test("tabWidth must be a whole number of at least 1", () => {
		for (const tabWidth of [0, -2, 2.5, Number.NaN]) {
			expect(() => format("<p>a</p>", { tabWidth })).toThrow(RangeError);
		}
	});
});
