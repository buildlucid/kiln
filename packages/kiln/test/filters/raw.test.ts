import { describe, expect, test } from "vite-plus/test";
import { render } from "../helpers.js";

describe("raw", () => {
	test("marks a value as safe", async () => {
		expect(
			await render("{{ html|raw }}", { context: { html: "<b>bold</b>" } }),
		).toBe("<b>bold</b>");
	});

	test("comes after filters that return plain values, which aren't safe", async () => {
		expect(
			await render(
				'{{ html|raw|split(",")|join(" ") }}|{{ html|split(",")|join(" ")|raw }}',
				{ context: { html: "<b>x</b>,<i>y</i>" } },
			),
		).toBe("&lt;b&gt;x&lt;/b&gt; &lt;i&gt;y&lt;/i&gt;|<b>x</b> <i>y</i>");
	});
});
