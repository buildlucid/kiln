import { describe, expect, test } from "vite-plus/test";
import { render } from "../helpers.js";

describe("capitalize", () => {
	test("upper-cases the first character and lower-cases the rest", async () => {
		expect(await render('{{ "hELLO wORLD"|capitalize }}')).toBe("Hello world");
	});

	test("leaves an empty string empty", async () => {
		expect(await render('[{{ ""|capitalize }}]')).toBe("[]");
	});
});

describe("markup", () => {
	test("capitalises the first letter of the text, skipping tags", async () => {
		expect(
			await render('{{ "<p>hELLO <b>wORLD</b></p>"|raw|capitalize }}'),
		).toBe("<p>Hello <b>world</b></p>");
	});
});
