import { describe, expect, test } from "vite-plus/test";
import { KilnIssue } from "../errors.js";
import { binaryOperation, buildRange, contains } from "./operators.js";

describe("buildRange", () => {
	test("builds inclusive ranges in either direction", () => {
		expect(buildRange(1, 3, undefined, 100)).toEqual([1, 2, 3]);
		expect(buildRange(3, 1, undefined, 100)).toEqual([3, 2, 1]);
		expect(buildRange(0, 1, 0.25, 100)).toEqual([0, 0.25, 0.5, 0.75, 1]);
	});

	test("refuses ranges longer than the limit, zero steps and infinite ends", () => {
		expect(() => buildRange(1, 101, 1, 100)).toThrow(KilnIssue);
		expect(() => buildRange(1, 2, 0, 100)).toThrow(KilnIssue);
		expect(() => buildRange(1, Number.POSITIVE_INFINITY, 1, 100)).toThrow(
			KilnIssue,
		);
	});
});

describe("contains", () => {
	test("checks arrays, sets, strings, hash keys and map keys", () => {
		expect(contains(1, [1])).toBe(true);
		expect(contains(1, new Set([1]))).toBe(true);
		expect(contains("b", "abc")).toBe(true);
		expect(contains("a", { a: 0 })).toBe(true);
		expect(contains("a", new Map([["a", 0]]))).toBe(true);
	});

	test("never finds blocked names in hashes", () => {
		expect(contains("constructor", {})).toBe(false);
		expect(contains("__proto__", JSON.parse('{"__proto__": 1}'))).toBe(false);
	});
});

describe("binaryOperation", () => {
	test("arithmetic needs numbers", () => {
		expect(binaryOperation("+", 1, 2)).toBe(3);
		expect(() => binaryOperation("+", "1", 2)).toThrow(KilnIssue);
		expect(() => binaryOperation("*", null, 2)).toThrow(KilnIssue);
	});

	test("~ converts both sides to strings", () => {
		expect(binaryOperation("~", 1, null)).toBe("1");
	});
});
