import { describe, expect, test } from "vite-plus/test";
import { lines, render } from "../helpers.js";

describe("dump", () => {
	test("outputs nothing without debug", async () => {
		expect(await render("[{{ dump({ a: 1 }) }}]")).toBe("[]");
	});

	test("shows escaped values in debug mode", async () => {
		expect(await render('{{ dump({ a: "<b>" }) }}', { debug: true })).toBe(
			lines(
				'<pre class="kiln-dump">{',
				"  &quot;a&quot;: &quot;&lt;b&gt;&quot;",
				"}</pre>",
			),
		);
	});
});
