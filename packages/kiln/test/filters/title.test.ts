import { describe, expect, test } from "vite-plus/test";
import { render } from "../helpers.js";

describe("title", () => {
	test("capitalises each word", async () => {
		expect(await render('{{ "the third man"|title }}')).toBe("The Third Man");
	});

	test("treats hyphens as word breaks but not apostrophes", async () => {
		expect(await render(`{{ "jean-luc o'neil"|title|raw }}`)).toBe(
			"Jean-Luc O'neil",
		);
	});
});

describe("edge cases", () => {
	test("a combining mark doesn't start a word", async () => {
		expect(
			await render("{{ text|title }}", {
				context: { text: "e\u0301cole nai\u0308ve" },
			}),
		).toBe("E\u0301cole Nai\u0308ve");
	});

	test("tags in safe markup don't break a word", async () => {
		expect(await render('{{ "<b>hello</b> wor<i>ld</i>"|raw|title }}')).toBe(
			"<b>Hello</b> Wor<i>ld</i>",
		);
	});
});
