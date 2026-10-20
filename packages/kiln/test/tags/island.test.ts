import { describe, expect, test } from "vite-plus/test";
import {
	createKiln,
	deferIslands,
	islandScript,
	memoryCache,
	memoryLoader,
	streamIslands,
	withRender,
} from "../../src/index.js";
import {
	errorCode,
	lines,
	readParts,
	render,
	renderError,
	renderStream,
} from "../helpers.js";

const stock = "{% props id %}<p>Stock for {{ id }}</p>";
const templates = { "components/stock": stock };
const script = `<script>${islandScript}</script>`;

describe("island", () => {
	test("renders in place like a component, without its fallback", async () => {
		const template = lines(
			"<main>",
			'\t{% island "components/stock" with { id: 7 } %}',
			"\t\t<p>Loading</p>",
			"\t{% endisland %}",
			"</main>",
		);
		expect(
			await render(template, {
				templates: {
					"components/stock": "{% props id %}<p>\n\t{{ id }}\n</p>\n",
				},
			}),
		).toBe(lines("<main>", "<p>", "\t7", "</p>", "</main>"));
	});

	test("defers into a kiln-island element around its fallback, with the script before the first", async () => {
		const islands = deferIslands({ url: "/_islands/" });
		const template = lines(
			"<main>",
			'\t{% island "components/stock" with { id: 7 } %}',
			"\t\t<p>Loading</p>",
			"\t{% endisland %}",
			'\t<span>{% island "components/stock" with { id: 8 } %}…{% endisland %}</span>',
			"</main>",
		);
		const output = await render(template, { templates, islands });
		const [first, second] = Object.keys(islands.manifest);
		expect(output).toBe(
			lines(
				"<main>",
				`\t${script}<kiln-island src="/_islands/${first}">`,
				"\t\t<p>Loading</p>",
				"\t</kiln-island>",
				`\t<span><kiln-island src="/_islands/${second}">…</kiln-island></span>`,
				"</main>",
			),
		);
		expect(islands.manifest).toEqual({
			[first as string]: {
				template: "components/stock.kiln",
				props: { id: 7 },
				locale: "en",
				timeZone: "UTC",
			},
			[second as string]: {
				template: "components/stock.kiln",
				props: { id: 8 },
				locale: "en",
				timeZone: "UTC",
			},
		});
	});

	test("keeps a deferred island written on one line on one line", async () => {
		const islands = deferIslands({ url: "/i/", script: false });
		const output = await render(
			lines(
				"<main>",
				'\t{% island "components/stock" with { id: 1 } %}…{% endisland %}',
				"</main>",
			),
			{ templates, islands },
		);
		const [id] = Object.keys(islands.manifest);
		expect(output).toBe(
			lines(
				"<main>",
				`\t<kiln-island src="/i/${id}">…</kiln-island>`,
				"</main>",
			),
		);
	});

	test("gives the same template and props the same id in every render", async () => {
		const template =
			'{% island "components/stock" with { id: id } %}{% endisland %}';
		const ids = async (id: number) => {
			const islands = deferIslands({ url: "" });
			await render(template, { templates, islands, context: { id } });
			return Object.keys(islands.manifest);
		};
		const [seven] = await ids(7);
		expect(seven).toMatch(/^[0-9a-f]{16}$/);
		expect(await ids(7)).toEqual([seven]);
		expect(await ids(8)).not.toEqual([seven]);
	});

	test("gives each locale and time zone its own id, recorded in the manifest", async () => {
		const islands = deferIslands({ url: "" });
		const template =
			'{% island "components/stock" with { id: 1 } %}{% endisland %}';
		await render(template, { templates, islands });
		await render(template, {
			templates,
			islands,
			locale: "fr",
			timeZone: "Europe/Paris",
		});
		expect(Object.values(islands.manifest)).toEqual([
			{
				template: "components/stock.kiln",
				props: { id: 1 },
				locale: "en",
				timeZone: "UTC",
			},
			{
				template: "components/stock.kiln",
				props: { id: 1 },
				locale: "fr",
				timeZone: "Europe/Paris",
			},
		]);
	});

	test("records an island used many times once", async () => {
		const islands = deferIslands({ url: "/i/" });
		await render(
			'{% for n in 1..3 %}{% island "components/stock" with { id: 1 } %}{% endisland %}{% endfor %}',
			{ templates, islands },
		);
		expect(Object.keys(islands.manifest)).toHaveLength(1);
	});

	test("renders the fallback in the caller's scope", async () => {
		const islands = deferIslands({ url: "/i/", script: false });
		const output = await render(
			'{% island "components/stock" with { id: 1 } %}{{ message }}{% endisland %}',
			{ templates, islands, context: { message: "Checking…" } },
		);
		expect(output).toMatch(
			/^<kiln-island src="\/i\/[0-9a-f]{16}">Checking…<\/kiln-island>$/,
		);
	});

	test("leaves the script out with script: false", async () => {
		const islands = deferIslands({ url: "/i/", script: false });
		const output = await render(
			'{% island "components/stock" with { id: 1 } %}{% endisland %}',
			{ templates, islands },
		);
		expect(output).not.toContain("<script>");
	});

	test("escapes the url", async () => {
		const output = await render(
			'{% island "components/stock" with { id: 1 } %}{% endisland %}',
			{
				templates,
				islands: deferIslands({ url: '/i?a="&id=', script: false }),
			},
		);
		expect(output).toMatch(
			/^<kiln-island src="\/i\?a=&quot;&amp;id=[0-9a-f]{16}">/,
		);
	});

	test("copies hashes and maps in props as JSON", async () => {
		const islands = deferIslands({ url: "" });
		await render(
			'{% island "components/stock" with { id: [1, { a: null }], extra: extra } %}{% endisland %}',
			{
				templates: { "components/stock": "{% props id, extra %}" },
				islands,
				context: { extra: new Map([["b", true]]) },
			},
		);
		expect(Object.values(islands.manifest)[0]?.props).toEqual({
			id: [1, { a: null }],
			extra: { b: true },
		});
	});

	test("needs props that are JSON values, whether deferred or not", async () => {
		const template =
			'{% island "components/stock" with { id: post } %}{% endisland %}';
		const context = { post: { at: new Date(0) } };
		const error = await renderError(template, { templates, context });
		expect(error).toMatchObject({ code: "type-error" });
		expect(error.message).toContain('"id.at" is a date');
		expect(
			await errorCode(template, {
				templates,
				context,
				islands: deferIslands({ url: "" }),
			}),
		).toBe("type-error");
		expect(
			await errorCode(
				'{% island "components/stock" with { id: x|raw } %}{% endisland %}',
				{
					templates,
					context: { x: "<b>" },
				},
			),
		).toBe("type-error");
	});

	test("counts every item in its props against maxSteps", async () => {
		const nested = "{% set x = [x, x] %}".repeat(14);
		const template = `{% set x = 1 %}${nested}{% island "components/stock" with { id: x } %}{% endisland %}`;
		expect(
			await errorCode(template, { templates, limits: { maxSteps: 1000 } }),
		).toBe("limit-steps");
	});

	test("fails for a missing template when deferred", async () => {
		expect(
			await errorCode('{% island "components/nope" %}{% endisland %}', {
				islands: deferIslands({ url: "" }),
			}),
		).toBe("missing-template");
	});

	test("renders a manifest entry as the island's response", async () => {
		const islands = deferIslands({ url: "" });
		const kiln = createKiln({
			loader: memoryLoader({
				...templates,
				page: '{% island "components/stock" with { id: 3 } %}{% endisland %}',
			}),
		});
		await kiln.render("page", {}, { islands });
		const [entry] = Object.values(islands.manifest);
		if (!entry) throw new Error("Expected an island");
		const { template, props, locale, timeZone } = entry;
		expect(await kiln.render(template, props, { locale, timeZone })).toBe(
			"<p>Stock for 3</p>",
		);
	});

	test("a cached section remembers its islands and its script", async () => {
		const cache = memoryCache();
		const template = lines(
			'{% cache "nav" %}',
			'<nav>{% island "components/stock" with { id: 1 } %}{% endisland %}</nav>',
			"{% endcache %}",
		);
		const first = deferIslands({ url: "/i/" });
		const second = deferIslands({ url: "/i/" });
		const fresh = await render(template, { templates, cache, islands: first });
		expect(await render(template, { templates, cache, islands: second })).toBe(
			fresh,
		);
		expect(second.manifest).toEqual(first.manifest);
		expect(fresh.split("<script>")).toHaveLength(2);
		// Rendered in place, the section is saved separately.
		expect(await render(template, { templates, cache })).toBe(
			"<nav><p>Stock for 1</p></nav>\n",
		);
	});

	test("a reused section adds the script when another island wrote it first", async () => {
		const cache = memoryCache();
		const island =
			'{% island "components/stock" with { id: id } %}{% endisland %}';
		const cached = `{% cache "nav" %}${island}{% endcache %}`;
		await render(`{% set id = 1 %}${island}{% set id = 2 %}${cached}`, {
			templates,
			cache,
			islands: deferIslands({ url: "/i/" }),
		});
		const output = await render(`{% set id = 2 %}${cached}`, {
			templates,
			cache,
			islands: deferIslands({ url: "/i/" }),
		});
		expect(output.startsWith(`${script}<kiln-island`)).toBe(true);
	});

	describe("streamed", () => {
		/** A host function for each name, each waiting until the test resolves it. */
		const waiting = () => {
			const calls = new Map<string, PromiseWithResolvers<string>>();
			const get = (name: string) => {
				let call = calls.get(name);
				if (!call) {
					call = Promise.withResolvers<string>();
					calls.set(name, call);
				}
				return call;
			};
			return {
				slow: (name: string) => get(name).promise,
				resolve: (name: string, value: string) => get(name).resolve(value),
				reject: (name: string, error: Error) => get(name).reject(error),
			};
		};
		const slowStock = "{% props id %}<p>{{ slow(id) }}</p>";
		const slowTemplates = { "components/stock": slowStock };

		test("sends the page with fallbacks, then each island after it as it finishes", async () => {
			const { slow, resolve } = waiting();
			const template = lines(
				"<main>",
				'\t{% island "components/stock" with { id: "a" } %}',
				"\t\t<p>Loading a</p>",
				"\t{% endisland %}",
				'\t{% island "components/stock" with { id: "b" } %}…{% endisland %}',
				"</main>",
			);
			const stream = await renderStream(template, {
				templates: slowTemplates,
				functions: { slow },
				islands: streamIslands(),
			});
			const parts = readParts(stream);
			resolve("b", "B");
			await new Promise((r) => setTimeout(r, 5));
			resolve("a", "A");
			expect(await parts).toEqual([
				lines(
					"<main>",
					`\t${script}<kiln-island stream="1">`,
					"\t\t<p>Loading a</p>",
					"\t</kiln-island>",
					'\t<kiln-island stream="2">…</kiln-island>',
					"</main>",
				),
				'<template><p>B</p></template><kiln-island fill="2"></kiln-island>',
				'<template><p>A</p></template><kiln-island fill="1"></kiln-island>',
			]);
		});

		test("renders islands in place with render", async () => {
			expect(
				await render(
					'{% island "components/stock" with { id: 1 } %}…{% endisland %}',
					{
						templates,
						islands: streamIslands(),
					},
				),
			).toBe("<p>Stock for 1</p>");
		});

		test("renders islands in place inside cache, set, apply and macros", async () => {
			const island =
				'{% island "components/stock" with { id: 1 } %}…{% endisland %}';
			const template = lines(
				`{% cache "a" %}${island}{% endcache %}`,
				`{% set captured %}${island}{% endset %}{{ captured }}`,
				`{% apply upper %}${island}{% endapply %}`,
				`{% macro m() %}${island}{% endmacro %}{{ m() }}`,
			);
			const parts = await readParts(
				await renderStream(template, {
					templates,
					cache: memoryCache(),
					islands: streamIslands(),
				}),
			);
			expect(parts.join("")).toBe(
				lines(
					"<p>Stock for 1</p>",
					"<p>Stock for 1</p>",
					"<p>STOCK FOR 1</p>",
					"<p>Stock for 1</p>",
				),
			);
		});

		test("renders with the page's state and locale", async () => {
			const kiln = createKiln<{ user: string }>({
				loader: memoryLoader({
					page: '{% island "components/hello" %}{% endisland %}',
					"components/hello": "{{ user() }} {{ 1234.5|formatNumber }}",
				}),
				functions: { user: withRender((render) => render.state.user) },
			});
			const stream = await kiln.renderStream(
				"page",
				{},
				{
					islands: streamIslands({ script: false }),
					state: { user: "Ada" },
					locale: "de",
				},
			);
			expect((await readParts(stream)).join("")).toBe(
				'<kiln-island stream="1"></kiln-island><template>Ada 1.234,5</template><kiln-island fill="1"></kiln-island>',
			);
		});

		test("errors the stream when an island fails, after the page is sent", async () => {
			const { slow, reject } = waiting();
			const stream = await renderStream(
				'<p>Page</p>{% island "components/stock" with { id: "a" } %}…{% endisland %}',
				{
					templates: slowTemplates,
					functions: { slow },
					islands: streamIslands(),
				},
			);
			const reader = stream.getReader();
			expect(new TextDecoder().decode((await reader.read()).value)).toContain(
				"<p>Page</p>",
			);
			reject("a", new Error("Out of stock service"));
			await expect(reader.read()).rejects.toMatchObject({
				code: "host-error",
				template: "components/stock.kiln",
			});
		});

		test("errors the stream when the render is aborted while an island waits", async () => {
			const { slow, resolve } = waiting();
			const controller = new AbortController();
			const stream = await renderStream(
				'<p>Page</p>{% island "components/stock" with { id: "a" } %}…{% endisland %}',
				{
					templates: slowTemplates,
					functions: { slow },
					islands: streamIslands({ script: false }),
					signal: controller.signal,
				},
			);
			const parts = readParts(stream);
			controller.abort();
			resolve("a", "In stock");
			await expect(parts).rejects.toMatchObject({ code: "aborted" });
		});

		test("counts islands towards the page's maxSteps and maxDepth", async () => {
			const options = {
				islands: streamIslands({ script: false }),
				templates: {
					heavy: "{% for i in 1..40 %}{% endfor %}",
					nested: '{% island "inner" %}{% endisland %}',
					inner: '{% include "leaf" %}',
					leaf: "leaf",
				},
			};
			// Each island fits in the limit on its own, but not all five.
			await expect(
				renderStream(
					'{% for i in 1..5 %}{% island "heavy" %}{% endisland %}{% endfor %}',
					{ ...options, limits: { maxSteps: 150 } },
				).then(readParts),
			).rejects.toMatchObject({ code: "limit-steps" });
			await expect(
				renderStream('{% include "nested" %}', {
					...options,
					limits: { maxDepth: 2 },
				}).then(readParts),
			).rejects.toMatchObject({ code: "limit-depth" });
		});

		test("counts islands towards maxOutputLength", async () => {
			const stream = await renderStream(
				'{% island "components/stock" with { id: 1 } %}{% endisland %}',
				{
					templates,
					islands: streamIslands({ script: false }),
					limits: { maxOutputLength: 60 },
				},
			);
			await expect(readParts(stream)).rejects.toMatchObject({
				code: "limit-output",
			});
		});
	});
});
