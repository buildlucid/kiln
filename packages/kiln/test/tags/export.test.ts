import { describe, expect, test } from "vite-plus/test";
import { createKiln, memoryLoader, withRender } from "../../src/index.js";
import { errorCode, evaluate, lines, render } from "../helpers.js";

describe("export", () => {
	test("evaluate works out an export's value, waiting for async functions", async () => {
		expect(
			await evaluate(
				'{% export paths = slugs()|map(slug => "/blog/" ~ slug) %}',
				"paths",
				{ functions: { slugs: async () => ["hello", "world"] } },
			),
		).toEqual(["/blog/hello", "/blog/world"]);
	});

	test("evaluate resolves to undefined for a name the template doesn't export", async () => {
		expect(await evaluate("{% export a = 1 %}", "b")).toBeUndefined();
	});

	test("never runs or outputs anything when the template renders", async () => {
		let calls = 0;
		expect(
			await render(lines("{% export count = counted() %}", "<p>Hi</p>"), {
				functions: { counted: () => ++calls },
			}),
		).toBe("<p>Hi</p>");
		expect(calls).toBe(0);
	});

	test("reads globals, and passes the render options to functions", async () => {
		const kiln = createKiln<{ locale: string }>({
			loader: memoryLoader({
				page: '{% export url = site.url ~ localized("about") %}',
			}),
			globals: { site: { url: "https://example.com" } },
			functions: {
				localized: withRender(
					(render, path: string) => `/${render.state.locale}/${path}`,
				),
			},
		});
		expect(
			await kiln.evaluate("page", "url", { state: { locale: "fr" } }),
		).toBe("https://example.com/fr/about");
	});

	test("can't read the template's variables", async () => {
		expect(
			await errorCode(
				lines("{% set posts = [] %}", "{% export paths = posts %}"),
			),
		).toBe("export-scope");
		expect(
			await errorCode(
				lines("{% props page %}", "{% export title = page.title %}"),
			),
		).toBe("export-scope");
	});

	test("goes at the top level, including in a template that extends a layout", async () => {
		expect(
			await evaluate(
				lines('{% extends "base" %}', '{% export title = "About" %}'),
				"title",
				{ templates: { base: "" } },
			),
		).toBe("About");
		expect(await errorCode("{% if true %}{% export a = 1 %}{% endif %}")).toBe(
			"misplaced-export",
		);
	});

	test("each name can be exported once", async () => {
		expect(
			await errorCode(lines("{% export a = 1 %}", "{% export a = 2 %}")),
		).toBe("duplicate-export");
	});

	test("only the template's own exports count", async () => {
		expect(
			await evaluate('{% extends "base" %}', "title", {
				templates: { base: '{% export title = "Base" %}' },
			}),
		).toBeUndefined();
	});
});
