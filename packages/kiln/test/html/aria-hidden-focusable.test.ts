import { describe, expect, test } from "vite-plus/test";
import { check } from "../helpers.js";

const codes = async (source: string) =>
	(await check(source)).map((d) => d.code);

describe("html-aria-hidden-focusable", () => {
	test("reports aria-hidden on an element people can tab to", async () => {
		expect(
			await check('<a href="/" aria-hidden="true">Home</a>'),
		).toMatchObject([
			{
				code: "html-aria-hidden-focusable",
				message:
					'<a> has aria-hidden="true", but people can still tab to it. Remove aria-hidden, or take the element out of the tab order',
				severity: "warning",
				start: { column: 1 },
				end: { column: 3 },
			},
		]);
		expect(
			await codes(
				'<button type="button" aria-hidden="TRUE">A</button><input aria-hidden="true"><div tabindex="0" aria-hidden="true">',
			),
		).toEqual([
			"html-aria-hidden-focusable",
			"html-aria-hidden-focusable",
			"html-aria-hidden-focusable",
		]);
	});

	test("accepts elements people can't tab to", async () => {
		expect(
			await codes(
				'<a aria-hidden="true">A</a><button type="button" disabled aria-hidden="true">B</button><button type="button" tabindex="-1" aria-hidden="true">C</button><input type="hidden" aria-hidden="true"><span aria-hidden="true">D</span><a href="/" aria-hidden="false">E</a>',
			),
		).toEqual([]);
	});

	test("is not reported when Kiln can't see every attribute", async () => {
		expect(
			await codes(
				'<a href="/" aria-hidden="true"{{ attrs(a) }}>A</a><div tabindex="{{ i }}" aria-hidden="true">',
			),
		).toEqual([]);
	});
});
