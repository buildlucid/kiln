import { describe, expect, test } from "vite-plus/test";
import { check } from "../helpers.js";

const codes = async (source: string) =>
	(await check(source)).map((d) => d.code);

describe("html-redundant-role", () => {
	test("reports a role an element already has", async () => {
		expect(await check('<nav role="navigation">')).toMatchObject([
			{
				code: "html-redundant-role",
				message:
					'<nav> already has the navigation role. Remove role="navigation"',
				severity: "warning",
				start: { column: 6 },
				end: { column: 23 },
			},
		]);
		expect(
			await codes(
				'<main role="MAIN"><button type="button" role="button">A</button><h2 role="heading">B</h2>',
			),
		).toEqual([
			"html-redundant-role",
			"html-redundant-role",
			"html-redundant-role",
		]);
	});

	test("knows roles that depend on href and type", async () => {
		expect(
			await codes(
				'<a href="/" role="link">A</a><input type="checkbox" role="checkbox">',
			),
		).toEqual(["html-redundant-role", "html-redundant-role"]);
		expect(
			await codes(
				'<a role="link">A</a><input type="text" role="textbox"><input role="checkbox">',
			),
		).toEqual([]);
	});

	test("leaves lists, fallback roles and different roles alone", async () => {
		expect(
			await codes(
				'<ul role="list"><li role="listitem">A</li></ul><nav role="navigation menu"><button type="button" role="tab">B</button>',
			),
		).toEqual([]);
	});
});
