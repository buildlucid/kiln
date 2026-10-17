import { describe, expect, test } from "vite-plus/test";
import { errorCode, lines, render } from "../helpers.js";

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

describe("limits", () => {
	test("stops before building text longer than maxOutputLength", async () => {
		expect(
			await errorCode("{{ dump([text, text]) }}", {
				context: { text: "x".repeat(10) },
				debug: true,
				limits: { maxOutputLength: 20 },
			}),
		).toBe("limit-output");
	});
});
