import { describe, expect, test } from "vite-plus/test";
import { render } from "../helpers.js";

describe("lower", () => {
	test("lower-cases a string", async () => {
		expect(await render('{{ "HeLLo"|lower }}')).toBe("hello");
	});
});

describe("markup", () => {
	test("leaves tags and entities alone", async () => {
		expect(
			await render('{{ "<B>"|escape|lower }}|{{ "<B>X</B>"|raw|lower }}'),
		).toBe("&lt;b&gt;|<B>x</B>");
	});
});
