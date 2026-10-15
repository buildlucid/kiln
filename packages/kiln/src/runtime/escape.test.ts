import { describe, expect, test } from "vite-plus/test";
import { KilnIssue } from "../errors.js";
import { escapeWith } from "./escape.js";

describe("escapeWith", () => {
	test("html escapes the five special characters", () => {
		expect(escapeWith(`<a href="x">'&'</a>`, "html")).toBe(
			"&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;",
		);
		expect(escapeWith("plain text", "html")).toBe("plain text");
	});

	test("attr escapes everything but letters, digits and , . - _", () => {
		expect(escapeWith("a-b_c.d,e f=g", "attr")).toBe("a-b_c.d,e&#x20;f&#x3D;g");
		expect(escapeWith("😀", "attr")).toBe("&#x1F600;");
	});

	test("attr replaces control characters", () => {
		expect(escapeWith("a\u0001b", "attr")).toBe("a&#xFFFD;b");
	});

	test("js escapes everything but letters, digits and , . _", () => {
		expect(escapeWith("a b'</", "js")).toBe(
			String.raw`a\u0020b\u0027\u003C\u002F`,
		);
		expect(escapeWith("😀", "js")).toBe(String.raw`\uD83D\uDE00`);
	});

	test("css escapes everything but letters and digits", () => {
		expect(escapeWith("a b;", "css")).toBe(String.raw`a\20 b\3B `);
	});

	test("url encodes everything outside the unreserved set", () => {
		expect(escapeWith("a b!*'()~-._é", "url")).toBe(
			"a%20b%21%2A%27%28%29~-._%C3%A9",
		);
	});

	test("url refuses lone surrogates", () => {
		expect(() => escapeWith("\uD800", "url")).toThrow(KilnIssue);
	});
});
