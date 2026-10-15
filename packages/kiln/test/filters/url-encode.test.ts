import { describe, expect, test } from "vite-plus/test";
import { render } from "../helpers.js";

describe("urlEncode", () => {
	test("encodes a string as a URL component", async () => {
		expect(await render('{{ "a b&c/é"|urlEncode }}')).toBe(
			"a%20b%26c%2F%C3%A9",
		);
	});

	test("encodes a hash as a query string, skipping null", async () => {
		expect(
			await render('{{ { q: "a b", page: 2, skip: null }|urlEncode|raw }}'),
		).toBe("q=a%20b&page=2");
	});

	test("encodes nested arrays and hashes with brackets", async () => {
		expect(
			await render('{{ { tags: ["x", "y"], f: { a: 1 } }|urlEncode|raw }}'),
		).toBe("tags%5B0%5D=x&tags%5B1%5D=y&f%5Ba%5D=1");
	});
});

describe("edge cases", () => {
	test("encodes the characters encodeURIComponent leaves alone", async () => {
		expect(await render(`{{ "!'()*~"|urlEncode }}`)).toBe("%21%27%28%29%2A~");
	});

	test("an empty hash gives an empty string", async () => {
		expect(await render("[{{ {}|urlEncode }}]")).toBe("[]");
	});
});
