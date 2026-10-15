import { describe, expect, test } from "vite-plus/test";
import { errorCode, lines, render } from "../helpers.js";

describe("verbatim", () => {
	test("outputs its body without parsing it", async () => {
		expect(
			await render("{% verbatim %}{{ not parsed }} {% if %}{% endverbatim %}"),
		).toBe("{{ not parsed }} {% if %}");
	});

	test("its tags can be standalone lines", async () => {
		expect(
			await render(lines("{% verbatim %}", "{{ x }}", "{% endverbatim %}")),
		).toBe("{{ x }}\n");
	});

	test("supports trim markers", async () => {
		expect(
			await render("a {%- verbatim -%} {{ x }} {%- endverbatim -%} b"),
		).toBe("a{{ x }}b");
	});

	test("must be closed", async () => {
		expect(await errorCode("{% verbatim %}{{ x }}")).toBe("unclosed-block");
	});
});

describe("edge cases", () => {
	test("lines inside that look like tags are kept", async () => {
		expect(
			await render(lines("{% verbatim %}", "{% if x %}", "{% endverbatim %}")),
		).toBe("{% if x %}\n");
	});

	test("quotes and openers inside are plain text", async () => {
		expect(
			await render(`{% verbatim %}"{# '{% verbatim %}{% endverbatim %}`),
		).toBe(`"{# '{% verbatim %}`);
	});

	test("Twig's raw tag is not supported", async () => {
		expect(await errorCode("{% raw %}{% endraw %}")).toBe("unknown-tag");
	});
});
