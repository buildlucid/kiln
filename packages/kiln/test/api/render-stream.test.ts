import { describe, expect, test } from "vite-plus/test";
import { createKiln, KilnRenderError, type Loader } from "../../src/index.js";
import { lines, readParts, render, renderStream, settle } from "../helpers.js";

/** A host function that waits until the test calls `resolve`. */
const waiting = () => {
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	return { slow: () => promise, resolve, reject };
};

/** Reads the next part a stream sends, as text. */
const next = async (
	reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<string | null> => {
	const { done, value } = await reader.read();
	return done ? null : new TextDecoder().decode(value);
};

describe("renderStream", () => {
	test("sends the same HTML as render", async () => {
		const template = lines(
			"<head>",
			'	{% outlet "head" %}',
			"</head>",
			"{% flush %}",
			"<body>",
			"	{% for post in posts() %}",
			'		{% add to "end" once %}<script></script>{% endadd %}',
			"		<p>{{ post|upper }}</p>",
			"	{% endfor %}",
			'	{% outlet "end" %}',
			"</body>",
		);
		const options = {
			functions: { posts: async () => ["a", "b"] },
			filters: { upper: async (value: unknown) => String(value).toUpperCase() },
		};
		const parts = await readParts(await renderStream(template, options));
		expect(parts.join("")).toBe(await render(template, options));
	});

	test("sends a template that never waits in one part", async () => {
		expect(await readParts(await renderStream("<p>{{ 1 + 1 }}</p>"))).toEqual([
			"<p>2</p>",
		]);
	});

	test("sends what's ready while the render waits", async () => {
		const { slow, resolve } = waiting();
		const stream = await renderStream("<h1>Title</h1>{{ slow() }}<p>end</p>", {
			functions: { slow },
		});
		const reader = stream.getReader();
		expect(await next(reader)).toBe("<h1>Title</h1>");
		resolve("body");
		expect(await next(reader)).toBe("body<p>end</p>");
		expect(await next(reader)).toBeNull();
	});

	test("never splits a character between parts", async () => {
		const { slow, resolve } = waiting();
		const stream = await renderStream("{{ high|raw }}{{ slow()|raw }}", {
			functions: { slow },
			context: { high: "\ud83d" },
		});
		const reader = stream.getReader();
		resolve("\ude00!");
		expect(await next(reader)).toBe("😀!");
		expect(await next(reader)).toBeNull();
	});

	test("rejects when the render fails before anything is sent", async () => {
		const failing = renderStream("{% set page = load() %}<h1>{{ page }}</h1>", {
			functions: {
				load: async () => {
					throw new Error("Not found");
				},
			},
		});
		await expect(failing).rejects.toBeInstanceOf(KilnRenderError);
	});

	test("errors the stream when the render fails after a part is sent", async () => {
		const { slow, reject } = waiting();
		const stream = await renderStream("<h1>Title</h1>{{ slow() }}", {
			functions: { slow },
		});
		const reader = stream.getReader();
		expect(await next(reader)).toBe("<h1>Title</h1>");
		reject(new Error("Timed out"));
		await expect(reader.read()).rejects.toBeInstanceOf(KilnRenderError);
	});

	test("holds back output from an open outlet", async () => {
		const { slow, resolve } = waiting();
		const stream = await renderStream(
			'<head>{% outlet "head" %}</head>{{ slow() }}{% add to "head" %}<link>{% endadd %}',
			{ functions: { slow } },
		);
		const reader = stream.getReader();
		expect(await next(reader)).toBe("<head>");
		resolve("body");
		expect(await next(reader)).toBe("<link></head>body");
	});

	test("sends up to flush once its outlets close", async () => {
		const { slow, resolve } = waiting();
		const stream = await renderStream(
			'{% add to "head" %}<link>{% endadd %}<head>{% outlet "head" %}</head>{% flush %}<body>{{ slow() }}</body>',
			{ functions: { slow } },
		);
		const reader = stream.getReader();
		expect(await next(reader)).toBe("<head><link></head>");
		expect(await next(reader)).toBe("<body>");
		resolve("text");
		expect(await next(reader)).toBe("text</body>");
	});

	test("sends while waiting for the loader", async () => {
		const { promise, resolve } = Promise.withResolvers<string>();
		const loader: Loader = {
			load: (name) =>
				name === "page.kiln" ? '<h1></h1>{% include "late" %}' : promise,
		};
		const reader = (
			await createKiln({ loader }).renderStream("page")
		).getReader();
		expect(await next(reader)).toBe("<h1></h1>");
		resolve("<p>late</p>");
		expect(await next(reader)).toBe("<p>late</p>");
	});

	test("sends while waiting for the cache store", async () => {
		const { promise, resolve } = Promise.withResolvers<string | null>();
		const stream = await renderStream(
			'<h1></h1>{% cache "k" %}<p>fresh</p>{% endcache %}',
			{ cache: { get: () => promise, set: () => {} } },
		);
		const reader = stream.getReader();
		expect(await next(reader)).toBe("<h1></h1>");
		resolve(null);
		expect(await next(reader)).toBe("<p>fresh</p>");
	});

	test("counts the whole page against maxOutputLength", async () => {
		const failing = renderStream(
			'{% add to "a" %}0123456789{% endadd %}{% outlet "a" %}',
			{ limits: { maxOutputLength: 5 } },
		);
		await expect(failing).rejects.toMatchObject({ code: "limit-output" });
	});

	test("finishes the render after the stream is cancelled", async () => {
		const { slow, resolve } = waiting();
		let finished = false;
		const stream = await renderStream("<h1></h1>{{ slow() }}{{ done() }}", {
			functions: {
				slow,
				done: () => {
					finished = true;
					return "";
				},
			},
		});
		await stream.cancel();
		resolve("");
		await settle();
		expect(finished).toBe(true);
	});
});
