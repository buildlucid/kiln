import { describe, expect, test } from "vite-plus/test";
import { render } from "../helpers.js";

describe("upper", () => {
	test("upper-cases a string", async () => {
		expect(await render('{{ "hello"|upper }}')).toBe("HELLO");
	});

	test("handles letters beyond ASCII", async () => {
		expect(await render('{{ "straße é"|upper }}')).toBe("STRASSE É");
	});

	test("prints null as an empty string", async () => {
		expect(await render("[{{ null|upper }}]")).toBe("[]");
	});
});

describe("unicode", () => {
	test("capitalize works beyond ASCII", async () => {
		expect(
			await render('{{ "élan"|capitalize }}|{{ "😀aB"|capitalize }}'),
		).toBe("Élan|😀ab");
	});
});
