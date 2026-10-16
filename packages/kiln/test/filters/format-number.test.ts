import { describe, expect, test } from "vite-plus/test";
import { errorCode, render } from "../helpers.js";

describe("formatNumber", () => {
	test("formats with the render's locale", async () => {
		expect(await render("{{ 1234.5|formatNumber }}")).toBe("1,234.5");
	});

	test("takes Intl.NumberFormat options as named arguments", async () => {
		const template =
			'{{ 1234.5|formatNumber(style: "currency", currency: "GBP") }}|{{ 0.256|formatNumber(style: "percent") }}';
		expect(await render(template)).toBe("£1,234.50|26%");
	});

	test("can take a locale", async () => {
		expect(await render('{{ 1234.5|formatNumber(locale: "de-DE") }}')).toBe(
			"1.234,5",
		);
	});

	test("uses the locale option of the environment", async () => {
		expect(await render("{{ 1234.5|formatNumber }}", { locale: "de-DE" })).toBe(
			"1.234,5",
		);
	});

	test("invalid options are an error", async () => {
		expect(await errorCode('{{ 1|formatNumber(style: "nope") }}')).toBe(
			"invalid-argument",
		);
	});

	test("needs a number", async () => {
		expect(await errorCode('{{ "1"|formatNumber }}')).toBe("type-error");
	});
});

describe("edge cases", () => {
	test("NaN and infinity", async () => {
		expect(
			await render("{{ (0/0)|formatNumber }}|{{ (1/0)|formatNumber }}"),
		).toBe("NaN|∞");
	});

	test("options can be passed as a hash", async () => {
		expect(await render('{{ 0.5|formatNumber({ style: "percent" }) }}')).toBe(
			"50%",
		);
	});

	test("option values must be strings, numbers or booleans", async () => {
		expect(await render('{{ 0.5|formatNumber(style: "percent"|raw) }}')).toBe(
			"50%",
		);
		expect(await errorCode("{{ 1|formatNumber(style: [1]) }}")).toBe(
			"type-error",
		);
	});

	test("an invalid locale is an error", async () => {
		expect(await errorCode('{{ 1|formatNumber(locale: "!!") }}')).toBe(
			"invalid-argument",
		);
	});
});

describe("null", () => {
	test("prints nothing, never zero", async () => {
		expect(await render("[{{ null|formatNumber }}]")).toBe("[]");
	});
});
