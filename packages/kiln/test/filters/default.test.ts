import { describe, expect, test } from "vite-plus/test";
import { render } from "../helpers.js";

describe("default", () => {
	test("replaces missing and empty values", async () => {
		const template =
			'{{ missing|default("a") }}|{{ ""|default("b") }}|{{ []|default(["c"])|join }}|{{ false|default("e") }}';
		expect(await render(template)).toBe("a|b|c|e");
	});

	test("keeps 0", async () => {
		expect(await render('{{ 0|default("d") }}')).toBe("0");
	});

	test("guards a property chain", async () => {
		expect(
			await render('{{ obj.deep.missing|default("f") }}', {
				context: { obj: {} },
			}),
		).toBe("f");
	});

	test("defaults to an empty string", async () => {
		expect(await render("[{{ missing|default }}]")).toBe("[]");
	});
});

describe("edge cases", () => {
	test('NaN, spaces and "0" are not empty', async () => {
		expect(
			await render(
				'{{ (0/0)|default("x") }}|{{ " "|default("x") }}|{{ "0"|default("x") }}',
			),
		).toBe("NaN| |0");
	});

	test("guards a missing index", async () => {
		expect(
			await render('{{ items[9]|default("x") }}', { context: { items: [] } }),
		).toBe("x");
	});
});
