import { describe, expect, test } from "vite-plus/test";
import {
	createKiln,
	KilnSyntaxError,
	type KilnOptions,
	memoryLoader,
} from "../../src/index.js";
import { loadModule } from "../helpers.js";

/** Renders `source` from source and precompiled, with the same options. */
const renderBoth = async (
	source: string,
	context: Record<string, unknown> = {},
	{
		templates = {},
		...options
	}: Omit<KilnOptions, "loader"> & { templates?: Record<string, string> } = {},
) => {
	const fromSource = createKiln({
		...options,
		loader: memoryLoader({ ...templates, page: source }),
	});
	const module = await loadModule(await fromSource.precompile("page"));
	const precompiled = createKiln({
		...options,
		loader: memoryLoader({ ...templates, page: module }),
	});
	return {
		source: await fromSource.render("page", context),
		precompiled: await precompiled.render("page", context),
	};
};

describe("precompile", () => {
	test("renders the same as the template's source", async () => {
		const template =
			"{% for item in items %}{{ loop.index }}. {{ item.name|upper }}{% if not loop.last %}, {% endif %}{% else %}None{% endfor %}";
		const items = [{ name: "a" }, { name: "<b>" }];
		const result = await renderBoth(template, { items });
		expect(result.precompiled).toBe("1. A, 2. &lt;B&gt;");
		expect(result.precompiled).toBe(result.source);
	});

	test("templates cannot inject code", async () => {
		const template = [
			"\" ' ` ${x} */ \\     </script>",
			// The generator's own markers, which it must never confuse with text.
			"\u0000wait t0\n\u0001f0:c0\u0001 {{ data['x y'] }}",
			'{{ "\\"); throw 1; //" }}',
			'{{ data["a\\"b"] }}|{{ data["${1}"] }}|{{ data["x y"] }}',
			'{{ { "k\\"); //": 1 }|keys|join }}',
		].join("\n");
		const data = { 'a"b': 1, "${1}": 2, "x y": 3 };
		const result = await renderBoth(template, { data });
		expect(result.precompiled).toBe(result.source);
		expect(result.precompiled).toContain("&quot;); throw 1; //");
	});

	test("waits for includes, components, slots and blocks that return promises", async () => {
		const templates = {
			layout:
				'<h1>{% block title %}{{ later("t") }}{% endblock %}</h1>{% include "part" with { n: 0 } %}|{% block body %}{% endblock %}|end',
			part: "{% props n %}[{{ later(n) }}]",
			card: "{% props n %}<card>{{ later(n) }}{% slot %}fallback {{ n }}{% endslot %}</card>after",
			page: [
				'{% extends "layout" %}',
				'{% block body %}{% for n in 1..2 %}{% include "part" with { n } %}{% endfor %}',
				'{% component "card" with { n: 3 } %}{{ later("fill") }}{% endcomponent %}',
				'{% component "card" with { n: 4 } %}{% endcomponent %}{% endblock %}',
			].join(""),
		};
		const options = { functions: { later: async (value: unknown) => value } };
		const builder = createKiln({ ...options, loader: memoryLoader(templates) });
		const modules = Object.fromEntries(
			await Promise.all(
				Object.keys(templates).map(async (name) => [
					name,
					await loadModule(await builder.precompile(name)),
				]),
			),
		);
		// An async loader makes every include and component wait too.
		const precompiled = createKiln({
			...options,
			loader: {
				load: async (name) => modules[name.replace(/\.kiln$/, "")] ?? null,
			},
		});
		const expected =
			"<h1>t</h1>[0]|[1][2]<card>3fill</card>after<card>4fallback 4</card>after|end";
		expect(await builder.render("page")).toBe(expected);
		expect(await precompiled.render("page")).toBe(expected);
	});

	test("loops continue after passes that wait, with text around each wait", async () => {
		const templates = {
			page: '{% for n in 1..3 %}<{% include "part" with { n } %}|{% include "part" with { n: n * 10 } %}>{% if loop.last %}.{% endif %}{% endfor %}',
			part: "{% props n %}{{ later(n) }}",
		};
		const options = { functions: { later: async (value: unknown) => value } };
		const builder = createKiln({ ...options, loader: memoryLoader(templates) });
		const precompiled = createKiln({
			...options,
			loader: memoryLoader({
				page: await loadModule(await builder.precompile("page")),
				part: templates.part,
			}),
		});
		const expected = "<1|10><2|20><3|30>.";
		expect(await builder.render("page")).toBe(expected);
		expect(await precompiled.render("page")).toBe(expected);
	});

	test("includes named by a prefix and a key match the source", async () => {
		const templates = {
			"parts/a": "{% props n %}A{{ n }}",
			"parts/1": "one",
			"parts/c": "{% props n %}C{{ n }}{% slot %}{% endslot %}",
		};
		const page = [
			'{% for key in keys %}{% include "parts/" ~ key with { n: loop.index } ignore missing %}|{% endfor %}',
			'{% component "parts/" ~ "c" with { n: 9 } %}!{% endcomponent %}',
		].join("");
		const keys = ["a", 1, "missing", "a"];
		const result = await renderBoth(page, { keys }, { templates });
		expect(result.precompiled).toBe("A1|one||A4|C9!");
		expect(result.precompiled).toBe(result.source);
		const builder = createKiln({
			loader: memoryLoader({
				...templates,
				page: '{% include "parts/" ~ key %}',
			}),
		});
		const precompiled = createKiln({
			loader: memoryLoader({
				...templates,
				page: await loadModule(await builder.precompile("page")),
			}),
		});
		const code = (kiln: typeof builder) =>
			kiln.render("page", { key: "../../secret" }).then(
				() => "rendered",
				(error: { code?: string }) => error.code,
			);
		expect(await code(builder)).toBe("invalid-template-name");
		expect(await code(precompiled)).toBe("invalid-template-name");
	});

	test("templates a precompiled template includes are loaded again after invalidate", async () => {
		const page = '{% include "part" %}{% include "parts/" ~ key %}';
		const builder = createKiln({ loader: memoryLoader({ page }) });
		const module = await loadModule(await builder.precompile("page"));
		const sources: Record<string, unknown> = {
			"page.kiln": module,
			"part.kiln": "a1",
			"parts/b.kiln": "b1",
		};
		const kiln = createKiln({
			loader: {
				load: (name) => (sources[name] as string | undefined) ?? null,
			},
		});
		expect(await kiln.render("page", { key: "b" })).toBe("a1b1");
		sources["part.kiln"] = "a2";
		sources["parts/b.kiln"] = "b2";
		expect(await kiln.render("page", { key: "b" })).toBe("a1b1");
		kiln.invalidate("part");
		kiln.invalidate("parts/b");
		expect(await kiln.render("page", { key: "b" })).toBe("a2b2");
	});

	test("rejects a template with problems", async () => {
		const kiln = createKiln({ loader: memoryLoader({ page: "{% if %}" }) });
		await expect(kiln.precompile("page")).rejects.toBeInstanceOf(
			KilnSyntaxError,
		);
	});

	test("one loader can hold precompiled modules and source", async () => {
		const builder = createKiln({
			loader: memoryLoader({
				layout: "<main>{% block content %}{% endblock %}</main>",
			}),
		});
		const layout = await loadModule(await builder.precompile("layout"));
		const kiln = createKiln({
			loader: memoryLoader({
				layout,
				page: '{% extends "layout" %}{% block content %}{{ title }}{% endblock %}',
			}),
		});
		expect(await kiln.render("page", { title: "Hi" })).toBe("<main>Hi</main>");
		expect(await kiln.check("layout")).toEqual([]);
	});
});

describe("precompiled-mismatch", () => {
	const precompiled = async (
		source: string,
		options: Omit<KilnOptions, "loader"> = {},
	) => {
		const builder = createKiln({
			...options,
			loader: memoryLoader({ page: source }),
		});
		return loadModule(await builder.precompile("page"));
	};
	const errorCode = (kiln: ReturnType<typeof createKiln>) =>
		kiln.render("page").then(
			() => "rendered",
			(error: { code?: string }) => error.code,
		);

	test("another autoescape option", async () => {
		const module = await precompiled("{{ 1 }}");
		const kiln = createKiln({
			autoescape: false,
			loader: memoryLoader({ page: module }),
		});
		expect(await errorCode(kiln)).toBe("precompiled-mismatch");
	});

	test("a built-in the environment replaces", async () => {
		const module = await precompiled('{{ "a"|upper }}');
		const kiln = createKiln({
			filters: { upper: (value: string) => value },
			loader: memoryLoader({ page: module }),
		});
		expect(await errorCode(kiln)).toBe("precompiled-mismatch");
	});

	test("another version of Kiln", async () => {
		const module = { ...(await precompiled("{{ 1 }}")), kiln: 0 };
		const kiln = createKiln({ loader: memoryLoader({ page: module }) });
		expect(await errorCode(kiln)).toBe("precompiled-mismatch");
	});
});
