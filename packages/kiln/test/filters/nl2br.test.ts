import { describe, expect, test } from "vite-plus/test";
import { errorCode, render } from "../helpers.js";

describe("nl2br", () => {
	test("escapes the text and inserts <br> before line breaks", async () => {
		expect(
			await render("{{ text|nl2br }}", { context: { text: "a<b>\nc\r\nd" } }),
		).toBe("a&lt;b&gt;<br>\nc<br>\r\nd");
	});

	test("keeps html markup as it is", async () => {
		expect(
			await render("{% set html %}<b>a</b>\nb{% endset %}{{ html|nl2br }}"),
		).toBe("<b>a</b><br>\nb");
	});
});

describe("limits", () => {
	test("stops before building text longer than maxOutputLength", async () => {
		expect(
			await errorCode("{{ text|nl2br }}", {
				context: { text: "\n".repeat(4) },
				limits: { maxOutputLength: 10 },
			}),
		).toBe("limit-output");
	});
});
