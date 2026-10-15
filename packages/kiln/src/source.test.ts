import { describe, expect, test } from "vite-plus/test";
import { Source } from "./source.js";

describe("Source.position", () => {
	const source = new Source("a.kiln", "ab\ncd\r\nef");

	test("gives one-based lines and columns", () => {
		expect(source.position(0)).toEqual({ offset: 0, line: 1, column: 1 });
		expect(source.position(4)).toEqual({ offset: 4, line: 2, column: 2 });
		expect(source.position(7)).toEqual({ offset: 7, line: 3, column: 1 });
	});

	test("an offset at the end is on the last line", () => {
		expect(source.position(9)).toEqual({ offset: 9, line: 3, column: 3 });
	});
});

describe("Source.frame", () => {
	test("shows the line before and after, with a marker under the span", () => {
		const source = new Source("a.kiln", "one\ntwo {{ x }}\nthree");
		expect(source.frame({ start: 11, end: 12 })).toBe(
			["  1 | one", "> 2 | two {{ x }}", "    |        ^", "  3 | three"].join(
				"\n",
			),
		);
	});

	test("keeps tabs so the marker lines up", () => {
		const source = new Source("a.kiln", "\t\t{{ x }}");
		expect(source.frame({ start: 5, end: 6 }).split("\n")[1]).toBe(
			"    | \t\t   ^",
		);
	});

	test("stops the marker at the end of the line", () => {
		const source = new Source("a.kiln", "ab\ncd");
		expect(source.frame({ start: 1, end: 5 }).split("\n")[1]).toBe("    |  ^");
	});

	test("pads line numbers to the same width", () => {
		const text = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join(
			"\n",
		);
		const source = new Source("a.kiln", text);
		expect(
			source.frame({
				start: text.indexOf("line 9"),
				end: text.indexOf("line 9") + 1,
			}),
		).toBe(
			["   8 | line 8", ">  9 | line 9", "     | ^", "  10 | line 10"].join(
				"\n",
			),
		);
	});
});
