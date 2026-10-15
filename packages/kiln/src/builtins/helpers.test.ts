import { describe, expect, test } from "vite-plus/test";
import { KilnIssue } from "../errors.js";
import { expose } from "../runtime/exposure.js";
import { entriesOf, functionArgument, toDate, toPlainData } from "./helpers.js";

describe("entriesOf", () => {
	test("gives values and keys of arrays, hashes, maps and iterables", () => {
		expect(entriesOf(["a"], "x")).toEqual({
			values: ["a"],
			keys: [0],
			isHash: false,
		});
		expect(entriesOf({ a: 1 }, "x")).toEqual({
			values: [1],
			keys: ["a"],
			isHash: true,
		});
		expect(entriesOf(new Map([["a", 1]]), "x")).toEqual({
			values: [1],
			keys: ["a"],
			isHash: true,
		});
		expect(entriesOf(new Set(["s"]), "x")).toEqual({
			values: ["s"],
			keys: [0],
			isHash: false,
		});
		expect(entriesOf(null, "x")).toEqual({
			values: [],
			keys: [],
			isHash: false,
		});
	});

	test("stops reading an iterable at the limit", () => {
		expect(() => entriesOf(new Set([1, 2, 3]), "x", 2)).toThrow(KilnIssue);
	});

	test("refuses strings and numbers", () => {
		expect(() => entriesOf("abc", "x")).toThrow(KilnIssue);
		expect(() => entriesOf(1, "x")).toThrow(KilnIssue);
	});
});

describe("functionArgument", () => {
	test("refuses functions that were not written in a template", () => {
		expect(() => functionArgument(() => 1, "map")).toThrow(KilnIssue);
	});
});

describe("toDate", () => {
	test("accepts dates, milliseconds and ISO 8601 strings", () => {
		expect(toDate(0, "x").toISOString()).toBe("1970-01-01T00:00:00.000Z");
		expect(toDate("2026-10-15", "x").toISOString()).toBe(
			"2026-10-15T00:00:00.000Z",
		);
		expect(toDate("2026-10-15T10:00:00+02:00", "x").toISOString()).toBe(
			"2026-10-15T08:00:00.000Z",
		);
	});

	test("reads date-times without an offset as UTC", () => {
		expect(toDate("2026-10-15T10:00", "x").toISOString()).toBe(
			"2026-10-15T10:00:00.000Z",
		);
		expect(toDate("2026-10-15 10:00:00", "x").toISOString()).toBe(
			"2026-10-15T10:00:00.000Z",
		);
	});

	test("refuses other strings, other values and invalid dates", () => {
		for (const value of [
			"15/10/2026",
			"now",
			true,
			new Date(Number.NaN),
			"2026-13-45",
		]) {
			expect(() => toDate(value, "x")).toThrow(KilnIssue);
		}
	});
});

describe("toPlainData", () => {
	test("keeps only what templates could read", () => {
		class Post {
			static [expose] = ["title"];
			title = "T";
			secret = "S";
		}
		const data = {
			post: new Post(),
			list: new Set([1]),
			when: new Date(0),
			skip: () => 1,
			n: Number.NaN,
		};
		expect(toPlainData(data, () => "cycle")).toEqual({
			post: { title: "T" },
			list: [1],
			when: "1970-01-01T00:00:00.000Z",
			n: null,
		});
	});

	test("calls onCycle for values that contain themselves", () => {
		const loop: Record<string, unknown> = {};
		loop.self = loop;
		expect(toPlainData(loop, () => "[Circular]")).toEqual({
			self: "[Circular]",
		});
	});
});
