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
			'<div>\n\t<p title="a\n   b  \nc">x</p>\n</div>\n',
		);
	});

	test("reads quotes inside Kiln as Kiln, not as the end of an attribute", () => {
		expect(format('<div class="{{ a ? "" : "b" }}">\n<p>x</p>\n</div>')).toBe(
			'<div class="{{ a ? "" : "b" }}">\n\t<p>x</p>\n</div>\n',
		);
	});

	test("moves scripts, styles and comments with their opening line", () => {
		const source =
			"<div>\n<script>\n    const a = 1;\n      go(a);\n</script>\n<!--\n  note\n-->\n{#\n  note\n#}\n</div>";
		expect(format(source)).toBe(
			"<div>\n\t<script>\n\t\tconst a = 1;\n\t\t  go(a);\n\t</script>\n\t<!--\n\t  note\n\t-->\n\t{#\n\t  note\n\t#}\n</div>\n",
		);
	});
});
