import { describe, expect, test } from "vite-plus/test";
import { render } from "../helpers.js";

describe("stripTags", () => {
	test("removes tags and comments", async () => {
		expect(
			await render('{{ "<p>Hello <b>world</b><!-- note --></p>"|stripTags }}'),
		).toBe("Hello world");
	});

	test("does not decode entities, and the result is escaped", async () => {
		expect(await render('{{ "<p>a &amp; b</p>"|stripTags }}')).toBe(
			"a &amp;amp; b",
		);
	});

	test("keeps a < that never closes", async () => {
		expect(await render('{{ "1 < 2"|stripTags }}')).toBe("1 &lt; 2");
	});
});

describe("edge cases", () => {
	test("a > inside a quoted attribute does not end the tag", async () => {
		expect(await render(`{{ "<p title='a>b'>x</p>"|stripTags }}`)).toBe("x");
	});
});
