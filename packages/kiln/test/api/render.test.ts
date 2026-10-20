import { describe, expect, test, vi } from "vite-plus/test";
import { createKiln, memoryLoader, streamIslands } from "../../src/index.js";
import { lines, readParts } from "../helpers.js";

describe("render caching", () => {
	test("remembers a limited number of missing templates", async () => {
		const load = vi.fn(() => null);
		const kiln = createKiln({ loader: { load } });
		await expect(kiln.render("nope")).rejects.toMatchObject({
			code: "missing-template",
		});
		await expect(kiln.render("nope")).rejects.toThrow();
		expect(load).toHaveBeenCalledTimes(1);

		// Names may come from requests, so older missing names are forgotten.
		for (let i = 0; i < 1000; i++)
			await kiln.render(`page${i}`).catch(() => {});
		await expect(kiln.render("nope")).rejects.toThrow();
		expect(load).toHaveBeenCalledTimes(1002);
	});

	test("finds a missing template once it is added and invalidated", async () => {
		const templates: Record<string, string> = {};
		const kiln = createKiln({
			loader: { load: (name) => templates[name] ?? null },
		});
		await expect(kiln.render("new")).rejects.toThrow();
		templates["new.kiln"] = "here";
		kiln.invalidate("new");
		expect(await kiln.render("new")).toBe("here");
	});

	test("loads a template again after the loader returned something unusable", async () => {
		const values: unknown[] = [42, "ok"];
		const kiln = createKiln({
			// A value from untyped code, which the types would otherwise reject.
			loader: { load: async () => values.shift() as string },
		});
		await expect(kiln.render("a")).rejects.toThrow(/number/);
		expect(await kiln.render("a")).toBe("ok");
	});

	test("accepts a thenable from the loader", async () => {
		const kiln = createKiln({
			loader: {
				load: (name) => {
					const source = name === "a.kiln" ? "{{ x }}" : null;
					// Not a promise, as a library or another realm may return.
					const thenable: PromiseLike<string | null> = {
						// oxlint-disable-next-line unicorn/no-thenable -- the thenable is what this test checks
						then: (fulfilled, rejected) =>
							Promise.resolve(source).then(fulfilled, rejected),
					};
					return thenable;
				},
			},
		});
		expect(await kiln.render("a", { x: 1 })).toBe("1");
	});
});

describe("render globals", () => {
	const kiln = createKiln({
		loader: memoryLoader({
			layout: "{{ lang }} {% block body %}{% endblock %}",
			page: lines(
				'{% extends "layout" %}',
				"{% macro say() %}{{ lang }}{% endmacro %}",
				'{% block body %}{{ site }} {% include "partial" %} {% component "box" %}{% endcomponent %} {{ say() }} {% island "isle" %}{% endisland %}{% endblock %}',
			),
			partial: "{{ lang }}",
			box: "{{ lang }}",
			isle: "{{ lang }}",
			"set-lang": '{% set lang = "x" %}',
			"set-site": '{% set site = "x" %}',
			label: '{% export label = lang ~ "!" %}',
		}),
		globals: { lang: "en", site: "S" },
	});

	test("every template in the render reads them over the environment's", async () => {
		const stream = await kiln.renderStream(
			"page",
			{},
			{ globals: { lang: "fr" }, islands: streamIslands({ script: false }) },
		);
		expect((await readParts(stream)).join("")).toBe(
			'fr S fr fr fr <kiln-island stream="1"></kiln-island><template>fr</template><kiln-island fill="1"></kiln-island>',
		);
		expect(await kiln.render("page")).toBe("en S en en en en");
	});

	test("templates can't assign to them or to the environment's", async () => {
		const options = { globals: { lang: "fr" } };
		await expect(kiln.render("set-lang", {}, options)).rejects.toMatchObject({
			code: "assign-global",
		});
		await expect(kiln.render("set-site", {}, options)).rejects.toMatchObject({
			code: "assign-global",
		});
	});

	test("evaluate reads them", async () => {
		expect(
			await kiln.evaluate("label", "label", { globals: { lang: "fr" } }),
		).toBe("fr!");
	});
});
