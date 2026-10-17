import { describe, expect, test } from "vite-plus/test";
import { check } from "../helpers.js";

const codes = async (source: string) =>
	(await check(source)).map((d) => d.code);

describe("html-img-alt", () => {
	test("reports an image with no alt attribute", async () => {
		expect(await check('<img src="/cat.jpg">')).toEqual([
			{
				code: "html-img-alt",
				message:
					'<img> has no alt attribute. Use alt="" if the image is decorative',
				severity: "warning",
				template: "index.kiln",
				start: { offset: 0, line: 1, column: 1 },
				end: { offset: 4, line: 1, column: 5 },
			},
		]);
		expect(await codes('<IMG SRC="/cat.jpg" />')).toEqual(["html-img-alt"]);
	});

	test("accepts any alt, including an empty one", async () => {
		expect(
			await codes(
				'<img src="/a.jpg" alt="A cat"><img src="/b.svg" alt=""><img alt>',
			),
		).toEqual([]);
	});

	test("counts an alt whose value comes from an output", async () => {
		expect(await codes('<img src="{{ src }}" alt="{{ image.alt }}">')).toEqual(
			[],
		);
	});

	test("is not reported when a tag or output may add attributes", async () => {
		expect(
			await codes(
				'<img src="{{ src }}" {% if alt %}alt="{{ alt }}"{% endif %}><img{{ attrs(attributes) }}>',
			),
		).toEqual([]);
	});

	test("reads past outputs that hold a >", async () => {
		expect(await codes('<img src="{{ a > b ? x : y }}">')).toEqual([
			"html-img-alt",
		]);
	});
});
