import { describe, expect, test } from "vite-plus/test";
import { check } from "../helpers.js";

const codes = async (source: string) =>
	(await check(source)).map((d) => d.code);

describe("html-aria-attribute", () => {
	test("reports an aria attribute WAI-ARIA doesn't define, with a suggestion", async () => {
		expect(await check('<nav aria-labeledby="title">')).toMatchObject([
			{
				code: "html-aria-attribute",
				message:
					'"aria-labeledby" is not an ARIA attribute. Did you mean "aria-labelledby"?',
				severity: "warning",
				start: { line: 1, column: 6 },
				end: { line: 1, column: 20 },
			},
		]);
	});

	test("accepts ARIA 1.2 attributes and those the 1.3 draft adds, in any case", async () => {
		expect(
			await codes(
				'<div aria-label="a" ARIA-HIDDEN="true" aria-describedby="b" aria-description="c" aria-braillelabel="d">',
			),
		).toEqual([]);
	});

	test("still checks the attributes it can see when attrs adds more", async () => {
		expect(
			await codes('<nav aria-labeledby="title"{{ attrs(attributes) }}>'),
		).toEqual(["html-aria-attribute"]);
	});

	test("does not check a name built at render time", async () => {
		expect(
			await codes('<div aria-{{ name }}="x" {{ prefix }}aria-labeledby="y">'),
		).toEqual([]);
	});
});
