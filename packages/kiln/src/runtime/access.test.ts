import { describe, expect, test } from "vite-plus/test";
import { getAttr, getMethod, readableNames } from "./access.js";
import { expose, lookup } from "./exposure.js";
import { Markup } from "./markup.js";
import { MISSING } from "./values.js";

describe("getAttr", () => {
	test("reads own properties of plain and null-prototype objects", () => {
		const bare = Object.assign(Object.create(null), { a: 1 });
		expect(getAttr({ a: 1 }, "a")).toBe(1);
		expect(getAttr(bare, "a")).toBe(1);
		expect(getAttr({ a: 1 }, "toString")).toBe(MISSING);
	});

	test("reads array indexes and length only", () => {
		expect(getAttr(["x"], 0)).toBe("x");
		expect(getAttr(["x"], "0")).toBe("x");
		expect(getAttr(["x"], "length")).toBe(1);
		expect(getAttr(["x"], 1)).toBe(MISSING);
		expect(getAttr(["x"], "map")).toBe(MISSING);
		expect(getAttr(["x"], "01")).toBe(MISSING);
	});

	test("reads map entries", () => {
		expect(getAttr(new Map([["a", 1]]), "a")).toBe(1);
		expect(getAttr(new Map(), "size")).toBe(MISSING);
	});

	test("reads nothing from primitives, dates, sets and markup", () => {
		for (const target of [
			"abc",
			1,
			null,
			new Date(),
			new Set([1]),
			new Markup("x", "html"),
		]) {
			expect(getAttr(target, "length")).toBe(MISSING);
		}
	});

	test("never reads blocked names", () => {
		const data = JSON.parse(
			'{"__proto__": 1, "constructor": 2, "prototype": 3}',
		) as unknown;
		for (const name of ["__proto__", "constructor", "prototype"]) {
			expect(getAttr(data, name)).toBe(MISSING);
		}
	});

	test("reads exposed members of class instances, then asks lookup", () => {
		class Post {
			static [expose] = ["title", "constructor"];
			title = "T";
			secret = "S";
			[lookup](name: string) {
				return name === "dynamic" ? "D" : undefined;
			}
		}
		const post = new Post();
		expect(getAttr(post, "title")).toBe("T");
		expect(getAttr(post, "dynamic")).toBe("D");
		expect(getAttr(post, "secret")).toBe(MISSING);
		expect(getAttr(post, "constructor")).toBe(MISSING);
	});
});

describe("getMethod", () => {
	class Post {
		static [expose] = ["excerpt", "title"];
		title = "T";
		excerpt() {
			return "E";
		}
		hidden() {
			return "H";
		}
	}

	test("returns only exposed functions", () => {
		expect(getMethod(new Post(), "excerpt")).toBeTypeOf("function");
		expect(getMethod(new Post(), "hidden")).toBeUndefined();
		expect(getMethod(new Post(), "title")).toBeUndefined();
		expect(getMethod([], "map")).toBeUndefined();
	});
});

describe("readableNames", () => {
	test("lists what templates could read, for hints", () => {
		class Post {
			static [expose] = ["title"];
			title = "T";
		}
		expect(readableNames({ a: 1, constructor: 2 })).toEqual(["a"]);
		expect(readableNames(new Post())).toEqual(["title"]);
		expect(readableNames("s")).toEqual([]);
	});
});
