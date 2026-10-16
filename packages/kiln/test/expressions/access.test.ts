import { describe, expect, test } from "vite-plus/test";
import { errorCode, render, renderError } from "../helpers.js";

const context = {
	page: { title: "Home", author: null },
	key: "title",
	items: ["a", "b"],
	grid: [
		[1, 2],
		[3, 4],
	],
};

describe("property access", () => {
	test("dot and brackets read the same properties", async () => {
		expect(
			await render('{{ page.title }}|{{ page["title"] }}|{{ page[key] }}', {
				context,
			}),
		).toBe("Home|Home|Home");
	});

	test("reads array items by index, with brackets or a dot", async () => {
		expect(
			await render(
				"{{ items[0] }}|{{ items.1 }}|{{ grid.0.1 }}|{{ grid[1][0] }}",
				{ context },
			),
		).toBe("a|b|2|3");
	});

	test("reads an array's length", async () => {
		expect(await render("{{ items.length }}", { context })).toBe("2");
	});

	test("reads map values like hash properties", async () => {
		const map = new Map<string, unknown>([["a", 1]]);
		expect(
			await render("{{ map.a }}|{{ map['a'] }}", { context: { map } }),
		).toBe("1|1");
	});

	test.each([
		"{{ data.value }}",
		"{{ data.value|upper }}",
		"{{ data['value'] }}",
		"{% for i in [1] %}{{ data.value }}{% endfor %}",
	])("an error a getter throws is located: %s", async (template) => {
		const cause = new Error("boom");
		const data = {
			get value(): string {
				throw cause;
			},
		};
		const error = await renderError(template, { context: { data } });
		expect(error).toMatchObject({
			code: "host-error",
			message: expect.stringContaining('Reading "value" threw an error: boom'),
			cause,
		});
	});

	test("property names must be strings or numbers", async () => {
		expect(await errorCode("{{ page[[1]] }}", { context })).toBe("type-error");
	});
});

describe("missing properties", () => {
	test("are errors in strict mode", async () => {
		expect(await errorCode("{{ page.titel }}", { context })).toBe(
			"missing-property",
		);
	});

	test("include missing array indexes", async () => {
		expect(await errorCode("{{ items[5] }}", { context })).toBe(
			"missing-property",
		);
	});

	test("include anything read from a string", async () => {
		expect(await errorCode("{{ key.length }}", { context })).toBe(
			"missing-property",
		);
	});

	test("reading a property of null is an error in strict mode", async () => {
		expect(await errorCode("{{ page.author.name }}", { context })).toBe(
			"null-access",
		);
	});
});

describe("keys", () => {
	test("negative and fractional indexes do not exist", async () => {
		expect(await errorCode("{{ items[-1] }}", { context })).toBe(
			"missing-property",
		);
		expect(await errorCode("{{ items[0.5] }}", { context })).toBe(
			"missing-property",
		);
	});

	test("strings cannot be indexed", async () => {
		expect(await errorCode("{{ key[0] }}", { context })).toBe(
			"missing-property",
		);
	});

	test("markup can name a property", async () => {
		expect(await render("{% set k %}a{% endset %}{{ { a: 1 }[k] }}")).toBe("1");
	});

	test("map members are only its keys", async () => {
		const m = new Map([["a", 1]]);
		expect(
			await render('{{ m.size ?? "none" }}|{{ m|length }}', { context: { m } }),
		).toBe("none|1");
	});

	test("results of calls can be read", async () => {
		expect(await render("{{ range(1, 3).1 }}|{{ range(1, 3)[0] }}")).toBe(
			"2|1",
		);
	});

	test("length is an ordinary key on a hash", async () => {
		expect(
			await render('{{ { length: 5 }.length }}|{{ {}.length ?? "none" }}'),
		).toBe("5|none");
	});
});
