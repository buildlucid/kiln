import { describe, expect, test } from "vite-plus/test";
import { format } from "../../src/format.js";

describe("format: whitespace", () => {
	test("turns runs of blank lines into one", () => {
		expect(format("<p>a</p>\n\n\n\n<p>b</p>\n")).toBe("<p>a</p>\n\n<p>b</p>\n");
	});

	test("removes blank lines at the start and end", () => {
		expect(format("\n\n<p>a</p>\n\n\n")).toBe("<p>a</p>\n");
	});

	test("removes trailing spaces and ends with one line break", () => {
		expect(format("<p>a</p>   \n<p>b</p>\t")).toBe("<p>a</p>\n<p>b</p>\n");
	});

	test("turns Windows line breaks into \\n", () => {
		expect(format("<div>\r\n<p>a</p>\r\n</div>\r\n")).toBe(
			"<div>\n\t<p>a</p>\n</div>\n",
		);
	});

	test("an empty template stays empty", () => {
		expect(format("")).toBe("");
		expect(format("\n\n")).toBe("");
	});
});
