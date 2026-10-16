import { describe, expect, test } from "vite-plus/test";
import { errorCode, later, render, settle } from "../helpers.js";

const functions = { later };

describe("async calls", () => {
	test("are awaited where they are called", async () => {
		const template =
			'{% set a = later("A", 20) %}{% set b = later("B") %}{{ a }}{{ b }}{{ later("C")|lower }}';
		expect(await render(template, { functions })).toBe("ABc");
	});

	test("output keeps template order when promises settle in another order", async () => {
		const template =
			'{% for item in [30, 1, 15] %}{{ later(item, item) }};{% endfor %}{{ [later(2, 5), later(1)]|join(",") }}';
		expect(await render(template, { functions })).toBe("30;1;15;2,1");
	});

	test("work inside arrow functions", async () => {
		const template =
			'{{ [1, 2]|map(n => later(n * 2))|join(",") }}|{{ [1, 2, 3]|filter(n => later(n > 1))|join(",") }}|{{ [1, 2]|reduce((s, n) => later(s + n), 0) }}|{{ [1, 2]|find(n => later(n == 2)) }}';
		expect(await render(template, { functions })).toBe("2,4|2,3|3|2");
	});

	test("work in conditions, loops, includes and macros", async () => {
		const template =
			'{% macro m(v) %}<{{ later(v) }}>{% endmacro %}{% if later(true) %}{% for x in later([1, 2]) %}{{ m(x) }}{% endfor %}{% endif %}{% include later("part") with { v: later("p") } %}';
		expect(
			await render(template, { functions, templates: { part: "[{{ v }}]" } }),
		).toBe("<1><2>[p]");
	});

	test("work in blocks and parent()", async () => {
		const template =
			'{% extends "base" %}\n{% block b %}{{ later("child") }}+{{ parent() }}{% endblock %}';
		expect(
			await render(template, {
				functions,
				templates: { base: '{% block b %}{{ later("base") }}{% endblock %}' },
			}),
		).toBe("child+base");
	});

	test("work in strings, hashes, arrays and conditionals", async () => {
		const template =
			'{{ "#{ later("a") }-#{ later("b") }" }}|{{ { k: later("v") }.k }}|{{ [later(1), 2]|join }}|{{ later(false) ? "y" : later("n") }}|{{ later(null) ?? later("d") }}';
		expect(await render(template, { functions })).toBe("a-b|v|12|n|d");
	});

	test("thenables from host functions are awaited", async () => {
		const query = {
			// A query-builder-style thenable that is not a promise.
			// oxlint-disable-next-line unicorn/no-thenable -- the thenable is what this test checks
			then: (resolve: (value: string) => void) => resolve("rows"),
		};
		expect(
			await render("{{ load() }}", { functions: { load: () => query } }),
		).toBe("rows");
	});

	test("sort callbacks must be synchronous", async () => {
		expect(
			await errorCode("{{ [2, 1]|sort(n => later(n))|join }}", { functions }),
		).toBe("invalid-argument");
	});
});

describe("failures", () => {
	test("a host error stops the render", async () => {
		const explode = () => {
			throw new Error("boom");
		};
		expect(await errorCode("{{ explode() }}", { functions: { explode } })).toBe(
			"host-error",
		);
	});

	test("failing async siblings leave no unhandled rejections", async () => {
		const functions = {
			fail: async () => {
				throw new Error("async failure");
			},
			explode: () => {
				throw new Error("sync failure");
			},
		};
		expect(
			await errorCode("{{ [fail(), fail(), explode()]|join }}", { functions }),
		).toBe("host-error");
		await settle();
	});

	test("a failing callback leaves no unhandled rejections", async () => {
		const functions = {
			reject: async () => {
				throw new Error("rejected");
			},
		};
		expect(
			await errorCode(
				"{{ [1, 2]|map(i => i == 2 ? 'a' + 1 : reject(i))|join }}",
				{ functions },
			),
		).toBe("type-error");
		await settle();
	});
});

describe("guards and short-circuits", () => {
	test("?? does not swallow a host error", async () => {
		const explode = () => {
			throw new Error("x");
		};
		expect(
			await errorCode('{{ explode() ?? "fallback" }}', {
				functions: { explode },
			}),
		).toBe("host-error");
	});

	test("and waits for its left side before deciding", async () => {
		const explode = () => {
			throw new Error("x");
		};
		expect(
			await render("{{ later(false) and explode() }}", {
				functions: { later, explode },
			}),
		).toBe("false");
	});

	test("captures, apply and attrs wait for async values", async () => {
		const template =
			'{% set x %}{{ later("a") }}{% endset %}{% apply upper %}{{ later("b") }}{% endapply %}{{ x }}<a{{ attrs({ href: later("/x") }) }}>';
		expect(await render(template, { functions })).toBe('Ba<a href="/x">');
	});

	test("promises in the context are values, and are not awaited", async () => {
		const context = { value: Promise.resolve(false) };
		expect(
			await render(
				'{% set x = value %}{{ x|json }}|{% if value %}yes{% endif %}|{{ false or value ? "t" : "f" }}',
				{ context },
			),
		).toBe("{}|yes|t");
		expect(
			await errorCode("{% for x in value %}{% endfor %}", { context }),
		).toBe("not-iterable");
	});

	test("properties of a promise in the context cannot be read", async () => {
		expect(
			await errorCode("{{ p.then }}", { context: { p: Promise.resolve(1) } }),
		).toBe("missing-property");
	});
});
