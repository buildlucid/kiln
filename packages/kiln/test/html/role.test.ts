import { describe, expect, test } from "vite-plus/test";
import { check } from "../helpers.js";

const codes = async (source: string) =>
	(await check(source)).map((d) => d.code);

describe("html-role", () => {
	test("reports a role WAI-ARIA doesn't define, with a suggestion", async () => {
		expect(await check('<div role="buton">')).toMatchObject([
			{
				code: "html-role",
				message: '"buton" is not an ARIA role. Did you mean "button"?',
				severity: "warning",
				start: { line: 1, column: 12 },
				end: { line: 1, column: 17 },
			},
		]);
	});

	test("reports an abstract role", async () => {
		expect((await check('<div role="widget">'))[0]?.message).toBe(
			'"widget" is an abstract ARIA role, which pages must not use',
		);
	});

	test("checks each fallback role in a list", async () => {
		expect(await check('<div role="switch chekbox">')).toMatchObject([
			{ code: "html-role", start: { column: 19 }, end: { column: 26 } },
		]);
		expect(await codes('<div role="switch checkbox">')).toEqual([]);
	});

	test("accepts roles in any case, and DPUB-ARIA and Graphics-ARIA roles", async () => {
		expect(
			await codes(
				'<div role="Button"><section role="doc-chapter"><svg role="graphics-document"></svg>',
			),
		).toEqual([]);
	});

	test("only checks written-out roles", async () => {
		expect(await codes('<div role="{{ role }}"><div role="">')).toEqual([]);
	});
});
