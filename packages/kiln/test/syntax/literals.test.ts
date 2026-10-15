import { describe, expect, test } from "vite-plus/test";
import { errorCode, render } from "../helpers.js";

describe("null and booleans", () => {
	test("are written in lower case", async () => {
		expect(await render("{{ null }}|{{ true }}|{{ false }}")).toBe(
			"|true|false",
		);
	});

	test("upper-case spellings are variables", async () => {
		expect(await errorCode("{{ TRUE }}")).toBe("undefined-variable");
	});
});

describe("numbers", () => {
	test("can have separators and fractions", async () => {
		expect(await render("{{ 1_000_000 }} {{ 3.14 }} {{ 007 }}")).toBe(
			"1000000 3.14 7",
		);
	});
});

describe("arrays", () => {
	test("hold values in order", async () => {
		expect(await render('{{ [1, "two", null]|length }}')).toBe("3");
	});

	test("allow a trailing comma", async () => {
		expect(await render('{{ [1, 2,]|join(",") }}')).toBe("1,2");
	});

	test("can spread other arrays", async () => {
		expect(
			await render('{{ [0, ...items, 4]|join(",") }}', {
				context: { items: [1, 2, 3] },
			}),
		).toBe("0,1,2,3,4");
	});

	test("can only spread arrays and sets", async () => {
		expect(await errorCode("{{ [...5]|length }}")).toBe("type-error");
	});
});

describe("hashes", () => {
	test("keys can be names, strings, numbers or expressions", async () => {
		const template =
			'{% set key = "dyn" %}{% set h = { plain: 1, "data-id": 2, 3: 3, (key): 4 } %}{{ h.plain }}{{ h["data-id"] }}{{ h["3"] }}{{ h.dyn }}';
		expect(await render(template)).toBe("1234");
	});

	test("a name on its own is shorthand for a variable", async () => {
		const template =
			'{% set title = "T" %}{% set url = "/u" %}{% set h = { title, url } %}{{ h.title }}{{ h.url }}';
		expect(await render(template)).toBe("T/u");
	});

	test("can spread other hashes, with later keys winning", async () => {
		const template =
			'{% set h = { ...defaults, size: "lg" } %}{{ h.size }} {{ h.color }}';
		expect(
			await render(template, {
				context: { defaults: { size: "sm", color: "red" } },
			}),
		).toBe("lg red");
	});

	test("allow a trailing comma", async () => {
		expect(await render("{{ {a: 1,}.a }}")).toBe("1");
	});

	test("computed keys must be strings or numbers", async () => {
		expect(await errorCode("{{ { ([1]): 1 }|length }}")).toBe("type-error");
	});
});

describe("number forms", () => {
	test("exponents, leading dots and hex are not supported", async () => {
		for (const template of ["{{ 1e3 }}", "{{ .5 }}", "{{ 0x10 }}"]) {
			expect(await errorCode(template)).not.toBe("");
		}
	});

	test("numbers print as JavaScript prints them", async () => {
		expect(
			await render("{{ 12345678901234567890 }}|{{ 0.1 + 0.2 }}|{{ 1.0 }}"),
		).toBe("12345678901234567000|0.30000000000000004|1");
	});
});

describe("names", () => {
	test("Twig's none is an ordinary name", async () => {
		expect(await render('{{ none ?? "n" }}')).toBe("n");
	});

	test("names may start with operator words", async () => {
		const context = { notes: "n", orders: "o", island: "i", android: "a" };
		expect(
			await render(
				"{{ notes }}{{ orders }}{{ island }}{{ android }}|{{ not notes }}",
				{ context },
			),
		).toBe("noia|false");
	});

	test("operator words that are not reserved can be variables", async () => {
		expect(
			await render(
				"{% set starts = 1 %}{% set by = 2 %}{% set ends = 3 %}{{ starts + by + ends }}",
			),
		).toBe("6");
	});
});

describe("collection edge cases", () => {
	test("later duplicate keys win, and keys become strings", async () => {
		const template =
			'{% set h = { a: 1, a: 2, 1.5: "x", (1 + 1): "y" } %}{{ h.a }}{{ h["1.5"] }}{{ h["2"] }}';
		expect(await render(template)).toBe("2xy");
	});

	test("arrays cannot have holes", async () => {
		expect(await errorCode("{{ [1, , 2]|length }}")).toBe("unexpected-token");
	});

	test("a spread takes a whole conditional", async () => {
		expect(
			await render('{{ [...flag ? ["a"] : ["b"]]|join }}', {
				context: { flag: false },
			}),
		).toBe("b");
	});
});
