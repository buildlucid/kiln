import { describe, expect, test } from "vite-plus/test";
import { format } from "../../src/format.js";

describe("format: what it leaves alone", () => {
	test("leaves pre, textarea and verbatim exactly as written", () => {
		const source =
			"<div>\n<pre>\n  keep   me  \n</pre>\n<textarea>\n x \n</textarea>\n{% verbatim %}\n  {{ raw }}  \n{% endverbatim %}\n</div>\n";
		expect(format(source)).toBe(
			"<div>\n\t<pre>\n  keep   me  \n</pre>\n\t<textarea>\n x \n</textarea>\n\t{% verbatim %}\n  {{ raw }}  \n\t{% endverbatim %}\n</div>\n",
		);
	});

	test("leaves text inside attribute values alone", () => {
		expect(format('<div>\n<p title="a\n   b  \nc">x</p>\n</div>')).toBe(
			'<div>\n\t<p title="a\n   b  \nc">x</p>\n</div>',
		);
	});

	test("reads quotes inside Kiln as Kiln, not as the end of an attribute", () => {
		expect(format('<div class="{{ a ? "" : "b" }}">\n<p>x</p>\n</div>')).toBe(
			'<div class="{{ a ? "" : "b" }}">\n\t<p>x</p>\n</div>',
		);
	});

	test("moves scripts, styles and comments with their opening line", () => {
		const source =
			"<div>\n<script>\n    const a = 1;\n      go(a);\n</script>\n<!--\n  note\n-->\n{#\n  note\n#}\n</div>";
		expect(format(source)).toBe(
			"<div>\n\t<script>\n\t\tconst a = 1;\n\t\t  go(a);\n\t</script>\n\t<!--\n\t  note\n\t-->\n\t{#\n\t  note\n\t#}\n</div>",
		);
	});

	test("keeps the body of a set or apply whose tag shares its line, as Kiln outputs it as written", () => {
		expect(
			format("<div>\n{% set s %}a\n  b{% endset %}{{ s|length }}\n</div>"),
		).toBe("<div>\n\t{% set s %}a\n  b{% endset %}{{ s|length }}\n</div>");
		expect(
			format("<div>\n{% apply upper %}a\n  b\n{% endapply %}\n</div>"),
		).toBe("<div>\n\t{% apply upper %}a\n  b\n\t{% endapply %}\n</div>");
		expect(format("<div>\n{% set s %}\n<p>a</p>\n{% endset %}\n</div>")).toBe(
			"<div>\n\t{% set s %}\n\t\t<p>a</p>\n\t{% endset %}\n</div>",
		);
	});

	test("leaves verbatim alone whatever trim markers its tags have", () => {
		const source =
			"<p>\na {%- verbatim -%}\n  {{ x }}  {%- endverbatim -%} b\n</p>";
		expect(format(source)).toBe(
			"<p>\n\ta {%- verbatim -%}\n  {{ x }}  {%- endverbatim -%} b\n</p>",
		);
	});

	test("keeps xmp, listing and plaintext, and only a whole end tag ends pre or script", () => {
		expect(
			format("<div>\n<xmp>\n  a\n</xmp>\n<listing>\n  b\n</listing>\n</div>"),
		).toBe("<div>\n\t<xmp>\n  a\n</xmp>\n\t<listing>\n  b\n</listing>\n</div>");
		expect(format("<div>\n<plaintext>\n  a\n</plaintext>\n  b")).toBe(
			"<div>\n\t<plaintext>\n  a\n</plaintext>\n  b",
		);
		expect(format("<div>\n<pre>\n  a </prefix>\n    b\n</pre>\n</div>")).toBe(
			"<div>\n\t<pre>\n  a </prefix>\n    b\n</pre>\n</div>",
		);
		expect(
			format(
				"<div>\n<script>\n  s = '</scripts>';\n    go();\n</script>\n</div>",
			),
		).toBe(
			"<div>\n\t<script>\n\t  s = '</scripts>';\n\t\tgo();\n\t</script>\n</div>",
		);
	});
});
