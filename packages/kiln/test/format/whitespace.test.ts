import { describe, expect, test } from "vite-plus/test";
import { format } from "../../src/format.js";

describe("format: whitespace", () => {
	test("turns runs of blank lines into one", () => {
		expect(format("<p>a</p>\n\n\n\n<p>b</p>\n")).toBe("<p>a</p>\n\n<p>b</p>\n");
	});

	test("keeps whitespace at the start and end of the file as written", () => {
		// A template can be placed inside a line, where these show.
		expect(format("\n\n  <p>a</p>\n<p>b</p>  \n\n")).toBe(
			"\n\n  <p>a</p>\n<p>b</p>  \n\n",
		);
		expect(format("<div>\n<p>a</p>\n</div>")).toBe("<div>\n\t<p>a</p>\n</div>");
	});

	test("removes trailing spaces", () => {
		expect(format("<p>a</p>   \n<p>b</p>\n")).toBe("<p>a</p>\n<p>b</p>\n");
		expect(format("<p>a</p>   \n\t\n<p>b</p>")).toBe("<p>a</p>\n\n<p>b</p>");
	});

	test("turns Windows line breaks into \\n", () => {
		expect(format("<div>\r\n<p>a</p>\r\n</div>")).toBe(
			"<div>\n\t<p>a</p>\n</div>",
		);
	});

	test("a template of only whitespace stays as it is", () => {
		expect(format("")).toBe("");
		expect(format("\n \n")).toBe("\n \n");
	});
});
