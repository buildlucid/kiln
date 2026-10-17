import { describe, expect, test, vi } from "vite-plus/test";
import { createKiln, memoryLoader } from "../../src/index.js";
import { errorCode, readParts, render, renderError } from "../helpers.js";

describe("maxSteps", () => {
	test("stops runaway loops", async () => {
		const template =
			"{% for i in 1..100 %}{% for j in 1..100 %}{% endfor %}{% endfor %}";
		expect(await errorCode(template, { limits: { maxSteps: 500 } })).toBe(
			"limit-steps",
		);
	});

	test("charges built-ins for the items they process", async () => {
		const template =
			"{% set a = 1..900000 %}{% for i in 1..10 %}{% set a = a|merge(a) %}{% endfor %}";
		expect(await errorCode(template)).toBe("limit-steps");
		expect(await errorCode("{{ [1]|batch(20000000, 0)|length }}")).toBe(
			"limit-steps",
		);
	});

	test("charges spreads for the items they copy", async () => {
		const doubling = "{% set list = [...list, ...list] %}".repeat(18);
		expect(
			await errorCode(`{% set list = [1] %}${doubling}`, {
				limits: { maxSteps: 1000 },
			}),
		).toBe("limit-steps");
		const growing =
			"{% set hash = {} %}{% for i in 1..200 %}{% set hash = { ...hash, (i): i } %}{% endfor %}";
		expect(await errorCode(growing, { limits: { maxSteps: 5000 } })).toBe(
			"limit-steps",
		);
	});

	test.each([
		"{{ max(items) }}",
		"{{ min(items) }}",
		"{{ -1 in items }}",
		"{{ generated|length }}",
		"{{ generated|first }}",
	])("charges searches and iterables for their items: %s", async (template) => {
		const items = Array.from({ length: 1000 }, (_, i) => i);
		const context = { items, generated: items.values() };
		expect(
			await errorCode(template, { context, limits: { maxSteps: 100 } }),
		).toBe("limit-steps");
	});

	test("charges includes for each variable they pass", async () => {
		const variables = Object.fromEntries(
			Array.from({ length: 100 }, (_, i) => [`v${i}`, i]),
		);
		expect(
			await errorCode('{% include "part" with variables %}', {
				templates: { part: "" },
				context: { variables },
				limits: { maxSteps: 50 },
			}),
		).toBe("limit-steps");
	});

	test("stops endless iterables from the host", async () => {
		function* endless() {
			for (let i = 0; ; i++) yield i;
		}
		expect(
			await errorCode("{{ items|length }}", { context: { items: endless() } }),
		).toBe("limit-steps");
	});
});

describe("maxOutputLength", () => {
	test("stops large output", async () => {
		expect(
			await errorCode("{% for i in 1..100 %}0123456789{% endfor %}", {
				limits: { maxOutputLength: 50 },
			}),
		).toBe("limit-output");
	});

	test("stops many long values printed together", async () => {
		const text = "x".repeat(1_000_000);
		expect(
			await errorCode("{{ text }}".repeat(600), { context: { text } }),
		).toBe("limit-output");
	});

	test("stops the escape filter once its text passes the limit, at the filter", async () => {
		const error = await renderError(
			'{% set y = s|escape("js")|escape("css") %}',
			{ context: { s: "<".repeat(50) }, limits: { maxOutputLength: 100 } },
		);
		expect(error).toMatchObject({ code: "limit-output", line: 1 });
		const url = await renderError('{{ s|escape("url") }}', {
			context: { s: "\uD800" },
		});
		expect(url).toMatchObject({ code: "invalid-argument", line: 1 });
	});

	test("stops at the value that passes the limit, before any later call", async () => {
		const done = vi.fn(() => "d");
		const error = await renderError('{% include "part" %}{{ x }}{{ done() }}', {
			context: { x: "ab" },
			functions: { done },
			templates: { part: "1234" },
			limits: { maxOutputLength: 5 },
		});
		expect(error).toMatchObject({ code: "limit-output", column: 21 });
		expect(done).not.toHaveBeenCalled();
	});

	test("stops strings that could never be printed", async () => {
		const template =
			'{% set s = "x" %}{% for i in 1..40 %}{% set s = s ~ s %}{% endfor %}';
		expect(await errorCode(template)).toBe("limit-output");
	});

	test("counts captured output once, when it is printed", async () => {
		const options = { limits: { maxOutputLength: 10 } };
		expect(await render("{% set x %}123456{% endset %}{{ x }}", options)).toBe(
			"123456",
		);
		const macros =
			"{% macro a() %}abcd{% endmacro %}{% macro b() %}{{ a() }}{% endmacro %}{% macro c() %}{{ b() }}{% endmacro %}{{ c() }}{{ c() }}";
		expect(await render(macros, options)).toBe("abcdabcd");
	});
});

describe("maxDepth", () => {
	test("stops recursive includes, macros and blocks", async () => {
		expect(await errorCode('{% include "index" %}')).toBe("limit-depth");
		expect(
			await errorCode("{% macro m() %}{{ m() }}{% endmacro %}{{ m() }}"),
		).toBe("limit-depth");
		expect(await errorCode('{% block a %}{{ block("a") }}{% endblock %}')).toBe(
			"limit-depth",
		);
	});
});

describe("other limits", () => {
	test("spreads into calls are capped, so pass the array instead", async () => {
		expect(
			await render("{{ [...(1..100000)]|length }}|{{ max(1..100000) }}"),
		).toBe("100000|100000");
		expect(await errorCode("{{ max(...(1..100000)) }}")).toBe(
			"too-many-arguments",
		);
	});

	test("stripTags stays fast on unclosed tags", async () => {
		const text = "<a".repeat(200_000) + "<!--".repeat(100_000);
		const started = performance.now();
		expect(
			await render("{{ text|stripTags|length }}", { context: { text } }),
		).toBe(String(text.length));
		expect(performance.now() - started).toBeLessThan(500);
	});
});

describe("abort signal", () => {
	test("an aborted signal stops the render before it starts", async () => {
		const controller = new AbortController();
		controller.abort();
		const kiln = createKiln({ loader: memoryLoader({ index: "x" }) });
		await expect(
			kiln.render("index", {}, { signal: controller.signal }),
		).rejects.toMatchObject({ code: "aborted" });
	});

	test("an abort stops the render between host calls", async () => {
		const controller = new AbortController();
		const slow = vi.fn(async (i: number) => {
			if (i === 2) controller.abort();
			return i;
		});
		const kiln = createKiln({
			loader: memoryLoader({
				index: "{% for i in 1..50 %}{{ slow(i) }}{% endfor %}",
			}),
			functions: { slow },
		});
		await expect(
			kiln.render("index", {}, { signal: controller.signal }),
		).rejects.toMatchObject({ code: "aborted" });
		expect(slow.mock.calls.length).toBeLessThan(5);
	});

	test("an abort during the last call stops the render", async () => {
		const kiln = (controller: AbortController) =>
			createKiln({
				loader: memoryLoader({ index: "a{{ last() }}b" }),
				functions: {
					last: async () => {
						controller.abort();
						return "x";
					},
				},
			});
		const rendering = new AbortController();
		await expect(
			kiln(rendering).render("index", {}, { signal: rendering.signal }),
		).rejects.toMatchObject({ code: "aborted" });
		const streaming = new AbortController();
		await expect(
			kiln(streaming)
				.renderStream("index", {}, { signal: streaming.signal })
				.then(readParts),
		).rejects.toMatchObject({ code: "aborted" });
	});

	test("an abort stops the render while it waits for a host call", async () => {
		const controller = new AbortController();
		const kiln = createKiln({
			loader: memoryLoader({ index: "a{{ never() }}b" }),
			functions: { never: () => new Promise(() => {}) },
		});
		const rendering = kiln.render("index", {}, { signal: controller.signal });
		controller.abort();
		await expect(rendering).rejects.toMatchObject({ code: "aborted" });
	});

	test("an abort from a function stops the calls after it", async () => {
		const controller = new AbortController();
		const done = vi.fn(() => "d");
		const cancel = async () => {
			controller.abort();
			return "c";
		};
		expect(
			await errorCode("{{ cancel() }}{{ done() }}", {
				functions: { cancel, done },
				signal: controller.signal,
			}),
		).toBe("aborted");
		expect(done).not.toHaveBeenCalled();
	});

	test("an abort from a getter in the data stops the calls after it", async () => {
		const controller = new AbortController();
		const done = vi.fn(() => "d");
		const data = {
			get stop() {
				controller.abort();
				return "s";
			},
		};
		expect(
			await errorCode("{{ data.stop }}{{ done() }}", {
				context: { data },
				functions: { done },
				signal: controller.signal,
			}),
		).toBe("aborted");
		expect(done).not.toHaveBeenCalled();
	});

	test("errors from limits are render errors", async () => {
		const error = await renderError("{% for i in 1..10 %}{% endfor %}", {
			limits: { maxSteps: 3 },
		});
		expect(error.name).toBe("KilnRenderError");
	});
});

describe("deep nesting", () => {
	test("long operator and filter chains are reported, not a stack overflow", async () => {
		expect(await render(`{{ 0${" + 1".repeat(800)} }}`)).toBe("800");
		expect(await errorCode(`{{ 0${" + 1".repeat(20_000)} }}`)).toBe("too-deep");
		expect(await errorCode(`{{ "a"${"|upper".repeat(10_000)} }}`)).toBe(
			"too-deep",
		);
		expect(await errorCode(`{{ a${".a".repeat(5_000)} ?? 1 }}`)).toBe(
			"too-deep",
		);
		expect(await errorCode(`{{ a${" ?? a".repeat(20_000)} }}`)).toBe(
			"too-deep",
		);
	});

	test("deeply nested string interpolation is reported", async () => {
		let text = "1";
		for (let i = 0; i < 10_000; i++) text = `"#{${text}}"`;
		expect(await errorCode(`{{ ${text} }}`)).toBe("too-deep");
	});

	test("many elseif branches are fine", async () => {
		expect(
			await render(
				`{% if false %}${"{% elseif false %}".repeat(5_000)}{% else %}e{% endif %}`,
			),
		).toBe("e");
	});

	test("deeply nested prop types are reported", async () => {
		expect(
			await errorCode(
				`{% props p: ${"(".repeat(20_000)}string${")".repeat(20_000)} %}`,
			),
		).toBe("too-deep");
		expect(await errorCode(`{% props p: string${"[]".repeat(20_000)} %}`)).toBe(
			"too-deep",
		);
	});

	test("deeply nested literals are reported", async () => {
		expect(
			await errorCode(`{{ ${"[".repeat(1000)}${"]".repeat(1000)}|length }}`),
		).toBe("too-deep");
	});
});
