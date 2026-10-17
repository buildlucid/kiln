import { describe, expect, test } from "vite-plus/test";
import { errorCode, render } from "../helpers.js";

describe("truncate", () => {
	test("shortens a string and adds an ellipsis", async () => {
		expect(await render('{{ "The quick brown fox"|truncate(10) }}')).toBe(
			"The quick…",
		);
	});

	test("leaves short strings alone", async () => {
		expect(await render('{{ "Short"|truncate(10) }}')).toBe("Short");
	});

	test("can use another ellipsis", async () => {
		expect(await render('{{ "Hello world"|truncate(6, "...") }}')).toBe(
			"Hello...",
		);
	});

	test("counts code points, not UTF-16 units", async () => {
		expect(await render('{{ "😀😀😀"|truncate(2, "") }}')).toBe("😀😀");
	});
});

describe("edge cases", () => {
	test("a string exactly the length is kept, and 0 leaves only the ellipsis", async () => {
		expect(
			await render('{{ "abc"|truncate(3) }}|{{ "abc"|truncate(0) }}'),
		).toBe("abc|…");
	});

	test("an ending that makes the result too long stops at maxOutputLength", async () => {
		const growing = "{% set s = s|truncate((s|length) // 2, s) %}".repeat(4);
		expect(
			await errorCode(`{% set s = "abcdef" %}${growing}`, {
				limits: { maxOutputLength: 20 },
			}),
		).toBe("limit-output");
	});

	test("a lone surrogate counts as one code point", async () => {
		expect(
			await render("{{ text|truncate(1) }}", {
				context: { text: "\uDC00\uDC00x" },
			}),
		).toBe("\uDC00…");
	});
});

describe("markup", () => {
	test("counts the text of safe markup and closes the tags still open", async () => {
		expect(
			await render(
				'{{ "<p>Hello <b>world</b> again</p>"|raw|truncate(8) }}|{{ "a &amp; b"|raw|truncate(3, "…"|raw) }}',
			),
		).toBe("<p>Hello <b>wo…</b></p>|a &amp;…");
	});
});
