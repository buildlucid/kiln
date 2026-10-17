import { describe, expect, test } from "vite-plus/test";
import { check } from "../helpers.js";

const OBSOLETE = [
	"acronym",
	"applet",
	"basefont",
	"bgsound",
	"big",
	"blink",
	"center",
	"dir",
	"font",
	"frame",
	"frameset",
	"isindex",
	"keygen",
	"listing",
	"marquee",
	"menuitem",
	"multicol",
	"nextid",
	"nobr",
	"noembed",
	"noframes",
	"param",
	"plaintext",
	"rb",
	"rtc",
	"spacer",
	"strike",
	"tt",
	"xmp",
];

describe("html-obsolete-element", () => {
	test("reports an obsolete element, with what to use instead", async () => {
		expect(await check("<div>\n\t<center>Hi</center>\n</div>")).toEqual([
			{
				code: "html-obsolete-element",
				message: "<center> is obsolete. Use CSS instead",
				severity: "warning",
				template: "index.kiln",
				start: { offset: 7, line: 2, column: 2 },
				end: { offset: 14, line: 2, column: 9 },
			},
		]);
	});

	test("reports every obsolete element in the HTML standard", async () => {
		for (const name of OBSOLETE) {
			const diagnostics = await check(`<${name}>`);
			expect(diagnostics.map((d) => d.code)).toEqual(["html-obsolete-element"]);
		}
	});

	test("suggests a replacement for each", async () => {
		const message = async (source: string) => (await check(source))[0]?.message;
		expect(await message("<acronym>")).toBe(
			"<acronym> is obsolete. Use <abbr> instead",
		);
		expect(await message("<strike>")).toBe(
			"<strike> is obsolete. Use <s>, or <del> for removed text, instead",
		);
		expect(await message("<nextid>")).toBe("<nextid> is obsolete. Remove it");
	});

	test("matches element names in any case", async () => {
		expect((await check("<CENTER>Hi</CENTER>")).map((d) => d.code)).toEqual([
			"html-obsolete-element",
		]);
	});

	test("does not report current elements, custom elements or end tags", async () => {
		expect(
			await check(
				"<s>Old</s><abbr>HTML</abbr><center-box></center-box></font>",
			),
		).toEqual([]);
	});
});
