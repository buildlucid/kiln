import { describe, expect, test } from "vite-plus/test";
import { check } from "../helpers.js";

describe("html-iframe-title", () => {
	test("reports an iframe with no title", async () => {
		expect(await check('<iframe src="/map"></iframe>')).toMatchObject([
			{
				code: "html-iframe-title",
				message:
					'<iframe> has no title attribute. Add one that says what it holds, such as title="Map of our office"',
				severity: "warning",
				start: { column: 1 },
				end: { column: 8 },
			},
		]);
	});

	test("accepts a written-out or output title, or attributes Kiln can't see", async () => {
		expect(
			await check(
				'<iframe src="/map" title="Map"></iframe><iframe title="{{ t }}"></iframe><iframe{{ attrs(a) }}></iframe>',
			),
		).toEqual([]);
	});
});
