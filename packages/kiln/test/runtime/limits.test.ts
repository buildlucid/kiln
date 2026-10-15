import { describe, expect, test, vi } from "vite-plus/test";
import { createKiln, memoryLoader } from "../../src/index.js";
import { errorCode, render, renderError } from "../helpers.js";

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
			await render("{{ [...(1..300000)]|length }}|{{ max(1..300000) }}"),
		).toBe("300000|300000");
		expect(await errorCode("{{ max(...(1..300000)) }}")).toBe(
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
	});

	test("many elseif branches are fine", async () => {
		expect(
			await render(
				`{% if false %}${"{% elseif false %}".repeat(5_000)}{% else %}e{% endif %}`,
			),
		).toBe("e");
	});

	test("deeply nested literals are reported", async () => {
		expect(
			await errorCode(`{{ ${"[".repeat(1000)}${"]".repeat(1000)}|length }}`),
		).toBe("too-deep");
	});
});
