import { describe, expect, test, vi } from "vite-plus/test";
import { type KilnCache, memoryCache } from "../../src/index.js";
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

	test("adds the template, locale and time zone to the key, and passes for", async () => {
		const { cache, saved } = recording();
		await render('{% cache ["post", 1, true, null] for 600 %}x{% endcache %}', {
			cache,
		});
		await render('{% cache "post" %}y{% endcache %}', {
			cache,
			locale: "de",
			timeZone: "Europe/Berlin",
		});
		expect([...saved].map(([key, { seconds }]) => [key, seconds])).toEqual([
			['index.kiln|en|UTC|["post",1,true,null]', 600],
			['index.kiln|de|Europe/Berlin|["post"]', null],
		]);
	});

	test("dates in a key are written as ISO 8601", async () => {
		const { cache, saved } = recording();
		await render("{% cache at %}x{% endcache %}", {
			cache,
			context: { at: new Date(Date.UTC(2026, 9, 15)) },
		});
		expect([...saved.keys()]).toEqual([
			'index.kiln|en|UTC|["2026-10-15T00:00:00.000Z"]',
		]);
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
