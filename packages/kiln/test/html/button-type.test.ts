import { describe, expect, test } from "vite-plus/test";
import { check } from "../helpers.js";

const codes = async (source: string) =>
	(await check(source)).map((d) => d.code);

describe("html-button-type", () => {
	test("reports a button with no type attribute", async () => {
		expect(await check("<button>Menu</button>")).toMatchObject([
			{
				code: "html-button-type",
				message:
					'<button> has no type attribute, so it submits any form it is in. Add type="button" or type="submit"',
				severity: "warning",
				start: { line: 1, column: 1 },
				end: { line: 1, column: 8 },
			},
		]);
	});

	test("accepts a written-out or output type", async () => {
		expect(
			await codes(
				'<button type="button">A</button><button type=submit>B</button><button type="{{ kind }}">C</button>',
			),
		).toEqual([]);
	});

	test("is not reported when attrs may add the type", async () => {
		expect(
			await codes("<button{{ attrs(attributes) }}>{{ label }}</button>"),
		).toEqual([]);
	});

	test("checks each branch's tag on its own", async () => {
		expect(
			await codes(
				'{% if submit %}<button type="submit">{% else %}<button>{% endif %}Go</button>',
			),
		).toEqual(["html-button-type"]);
	});
});
