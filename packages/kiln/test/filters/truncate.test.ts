import { describe, expect, test } from "vite-plus/test";
import { render } from "../helpers.js";

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

	test("a lone surrogate counts as one code point", async () => {
		expect(
			await render("{{ text|truncate(1) }}", {
				context: { text: "\uDC00\uDC00x" },
			}),
		).toBe("\uDC00…");
	});
});
