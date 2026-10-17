import { describe, expect, test } from "vite-plus/test";
import { createKiln, KilnRenderError, memoryCache } from "../../src/index.js";
import { errorCode, later, lines, render, settle } from "../helpers.js";

describe("macro", () => {
	test("takes arguments with defaults and named arguments", async () => {
		const template = lines(
			'{% macro input(name, value = "", type = "text") %}',
			'<input type="{{ type }}" name="{{ name }}" value="{{ value }}">',
			"{%- endmacro %}",
			'{{ input("email", type: "email") }}',
		);
		expect(await render(template)).toBe(
			'<input type="email" name="email" value="">',
		);
	});

	test("missing arguments are null", async () => {
		expect(
			await render(
				"{% macro m(a, b) %}[{{ a }}|{{ b }}]{% endmacro %}{{ m(1) }}",
			),
		).toBe("[1|]");
	});

	test("sees only its arguments and globals", async () => {
		const template =
			'{% set outer = "o" %}{% macro m() %}{{ outer ?? "isolated" }}{{ site }}{% endmacro %}{{ m() }}';
		expect(await render(template, { globals: { site: "S" } })).toBe(
			"isolatedS",
		);
	});

	test("returns safe markup", async () => {
		expect(
			await render(
				'{% macro b(text) %}<b>{{ text }}</b>{% endmacro %}{{ b("<x>") }}',
			),
		).toBe("<b>&lt;x&gt;</b>");
	});

	test("can call itself and other macros in the same template", async () => {
		const template = lines(
			"{% macro count(n) %}{{ n }}{% if n > 1 %},{{ count(n - 1) }}{% endif %}{% endmacro %}",
			"{% macro wrap() %}[{{ count(2) }}]{% endmacro %}",
			"{{ wrap() }}",
		);
		expect(await render(template)).toBe(lines("", "", "[2,1]"));
	});

	test("can be used before it is defined", async () => {
		expect(
			await render(
				lines("{{ hello() }}", "{% macro hello() %}hi{% endmacro %}"),
			),
		).toBe("hi\n");
	});

	test("too many arguments is an error", async () => {
		expect(await errorCode("{% macro m(a) %}{% endmacro %}{{ m(1, 2) }}")).toBe(
			"too-many-arguments",
		);
	});

	test("an unknown named argument is an error", async () => {
		expect(await errorCode("{% macro m(a) %}{% endmacro %}{{ m(b: 1) }}")).toBe(
			"unknown-argument",
		);
	});

	test("cannot share a name with a function", async () => {
		expect(await errorCode("{% macro range() %}{% endmacro %}")).toBe(
			"macro-conflict",
		);
	});

	test("names must be unique", async () => {
		expect(
			await errorCode(
				"{% macro m() %}{% endmacro %}{% macro m() %}{% endmacro %}",
			),
		).toBe("duplicate-macro");
	});

	test("must be at the top level", async () => {
		expect(
			await errorCode("{% if true %}{% macro m() %}{% endmacro %}{% endif %}"),
		).toBe("invalid-macro-placement");
	});

	test("cannot recurse forever", async () => {
		const template =
			"{% macro down(n) %}{{ down(n + 1) }}{% endmacro %}{{ down(1) }}";
		expect(await errorCode(template, { limits: { maxDepth: 10 } })).toBe(
			"limit-depth",
		);
	});
});

describe("import and from", () => {
	const forms = lines(
		'{% macro input(name) %}<input name="{{ name }}">{% endmacro %}',
		"{% macro label(text) %}<label>{{ text }}</label>{% endmacro %}",
	);

	test("import gives a namespace, and from imports macros by name", async () => {
		const template = lines(
			'{% import "macros/forms" as forms %}',
			'{% from "macros/forms" import input, label as caption %}',
			'{{ forms.input("a") }}|{{ input("b") }}|{{ caption("c") }}',
		);
		expect(
			await render(template, { templates: { "macros/forms": forms } }),
		).toBe('<input name="a">|<input name="b">|<label>c</label>');
	});

	test("imports are visible in blocks, macros and before the import line", async () => {
		const template = lines(
			'{% extends "base" %}',
			'{% block body %}{{ f.say("block") }}{{ wrapper() }}{% endblock %}',
			'{% macro wrapper() %}{{ f.say("macro") }}{% endmacro %}',
			'{% import "lib" as f %}',
		);
		const templates = {
			base: "{% block body %}{% endblock %}",
			lib: "{% macro say(word) %}<{{ word }}>{% endmacro %}",
		};
		expect(await render(template, { templates })).toBe("<block><macro>");
	});

	test("imported macros use their own template's imports", async () => {
		const templates = {
			a: '{% import "b" as b %}{% macro outer() %}{{ b.inner() }}{% endmacro %}',
			b: "{% macro inner() %}inner{% endmacro %}",
		};
		expect(
			await render('{% from "a" import outer %}{{ outer() }}', { templates }),
		).toBe("inner");
	});

	test("imports are not inherited by child templates", async () => {
		const templates = {
			base: '{% import "lib" as lib %}{% block body %}{% endblock %}',
			lib: "{% macro say() %}hi{% endmacro %}",
		};
		const template = lines(
			'{% extends "base" %}',
			"{% block body %}{{ lib.say() }}{% endblock %}",
		);
		expect(await errorCode(template, { templates })).toBe("undefined-variable");
	});

	test("an unknown macro is an error", async () => {
		const templates = { lib: "{% macro say() %}hi{% endmacro %}" };
		expect(
			await errorCode('{% import "lib" as lib %}{{ lib.nope() }}', {
				templates,
			}),
		).toBe("unknown-macro");
	});

	test("a missing template is an error", async () => {
		expect(await errorCode('{% import "nope" as lib %}{{ lib.x() }}')).toBe(
			"missing-template",
		);
	});

	test("an alias cannot share a name with a function", async () => {
		expect(
			await errorCode('{% import "lib" as range %}', {
				templates: { lib: "" },
			}),
		).toBe("macro-conflict");
	});

	test("a from alias cannot share a name with a function", async () => {
		const templates = { lib: "{% macro m() %}{% endmacro %}" };
		expect(
			await errorCode('{% from "lib" import m as range %}', { templates }),
		).toBe("macro-conflict");
	});

	test("a failing import leaves no unhandled rejection from one still loading", async () => {
		const kiln = createKiln({
			loader: {
				load: (name) => {
					if (name === "index.kiln") {
						return '{% import "slow" as a %}{% import "broken" as b %}';
					}
					if (name === "slow.kiln") return Promise.reject(new Error("slow"));
					throw new Error("broken");
				},
			},
		});
		await expect(kiln.render("index")).rejects.toThrow(KilnRenderError);
		await settle();
	});
});

describe("arguments", () => {
	test("parameter names cannot repeat or be reserved", async () => {
		expect(await errorCode("{% macro m(a, a) %}{% endmacro %}")).toBe(
			"duplicate-parameter",
		);
		expect(await errorCode("{% macro m(loop) %}{% endmacro %}")).toBe(
			"reserved-name",
		);
	});

	test("an argument cannot be passed by position and by name", async () => {
		expect(
			await errorCode("{% macro m(a) %}{% endmacro %}{{ m(1, a: 2) }}"),
		).toBe("duplicate-argument");
	});

	test("markup from one macro passed to another is not escaped again", async () => {
		const template =
			"{% macro br() %}<br>{% endmacro %}{% macro wrap(x) %}[{{ x }}]{% endmacro %}{{ wrap(br()) }}";
		expect(await render(template)).toBe("[<br>]");
	});
});

describe("names and scope", () => {
	test("a macro can share a name with a filter", async () => {
		expect(
			await render(
				'{% macro upper(s) %}U{% endmacro %}{{ upper("x") }}{{ "x"|upper }}',
			),
		).toBe("UX");
	});

	test("a macro cannot see the caller's loop", async () => {
		expect(
			await errorCode(
				"{% macro m() %}{{ loop.index }}{% endmacro %}{% for x in [1] %}{{ m() }}{% endfor %}",
			),
		).toBe("undefined-variable");
	});

	test("templates can import each other", async () => {
		const templates = {
			a: '{% import "b" as b %}{% macro x() %}X{% endmacro %}',
			b: '{% import "a" as a %}{% macro y() %}Y{% endmacro %}',
		};
		expect(
			await render('{% from "a" import x %}{{ x() }}', { templates }),
		).toBe("X");
	});

	test("an alias can only be imported once", async () => {
		expect(
			await errorCode('{% import "a" as f %}{% import "b" as f %}', {
				templates: { a: "", b: "" },
			}),
		).toBe("duplicate-import");
	});

	test("a default that is a promise in globals is not awaited", async () => {
		expect(
			await render("{% macro m(a = p) %}{{ a|json }}{% endmacro %}{{ m() }}", {
				globals: { p: Promise.resolve("P") },
			}),
		).toBe("{}");
	});

	describe("rendering alongside each other", () => {
		// Each call waits `i` milliseconds, so the first call finishes last.
		const functions = { later };
		const calls = "{{ [30, 1]|map(i => m(i))|join }}";

		test("add to outlets in the template's order", async () => {
			const template = `{% macro m(i) %}{{ later(i, i) }}{% add to "h" %}[{{ i }}]{% endadd %}{% endmacro %}<h>{% outlet "h" %}</h>${calls}`;
			expect(await render(template, { functions })).toBe("<h>[30][1]</h>301");
		});

		test("cached sections save only what they add", async () => {
			const cache = memoryCache();
			const template = `{% macro m(i) %}{% cache ["m", i] %}{{ later(i, i) }}{% add to "h" %}[{{ i }}]{% endadd %}{% endcache %}{% endmacro %}<h>{% outlet "h" %}</h>${calls}`;
			expect(await render(template, { functions, cache })).toBe(
				"<h>[30][1]</h>301",
			);
			expect(await render(template, { functions, cache })).toBe(
				"<h>[30][1]</h>301",
			);
		});

		test("cached sections leave fills free to change variables afterwards", async () => {
			const template = `{% macro m(i) %}{% cache ["m", i] %}{{ later(i, i) }}{% endcache %}{% endmacro %}{{ [1, 30]|map(i => m(i))|join }} {% set n = 1 %}{% component "c" %}{% set n = n + 1 %}{% endcomponent %}{{ n }}`;
			expect(
				await render(template, {
					functions,
					templates: { c: "{% slot %}{% endslot %}" },
				}),
			).toBe("130 2");
		});
	});
});
