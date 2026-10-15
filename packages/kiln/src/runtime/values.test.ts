import { describe, expect, test } from "vite-plus/test";
import { KilnIssue } from "../errors.js";
import { Markup } from "./markup.js";
import { compare, equals, isEmpty, toStr, truthy, typeName } from "./values.js";

describe("truthy", () => {
	test.each([
		[0, false],
		[Number.NaN, false],
		["", false],
		[null, false],
		[undefined, false],
		[[], false],
		[{}, false],
		[new Map(), false],
		[new Set(), false],
		[new Markup("", "html"), false],
		["0", true],
		[" ", true],
		[[0], true],
		[{ a: 0 }, true],
		[new Date(0), true],
	])("%j is %s", (value, expected) => {
		expect(truthy(value)).toBe(expected);
	});
});

describe("isEmpty", () => {
	test("0 is not empty, unlike falsiness", () => {
		expect(isEmpty(0)).toBe(false);
		expect(isEmpty(false)).toBe(true);
		expect(isEmpty(Object.create(null))).toBe(true);
	});
});

describe("toStr", () => {
	test("converts printable values", () => {
		expect([null, undefined, true, false, 1.5, "s"].map(toStr)).toEqual([
			"",
			"",
			"true",
			"false",
			"1.5",
			"s",
		]);
		expect(toStr(new Markup("<b>", "html"))).toBe("<b>");
		expect(toStr(new Date(0))).toBe("1970-01-01T00:00:00.000Z");
	});

	test("refuses arrays, hashes, functions and invalid dates", () => {
		for (const value of [[1], { a: 1 }, () => 1, new Date(Number.NaN)]) {
			expect(() => toStr(value)).toThrow(KilnIssue);
		}
	});
});

describe("equals", () => {
	test("is strict, with null equal to undefined and markup equal to its text", () => {
		expect(equals(1, "1")).toBe(false);
		expect(equals(null, undefined)).toBe(true);
		expect(equals(new Markup("a", "html"), "a")).toBe(true);
		expect(equals([1], [1])).toBe(false);
	});
});

describe("compare", () => {
	test("orders numbers, strings and dates", () => {
		expect(compare(1, 2)).toBeLessThan(0);
		expect(compare("b", "a")).toBeGreaterThan(0);
		expect(compare(new Date(1), new Date(1))).toBe(0);
	});

	test("refuses mixed types", () => {
		expect(() => compare(1, "1")).toThrow(KilnIssue);
	});
});

describe("typeName", () => {
	test("names values the way templates see them", () => {
		class Post {}
		expect(
			[null, [], {}, new Map(), new Set(), new Date(), new Post(), "s", 1].map(
				typeName,
			),
		).toEqual([
			"null",
			"array",
			"hash",
			"hash",
			"set",
			"date",
			"Post object",
			"string",
			"number",
		]);
	});
});
