import { describe, expect, test } from "vite-plus/test";
import { check } from "../helpers.js";

const messages = async (source: string) =>
	(await check(source)).map((d) => d.message);

describe("html-obsolete-attribute", () => {
	test("reports an obsolete attribute, with what to use instead", async () => {
		expect(await check('<div align="center">')).toEqual([
			{
				code: "html-obsolete-attribute",
				message: "The align attribute on <div> is obsolete. Use CSS instead",
				severity: "warning",
				template: "index.kiln",
				start: { offset: 5, line: 1, column: 6 },
				end: { offset: 10, line: 1, column: 11 },
			},
		]);
		expect(await messages('<a name="top">Top</a>')).toEqual([
			"The name attribute on <a> is obsolete. Use id instead",
		]);
		expect(await messages('<table summary="Prices"></table>')).toEqual([
			"The summary attribute on <table> is obsolete. Use <caption> instead",
		]);
		expect(await messages('<script language="javascript"></script>')).toEqual([
			"The language attribute on <script> is obsolete. Remove it",
		]);
	});

	test("only reports an attribute on the elements it is obsolete on", async () => {
		expect(
			await check(
				'<th abbr="Qty" scope="col">Quantity</th><img src=a alt="" width="10"><p name="x">',
			),
		).toEqual([]);
		expect(
			(await check('<table><tr><td scope="col" abbr="Qty">')).map(
				(d) => d.code,
			),
		).toEqual(["html-obsolete-attribute", "html-obsolete-attribute"]);
	});

	test("matches attribute names in any case, whatever the value", async () => {
		expect(
			(await check('<BODY BGCOLOR="{{ colour }}">')).map((d) => d.code),
		).toEqual(["html-obsolete-attribute"]);
	});
});
