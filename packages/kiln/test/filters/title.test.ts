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
