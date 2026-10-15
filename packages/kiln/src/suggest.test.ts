import { describe, expect, test } from "vite-plus/test";
import { suggest } from "./suggest.js";

describe("suggest", () => {
	test("suggests a close name, counting a swap as one edit", () => {
		expect(suggest("titel", ["title", "body"])).toBe('Did you mean "title"?');
	});

	test("ignores case", () => {
		expect(suggest("Title", ["title"])).toBe('Did you mean "title"?');
	});

	test("prefers the closest candidate", () => {
		expect(suggest("pages", ["page", "pagess", "pager"])).toBe(
			'Did you mean "page"?',
		);
	});

	test("suggests nothing when no candidate is close", () => {
		expect(suggest("x", ["title"])).toBeUndefined();
		expect(suggest("title", ["title"])).toBeUndefined();
	});
});
