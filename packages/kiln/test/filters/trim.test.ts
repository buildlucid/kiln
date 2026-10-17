import { describe, expect, test } from "vite-plus/test";
import { errorCode, render } from "../helpers.js";

describe("trim", () => {
	test("removes whitespace from both sides", async () => {
		expect(await render('[{{ "  x  "|trim }}]')).toBe("[x]");
	});

	test("can trim only one side", async () => {
		expect(
			await render(
				'[{{ "  x  "|trim(side: "start") }}][{{ "  x  "|trim(side: "end") }}]',
			),
		).toBe("[x  ][  x]");
	});

	test("can trim other characters", async () => {
		expect(
			await render('[{{ "--x--"|trim("-") }}][{{ "--x--"|trim("-", "end") }}]'),
		).toBe("[x][--x]");
	});

	test("an unknown side is an error", async () => {
		expect(await errorCode('{{ "x"|trim(side: "middle") }}')).toBe(
			"invalid-argument",
		);
	});
});

describe("characters", () => {
	test("trims any of the given characters", async () => {
		expect(await render('{{ "xyHixy"|trim("xy") }}')).toBe("Hi");
	});

	test("Twig's left and right sides are not supported", async () => {
		expect(await errorCode('{{ "x"|trim(side: "left") }}')).toBe(
			"invalid-argument",
		);
	});
});

describe("markup", () => {
	test("trims the text of safe markup, matching escaped characters", async () => {
		expect(
			await render(
				'{{ "<<x<"|escape|trim("<") }}|{{ " <b> x </b> "|raw|trim }}',
			),
		).toBe("x|<b> x </b>");
	});
});
