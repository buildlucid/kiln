import { describe, expect, test } from "vite-plus/test";
import { errorCode, lines, render } from "../helpers.js";

describe("json", () => {
	test("serialises values", async () => {
		expect(
			await render('{{ { n: 1, list: [true, null], s: "x" }|json|raw }}'),
		).toBe('{"n":1,"list":[true,null],"s":"x"}');
	});

	test("escapes characters that could end a script element", async () => {
		const context = { data: { html: "</script><b>&" } };
		expect(await render("{{ data|json|raw }}", { context })).toBe(
			String.raw`{"html":"\u003c/script\u003e\u003cb\u003e\u0026"}`,
		);
	});

	test("can indent", async () => {
		expect(await render("{{ { a: [1] }|json(2)|raw }}")).toBe(
			lines("{", '  "a": [', "    1", "  ]", "}"),
		);
	});

	test("is escaped for html like any other string", async () => {
		expect(await render('<div data-x="{{ { a: 1 }|json }}">')).toBe(
			'<div data-x="{&quot;a&quot;:1}">',
		);
	});

	test("serialises dates, maps and sets", async () => {
		const context = { d: new Date(0), m: new Map([["a", 1]]), s: new Set([1]) };
		expect(await render("{{ [d, m, s]|json|raw }}", { context })).toBe(
			'["1970-01-01T00:00:00.000Z",{"a":1},[1]]',
		);
	});

	test("refuses values that contain themselves", async () => {
		const loop: Record<string, unknown> = {};
		loop.self = loop;
		expect(await errorCode("{{ loop|json }}", { context: { loop } })).toBe(
			"invalid-argument",
		);
	});

	test("counts every item it converts against maxSteps", async () => {
		// Each list holds the one before it twice, so it converts to 2^14 numbers.
		const nested = "{% set x = [x, x] %}".repeat(14);
		expect(
			await errorCode(`{% set x = 1 %}${nested}{{ x|json }}`, {
				limits: { maxSteps: 1000 },
			}),
		).toBe("limit-steps");
	});
});

describe("special values", () => {
	test("NaN becomes null", async () => {
		expect(await render("{{ (0/0)|json|raw }}")).toBe("null");
	});
});

describe("iterables and limits", () => {
	test("serialises a generator as a list", async () => {
		function* items() {
			yield 1;
			yield { a: 2 };
		}
		expect(
			await render("{{ items|json|raw }}", { context: { items: items() } }),
		).toBe('[1,{"a":2}]');
	});

	test("stops before building text longer than maxOutputLength", async () => {
		expect(
			await errorCode("{{ [text, text, text]|json }}", {
				context: { text: "x".repeat(5) },
				limits: { maxOutputLength: 20 },
			}),
		).toBe("limit-output");
	});

	test("data nested too deeply is a too-deep error", async () => {
		let data: unknown = 1;
		for (let i = 0; i < 2000; i++) data = [data];
		expect(await errorCode("{{ data|json }}", { context: { data } })).toBe(
			"too-deep",
		);
	});
});
