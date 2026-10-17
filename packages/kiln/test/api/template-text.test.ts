import { describe, expect, test } from "vite-plus/test";
import { templateText } from "../../src/index.js";

describe("templateText", () => {
	test("replaces tags, outputs and comments with spaces", () => {
		expect(
			templateText('<a href="{{ url }}">{% if new %}New{% endif %}</a>'),
		).toBe('<a href="         ">            New           </a>');
		expect(templateText("<p>{# note #}</p>")).toBe("<p>          </p>");
	});

	test("blanks verbatim content", () => {
		expect(templateText("{% verbatim %}<b>{% endverbatim %}<i>")).toBe(
			`${" ".repeat(34)}<i>`,
		);
	});

	test("keeps line breaks, so lines and columns match the source", () => {
		expect(templateText("{% if a %}\n\t<b>\r\n{% endif %}")).toBe(
			`${" ".repeat(10)}\n\t<b>\r\n${" ".repeat(11)}`,
		);
		expect(templateText("{{ {\n  a: 1\n} }}<b>")).toBe("    \n      \n    <b>");
	});
});
