import { describe, expect, test, vi } from "vite-plus/test";
import {
	createKiln,
	type KilnCache,
	memoryCache,
	memoryLoader,
	withRender,
} from "../../src/index.js";
import { errorCode, lines, render, renderError, settle } from "../helpers.js";

/** A store that records what it saves. */
const recording = () => {
	const saved = new Map<string, { value: string; seconds: number | null }>();
	const cache: KilnCache = {
		get: ({ key }) => saved.get(key)?.value ?? null,
		set: ({ key, value, seconds }) => {
			saved.set(key, { value, seconds });
		},
	};
	return { cache, saved };
};

describe("cache", () => {
	test("renders its content every time without a store", async () => {
		const template = '{% cache "a" %}{{ n }}{% endcache %}';
		expect(await render(template, { context: { n: 1 } })).toBe("1");
		expect(await render(template, { context: { n: 2 } })).toBe("2");
	});

	test("reuses the saved copy for the same key", async () => {
		const cache = memoryCache();
		const template = '{% cache "a" %}{{ n }}{% endcache %}';
		expect(await render(template, { cache, context: { n: 1 } })).toBe("1");
		expect(await render(template, { cache, context: { n: 2 } })).toBe("1");
	});

	test("renders again when the key changes", async () => {
		const cache = memoryCache();
		const template = '{% cache ["post", version] %}{{ version }}{% endcache %}';
		expect(await render(template, { cache, context: { version: 1 } })).toBe(
			"1",
		);
		expect(await render(template, { cache, context: { version: 2 } })).toBe(
			"2",
		);
	});

	test("adds the template, a hash of its content, locale and time zone to the key, and passes for", async () => {
		const { cache, saved } = recording();
		await render('{% cache ["post", 1, true, null] for 600 %}x{% endcache %}', {
			cache,
		});
		await render('{% cache "post" %}y{% endcache %}', {
			cache,
			locale: "de",
			timeZone: "Europe/Berlin",
		});
		const [first, second] = [...saved];
		expect(first?.[0]).toMatch(
			/^""\|index\.kiln\|\w+\|en\|UTC\|\["post",1,true,null\]$/,
		);
		expect(first?.[1].seconds).toBe(600);
		expect(second?.[0]).toMatch(
			/^""\|index\.kiln\|\w+\|de\|Europe\/Berlin\|\["post"\]$/,
		);
		expect(second?.[1].seconds).toBeNull();
	});

	test("editing the content gives the tag new keys", async () => {
		const cache = memoryCache();
		expect(await render('{% cache "a" %}old{% endcache %}', { cache })).toBe(
			"old",
		);
		expect(await render('{% cache "a" %}new{% endcache %}', { cache })).toBe(
			"new",
		);
	});

	test("a deployment namespace separates saved output when an included template changes", async () => {
		const cache = memoryCache();
		const template = '{% cache "footer" %}{% include "footer" %}{% endcache %}';
		expect(
			await render(template, {
				cache,
				cacheNamespace: "site:build-1",
				templates: { footer: "old" },
			}),
		).toBe("old");
		expect(
			await render(template, {
				cache,
				cacheNamespace: "site:build-1",
				templates: { footer: "new" },
			}),
		).toBe("old");
		expect(
			await render(template, {
				cache,
				cacheNamespace: "site:build-2",
				templates: { footer: "new" },
			}),
		).toBe("new");
	});

	// Delimiters inside a namespace must never turn it into another key's prefix.
	test("namespaces are encoded as whole strings", async () => {
		const { cache, saved } = recording();
		await render('{% cache "a" %}x{% endcache %}', {
			cache,
			cacheNamespace: 'a|"b',
		});
		expect([...saved.keys()][0]?.startsWith(JSON.stringify('a|"b') + "|")).toBe(
			true,
		);
	});

	test("tags in one template with the same key share copies only when their content is the same", async () => {
		const cache = memoryCache();
		const template =
			'{% cache "a" %}1{% endcache %}{% cache "a" %}2{% endcache %}{% cache "a" %}1{% endcache %}';
		expect(await render(template, { cache })).toBe("121");
	});

	test("dates in a key are written as ISO 8601", async () => {
		const { cache, saved } = recording();
		await render("{% cache at %}x{% endcache %}", {
			cache,
			context: { at: new Date(Date.UTC(2026, 9, 15)) },
		});
		expect([...saved.keys()][0]).toMatch(/\|\["2026-10-15T00:00:00\.000Z"\]$/);
	});

	test("works with a store that returns promises", async () => {
		const saved = new Map<string, string>();
		const cache: KilnCache = {
			get: async ({ key }) => saved.get(key),
			set: async ({ key, value }) => {
				saved.set(key, value);
			},
		};
		const template = '{% cache "a" %}{{ n }}{% endcache %}';
		expect(await render(template, { cache, context: { n: 1 } })).toBe("1");
		expect(await render(template, { cache, context: { n: 2 } })).toBe("1");
	});

	test("a failing time leaves no unhandled rejection from its key", async () => {
		const functions = {
			key: () => Promise.reject(new Error("key")),
			time: () => {
				throw new Error("time");
			},
		};
		const template = "{% cache key() for time() %}x{% endcache %}";
		expect(await errorCode(template, { cache: memoryCache(), functions })).toBe(
			"host-error",
		);
		await settle();
	});

	test.each([
		["get", "sync"],
		["get", "async"],
		["set", "sync"],
		["set", "async"],
	])("a failing store's %s (%s) is a located error", async (method, kind) => {
		const cause = new Error("down");
		const fail = () => {
			if (kind === "async") return Promise.reject(cause);
			throw cause;
		};
		const cache: KilnCache = {
			get: method === "get" ? fail : () => null,
			set: method === "set" ? fail : () => {},
		};
		const error = await renderError('{% cache "a" %}x{% endcache %}', {
			cache,
		});
		expect(error).toMatchObject({
			code: "host-error",
			message: expect.stringContaining("The cache store threw an error: down"),
			line: 1,
			cause,
		});
	});

	test("a value Kiln didn't make is treated as missing", async () => {
		const cache: KilnCache = { get: () => "<p>old</p>", set: () => {} };
		expect(await render('{% cache "a" %}new{% endcache %}', { cache })).toBe(
			"new",
		);
	});

	test("a saved copy keeps the indentation it was rendered with", async () => {
		const cache = memoryCache();
		const template = lines(
			"<ul>",
			'	{% cache "list" %}',
			"		{% for item in items %}",
			"			<li>{{ item }}</li>",
			"		{% endfor %}",
			"	{% endcache %}",
			"</ul>",
		);
		const options = { cache, context: { items: ["a", "b"] } };
		const first = await render(template, options);
		expect(first).toBe(lines("<ul>", "	<li>a</li>", "	<li>b</li>", "</ul>"));
		expect(await render(template, options)).toBe(first);
	});

	test("saves what the section adds to outlets, and adds it again", async () => {
		const cache = memoryCache();
		const templates = {
			card: '{% add to "head" once %}<link>{% endadd %}<p>{{ n }}</p>',
		};
		const template =
			'<head>{% outlet "head" %}</head>{% cache "cards" %}{% include "card" with { n } %}{% include "card" with { n } %}{% endcache %}';
		const first = await render(template, {
			cache,
			templates,
			context: { n: 1 },
		});
		expect(first).toBe("<head><link></head><p>1</p><p>1</p>");
		expect(
			await render(template, { cache, templates, context: { n: 2 } }),
		).toBe(first);
	});

	test("variables set inside stay inside", async () => {
		const template =
			'{% set x = "out" %}{% cache "a" %}{% set x = "in" %}{{ x }}{% endcache %}{{ x }}';
		expect(await render(template, { cache: memoryCache() })).toBe("inout");
	});

	test("variables set by blocks and fills inside stay inside", async () => {
		const templates = {
			base: '{% set n = 0 %}{% cache "a" %}{% block b %}{% endblock %}{% endcache %}|{{ n }}',
			child:
				'{% extends "base" %}{% block b %}{% set n = 1 %}{{ n }}{% endblock %}',
			called:
				'{% set n = 0 %}{% cache "b" %}{{ block("b") }}{% endcache %}|{{ n }}{% if false %}{% block b %}{% set n = 1 %}{{ n }}{% endblock %}{% endif %}',
			box: '{% cache "c" %}{% slot %}{% endslot %}{% endcache %}',
			filled:
				'{% set n = 0 %}{% component "box" %}{% set n = 1 %}{{ n }}{% endcomponent %}|{{ n }}',
		};
		const cache = memoryCache();
		for (const name of ["child", "called", "filled"]) {
			const template = `{% include "${name}" %}`;
			expect(await render(template, { cache, templates })).toBe("1|0");
			expect(await render(template, { cache, templates })).toBe("1|0");
		}
	});

	test("globals still can't be set inside", async () => {
		expect(
			await errorCode('{% cache "a" %}{% set site = 1 %}{% endcache %}', {
				globals: { site: 0 },
			}),
		).toBe("assign-global");
	});

	test("saves nothing when the content fails", async () => {
		const set = vi.fn();
		const cache: KilnCache = { get: () => null, set };
		expect(
			await errorCode('{% cache "a" %}{{ missing }}{% endcache %}', { cache }),
		).toBe("undefined-variable");
		expect(set).not.toHaveBeenCalled();
	});

	test("a key must be made of strings, numbers, booleans, dates and null", async () => {
		expect(await errorCode("{% cache { a: 1 } %}{% endcache %}")).toBe(
			"type-error",
		);
		expect(await errorCode('{% cache ["a", [1]] %}{% endcache %}')).toBe(
			"type-error",
		);
	});

	test("for must be a number of seconds above 0", async () => {
		expect(await errorCode('{% cache "a" for 0 %}{% endcache %}')).toBe(
			"invalid-argument",
		);
		expect(await errorCode('{% cache "a" for "1h" %}{% endcache %}')).toBe(
			"invalid-argument",
		);
	});

	test("needs a key and an endcache", async () => {
		expect(await errorCode("{% cache %}{% endcache %}")).toBe(
			"unexpected-token",
		);
		expect(await errorCode('{% cache "a" %}')).toBe("unclosed-block");
	});
});

describe("cache tags", () => {
	/** A function that tags the section it runs in with its collection, as a host's data function would. */
	const functions = {
		documents: withRender((render, collection: string) => {
			render.tagCache(`collection:${collection}`);
			return collection;
		}),
	};

	/** A store that records each section's tags, by the key the template gave. */
	const tagged = () => {
		const values = new Map<string, string>();
		const tags = new Map<string, string[]>();
		const cache: KilnCache = {
			get: ({ key }) => values.get(key) ?? null,
			set: ({ key, value, tags: saved }) => {
				values.set(key, value);
				tags.set(key.slice(key.lastIndexOf("|") + 1), saved);
			},
		};
		return { cache, tags };
	};

	test("passes a section's tags to the store, sorted and once each", async () => {
		const { cache, tags } = tagged();
		const output = await render(
			'{% cache "a" %}{{ documents("pages") }}{{ documents("menus") }}{% include "part" %}{{ documents("pages") }}{% endcache %}{{ documents("posts") }}',
			{ cache, functions, templates: { part: '{{ documents("blocks") }}' } },
		);
		expect(output).toBe("pagesmenusblockspagesposts");
		expect(tags.get('["a"]')).toEqual([
			"collection:blocks",
			"collection:menus",
			"collection:pages",
		]);
	});

	test("gives the store the render's state, so it can read and save per request", async () => {
		type SiteState = { request: string };
		const seen: string[] = [];
		const kiln = createKiln<SiteState>({
			loader: memoryLoader({ index: '{% cache "a" %}x{% endcache %}' }),
			cache: {
				get: ({ state }) => {
					seen.push(`get:${state.request}`);
					return null;
				},
				set: ({ state }) => {
					seen.push(`set:${state.request}`);
				},
			},
		});
		await kiln.render("index", {}, { state: { request: "1" } });
		await kiln.render("index", {}, { state: { request: "2" } });
		expect(seen).toEqual(["get:1", "set:1", "get:2", "set:2"]);
	});

	test("gives a section the tags of sections inside it, rendered or saved", async () => {
		const { cache, tags } = tagged();
		const template =
			'{% cache ["outer", v] %}{% cache "inner" %}{{ documents("pages") }}{% endcache %}{{ documents("menus") }}{% endcache %}';
		await render(template, { cache, functions, context: { v: 1 } });
		expect(tags.get('["inner"]')).toEqual(["collection:pages"]);
		expect(tags.get('["outer",1]')).toEqual([
			"collection:menus",
			"collection:pages",
		]);
		// The inner section comes from the store this time, and still tags the outer one.
		await render(template, { cache, functions, context: { v: 2 } });
		expect(tags.get('["outer",2]')).toEqual([
			"collection:menus",
			"collection:pages",
		]);
	});

	test("keeps the tags of sections that render at the same time apart", async () => {
		const { cache, tags } = tagged();
		const slow = withRender(async (render, collection: string, ms: number) => {
			render.tagCache(`collection:${collection}`);
			await new Promise((resolve) => setTimeout(resolve, ms));
			render.tagCache(`late:${collection}`);
			return collection;
		});
		const output = await render(
			'{% cache "a" %}{{ slow("pages", 20) }}{% endcache %}{% cache "b" %}{{ slow("menus", 1) }}{% endcache %}',
			{ cache, functions: { slow } },
		);
		expect(output).toBe("pagesmenus");
		expect(tags.get('["a"]')).toEqual(["collection:pages", "late:pages"]);
		expect(tags.get('["b"]')).toEqual(["collection:menus", "late:menus"]);
	});

	test("memoryCache clears the copies with a tag", async () => {
		const cache = memoryCache();
		const template =
			'{% cache "a" %}{{ documents("pages") }}{{ n }}{% endcache %}';
		const run = (n: number) =>
			render(template, { cache, functions, context: { n } });
		expect(await run(1)).toBe("pages1");
		cache.clear({ tags: ["collection:menus"] });
		expect(await run(2)).toBe("pages1");
		cache.clear({ tags: ["collection:pages"] });
		expect(await run(3)).toBe("pages3");
	});

	test("tags must be strings", async () => {
		const tagNumber = withRender((render) => {
			render.tagCache(1 as unknown as string);
			return "";
		});
		expect(
			await errorCode('{% cache "a" %}{{ tagNumber() }}{% endcache %}', {
				cache: memoryCache(),
				functions: { tagNumber },
			}),
		).toBe("host-error");
	});
});
