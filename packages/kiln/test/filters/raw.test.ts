import { describe, expect, test } from "vite-plus/test";
import { render } from "../helpers.js";

describe("raw", () => {
	test("marks a value as safe", async () => {
		expect(
			await render("{{ html|raw }}", { context: { html: "<b>bold</b>" } }),
		).toBe("<b>bold</b>");
	});

	test("must come last, because other filters return unsafe strings", async () => {
		expect(
			await render("{{ html|raw|upper }}|{{ html|upper|raw }}", {
				context: { html: "<b>x</b>" },
			}),
		).toBe("&lt;B&gt;X&lt;/B&gt;|<B>X</B>");
	});
});
