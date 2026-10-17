import { describe, expect, test } from "vite-plus/test";
import { check } from "../helpers.js";

const messages = async (source: string) =>
	(await check(source)).map((d) => d.message);

describe("html-viewport-zoom", () => {
	test("reports a viewport that turns off zooming", async () => {
		expect(
			await check(
				'<meta name="viewport" content="width=device-width, user-scalable=no">',
			),
		).toMatchObject([
			{
				code: "html-viewport-zoom",
				message: "user-scalable=no stops people zooming in to read. Remove it",
				severity: "warning",
				start: { column: 23 },
			},
		]);
		expect(
			await messages(
				'<meta name="viewport" content="width=device-width,user-scalable=0">',
			),
		).toEqual(["user-scalable=0 stops people zooming in to read. Remove it"]);
	});

	test("reports a maximum scale below 2", async () => {
		expect(
			await messages(
				'<meta name="Viewport" content="initial-scale=1; maximum-scale=1.5">',
			),
		).toEqual([
			"maximum-scale=1.5 stops people zooming in to read. Remove it, or use 2 or more",
		]);
	});

	test("accepts a viewport that allows zooming, and other meta tags", async () => {
		expect(
			await check(
				'<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=5"><meta name="description" content="user-scalable=no"><meta name="viewport" content="{{ viewport }}">',
			),
		).toEqual([]);
	});
});
