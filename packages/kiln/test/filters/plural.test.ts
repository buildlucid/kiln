import { describe, expect, test } from "vite-plus/test";
import { errorCode, render } from "../helpers.js";

describe("plural", () => {
	test("picks the form for the number and replaces # with it", async () => {
		const template =
			'{{ 1|plural(one: "# item", other: "# items") }}|{{ 1200|plural(one: "# item", other: "# items") }}';
		expect(await render(template)).toBe("1 item|1,200 items");
	});

	test("takes one and other without names", async () => {
		expect(await render('{{ 1|plural("item", "items") }}')).toBe("item");
		expect(await render('{{ 0|plural("item", "items") }}')).toBe("items");
	});

	test("uses other when the locale's form isn't passed", async () => {
		expect(
			await render('{{ 5|plural(one: "plik", other: "pliku", locale: "pl") }}'),
		).toBe("pliku");
	});

	test("follows the locale's rules", async () => {
		const template =
			'{{ 22|plural(one: "plik", few: "pliki", many: "plików", other: "pliku") }}';
		expect(await render(template, { locale: "pl" })).toBe("pliki");
	});

	test("can pick ordinal forms", async () => {
		const template =
			'{% for n in [1, 2, 3, 11] %}{{ n|plural(one: "#st", two: "#nd", few: "#rd", other: "#th", type: "ordinal") }} {% endfor %}';
		expect(await render(template)).toBe("1st 2nd 3rd 11th ");
	});

	test("formats # for the locale", async () => {
		expect(
			await render('{{ 1200|plural("# item", "# items", locale: "de-DE") }}'),
		).toBe("1.200 items");
	});

	test("needs an other form", async () => {
		expect(await errorCode('{{ 1|plural("item") }}')).toBe("invalid-argument");
	});

	test("needs a number", async () => {
		expect(await errorCode('{{ "1"|plural("a", "b") }}')).toBe("type-error");
	});

	test("invalid options are an error", async () => {
		expect(await errorCode('{{ 1|plural("a", "b", type: "nope") }}')).toBe(
			"invalid-argument",
		);
	});
});

describe("escaping", () => {
	test("the form is escaped", async () => {
		expect(await render('{{ 1|plural("<b>", "b") }}')).toBe("&lt;b&gt;");
	});
});

describe("null", () => {
	test("prints nothing", async () => {
		expect(await render('[{{ null|plural("a", "b") }}]')).toBe("[]");
	});
});

describe("limits", () => {
	test("an unknown option is an error", async () => {
		expect(await errorCode('{{ 1|plural("a", "b", oops: 1) }}')).toBe(
			"invalid-argument",
		);
	});

	test("stops before building text longer than maxOutputLength", async () => {
		expect(
			await errorCode('{{ 1000000|plural(one: "##", other: "##") }}', {
				limits: { maxOutputLength: 10 },
			}),
		).toBe("limit-output");
	});
});
