import { describe, expect, test } from "vite-plus/test";
import { errorCode, render } from "../helpers.js";

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

describe("markup", () => {
	test("changes only the text of safe markup, which stays safe", async () => {
		expect(
			await render("{{ html|raw|upper }}", {
				context: { html: '<a href="/x">hi &amp; bye</a>' },
			}),
		).toBe('<a href="/x">HI &amp; BYE</a>');
	});

	test("a result longer than maxOutputLength is an error", async () => {
		expect(
			await errorCode("{{ text|upper }}", {
				context: { text: "ß".repeat(6) },
				limits: { maxOutputLength: 10 },
			}),
		).toBe("limit-output");
	});
});
