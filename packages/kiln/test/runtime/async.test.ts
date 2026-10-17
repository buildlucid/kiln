import { describe, expect, test } from "vite-plus/test";
import {
	deferIslands,
	islandScript,
	KilnRenderError,
	memoryCache,
} from "../../src/index.js";
import {
	errorCode,
	later,
	lines,
	readParts,
	render,
	renderError,
	renderStream,
	settle,
} from "../helpers.js";

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

	test.each(["map", "filter"])(
		"%s starts all callbacks without the statement concurrency cap",
		async (filter) => {
			const barrier = Promise.withResolvers<void>();
			let active = 0;
			let most = 0;
			const load = (value: number) => {
				active++;
				most = Math.max(most, active);
				if (active === 100) barrier.resolve();
				return barrier.promise.then(() => {
					active--;
					return value;
				});
			};
			expect(
				await render(`{{ (1..100)|${filter}(n => load(n))|length }}`, {
					functions: { load },
				}),
			).toBe("100");
			expect(most).toBe(100);
			expect(active).toBe(0);
		},
	);

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

	test("promises in the context are not awaited next to calls that wait", async () => {
		const p = Promise.resolve("P");
		const options = {
			context: { p },
			functions: {
				later,
				pair: (a: unknown, b: unknown) => `${String(a)}${String(b)}`,
				holder: () => later({ p }),
			},
		};
		expect(await render('{{ pair(p, later("S")) }}', options)).toBe(
			"[object Promise]S",
		);
		expect(await errorCode('{{ p ~ later("S") }}', options)).toBe(
			"not-printable",
		);
		expect(await errorCode("{{ holder().p }}", options)).toBe("not-printable");
		expect(await errorCode("{{ later(null) ?? p }}", options)).toBe(
			"not-printable",
		);
	});

	test("a filter's input and arguments start before either is waited for", async () => {
		const started: string[] = [];
		// Resolves to the calls started by the time it settles.
		const track = (name: string) => {
			started.push(name);
			return later(null, 5).then(() => started.join(","));
		};
		const glue = (a: unknown, b: unknown) => `${String(a)}|${String(b)}`;
		expect(
			await render('{{ track("in")|glue(track("arg")) }}', {
				functions: { track },
				filters: { glue },
			}),
		).toBe("in,arg|in,arg");
	});

	test("an arrow function that waits never calls then on a value it returns", async () => {
		let called = false;
		const thing = {
			// oxlint-disable-next-line unicorn/no-thenable -- the thenable is what this test checks
			then: (resolve: (value: string) => void) => {
				called = true;
				resolve("adopted");
			},
		};
		const callIt = async (fn: () => Promise<unknown>) => {
			await fn();
			return "ok";
		};
		expect(
			await render("{{ callIt(() => later(null) ?? thing) }}", {
				context: { thing },
				functions: { later, callIt },
			}),
		).toBe("ok");
		expect(called).toBe(false);
	});

	test("properties of a promise in the context cannot be read", async () => {
		expect(
			await errorCode("{{ p.then }}", { context: { p: Promise.resolve(1) } }),
		).toBe("missing-property");
	});
});

/**
 * A host function that resolves to `value` after `ms` milliseconds, and records how many of its calls wait at once
 * and in what order they started.
 */
const tracked = () => {
	const calls = { active: 0, most: 0, started: [] as string[] };
	const load = async <T>(value: T, ms = 1): Promise<T> => {
		calls.active++;
		calls.most = Math.max(calls.most, calls.active);
		calls.started.push(String(value));
		await later(null, ms);
		calls.active--;
		return value;
	};
	return { calls, load };
};

describe("running at the same time", () => {
	test("independent sets wait at the same time", async () => {
		const { calls, load } = tracked();
		const template =
			'{% set a = load("a", 10) %}{% set b = load("b") %}{{ a }}{{ b }}';
		expect(await render(template, { functions: { load } })).toBe("ab");
		expect(calls.most).toBe(2);
	});

	test("a part that reads what an earlier one sets waits for it", async () => {
		const { calls, load } = tracked();
		const template = "{% set a = load(1) %}{% set b = load(a + 1) %}{{ b }}";
		expect(await render(template, { functions: { load } })).toBe("2");
		expect(calls.most).toBe(1);
	});

	test("parts after the ones that wait for a part start at once", async () => {
		const { calls, load } = tracked();
		const template = lines(
			'{% set posts = load(["p1", "p2"], 10) %}',
			"{% for post in posts %}{{ load(post) }} {% endfor %}",
			'{{ load("categories") }}',
		);
		expect(await render(template, { functions: { load } })).toBe(
			lines("p1 p2 ", "categories"),
		);
		expect(calls.started.slice(0, 2)).toEqual(["p1,p2", "categories"]);
	});

	test("a loop's items wait at the same time, and print in order", async () => {
		const { calls, load } = tracked();
		const template =
			"{% for n in [30, 1, 15] %}{% set item = load(n, n) %}[{{ item }}]{% endfor %}";
		expect(await render(template, { functions: { load } })).toBe("[30][1][15]");
		expect(calls.most).toBe(3);
	});

	test("items of a loop that sets nothing keep their own variables", async () => {
		const template =
			"{% for n in [20, 1] %}{{ later(n, n) }}-{{ n }};{% endfor %}";
		expect(await render(template, { functions: { later } })).toBe("20-20;1-1;");
	});

	test("a loop that sets a variable from outside it runs its items in turn", async () => {
		const { calls, load } = tracked();
		const template =
			"{% set total = 0 %}{% for n in [1, 2, 3] %}{% set total = total + load(n) %}{% endfor %}{{ total }}";
		expect(await render(template, { functions: { load } })).toBe("6");
		expect(calls.most).toBe(1);
	});

	test("a block waits for earlier parts that set a variable", async () => {
		const template =
			'{% set v = later("late", 10) %}{% block b %}{{ v }}{% endblock %}';
		expect(await render(template, { functions: { later } })).toBe("late");
	});

	test("up to 64 parts run early at once", async () => {
		const { calls, load } = tracked();
		const template =
			"{% for n in 1..100 %}{% set v = load(n) %}{{ v }}{% endfor %}";
		const expected = Array.from({ length: 100 }, (_, i) => i + 1).join("");
		expect(await render(template, { functions: { load } })).toBe(expected);
		expect(calls.most).toBe(65);
	});

	test("indentation is the same as when parts wait their turn", async () => {
		const template = lines(
			"<ul>",
			'\t{% include "a" %}',
			'\t{% include "b" %}',
			"</ul>",
		);
		const templates = {
			a: lines("<li>{{ later('a', 10) }}</li>", "<li>a2</li>", ""),
			b: lines("<li>{{ later('b') }}</li>", "<li>b2</li>", ""),
		};
		expect(await render(template, { functions: { later }, templates })).toBe(
			lines(
				"<ul>",
				"\t<li>a</li>",
				"\t<li>a2</li>",
				"\t<li>b</li>",
				"\t<li>b2</li>",
				"</ul>",
			),
		);
	});

	test("parts that depend on a part run once, after it", async () => {
		const { calls, load } = tracked();
		const template = lines(
			'{% extends "layout" %}',
			'{% block content %}{% set page = load({ title: "Hi" }, 10) %}<h1>{{ page.title }}</h1>{{ load("rel") }}{% endblock %}',
		);
		const templates = {
			layout: "<main>{% block content %}{% endblock %}</main>",
		};
		expect(await render(template, { functions: { load }, templates })).toBe(
			"<main><h1>Hi</h1>rel</main>",
		);
		expect(calls.started).toEqual(["[object Object]", "rel"]);
	});

	test("parts run once when no more may run early", async () => {
		const parts = Array.from(
			{ length: 70 },
			(_, n) => `{% set v${n} = later(${n}, 1) %}<{{ v${n} }}>{{ later("") }}`,
		);
		const expected = Array.from({ length: 70 }, (_, n) => `<${n}>`).join("");
		expect(await render(parts.join(""), { functions: { later } })).toBe(
			expected,
		);
	});

	test("a block whose content sets a variable runs before parts that read it", async () => {
		const template =
			'{% extends "layout" %}{% block a %}{{ later("A", 10) }}{% set count = 5 %}{% endblock %}';
		const templates = {
			layout: lines(
				"{% set count = 1 %}",
				"{% block a %}{% endblock %}",
				'[{{ count }}]{{ later("F") }}',
			),
		};
		expect(await render(template, { functions: { later }, templates })).toBe(
			"A[5]F",
		);
	});

	test("a loop placing a block that sets a variable runs its items in turn", async () => {
		const template =
			'{% extends "layout" %}{% block row %}{{ later("", 30 - i * 10) }}{% set n = n + 1 %}[{{ n }}]{% endblock %}';
		const templates = {
			layout:
				"{% set n = 0 %}{% for i in [0, 1, 2] %}{% block row %}{% endblock %}{% endfor %}",
		};
		expect(await render(template, { functions: { later }, templates })).toBe(
			"[1][2][3]",
		);
	});

	test("a fill that sets a variable runs before a fill that reads it", async () => {
		const template = lines(
			"{% set x = 0 %}",
			'{% component "card" %}',
			'{% fill "a" %}{{ later("A", 10) }}{% set x = 1 %}{% endfill %}',
			'{% fill "b" %}[{{ x }}]{{ later("B") }}{% endfill %}',
			"{% endcomponent %}",
		);
		const templates = {
			card: lines(
				'{% slot "a" %}',
				"{% endslot %}",
				'{% slot "b" %}',
				"{% endslot %}",
				"",
			),
		};
		expect(await render(template, { functions: { later }, templates })).toBe(
			"A[1]B",
		);
	});

	test("block() calls running at the same time don't count as nesting", async () => {
		const template = lines(
			'{% extends "base" %}',
			"{% block item %}{{ later(1) }}{% endblock %}",
		);
		const templates = {
			base: '{% for n in 1..70 %}{{ block("item") }}{% endfor %}{% block item %}{% endblock %}',
		};
		const output = await render(template, { functions: { later }, templates });
		expect(output).toBe("1".repeat(71));
	});
});

describe("running at the same time with layouts", () => {
	test("a layout starts while the page's top-level sets wait", async () => {
		const { calls, load } = tracked();
		const template = lines(
			'{% extends "layout" %}',
			'{% set post = load("post", 10) %}',
			"{% block content %}[{{ post }}]{% endblock %}",
		);
		const templates = {
			layout:
				'{{ load("header") }}|{% block content %}{% endblock %}|{{ load("footer") }}',
		};
		expect(await render(template, { functions: { load }, templates })).toBe(
			"header|[post]|footer",
		);
		expect(calls.started).toEqual(["post", "header", "footer"]);
		expect(calls.most).toBe(3);
	});

	test("layout parts that use the page's variables wait for them", async () => {
		const { calls, load } = tracked();
		const template = lines(
			'{% extends "layout" %}',
			'{% set title = load("Title", 10) %}',
		);
		const templates = {
			layout: '{{ load(title ~ "!") }}|{{ load("header") }}',
		};
		expect(await render(template, { functions: { load }, templates })).toBe(
			"Title!|header",
		);
		expect(calls.started).toEqual(["Title", "header", "Title!"]);
	});

	test("a layout sets a variable after the page does", async () => {
		const template = lines(
			'{% extends "layout" %}',
			'{% set title = later("Page", 10) %}',
		);
		const templates = { layout: '{% set title = "Layout" %}{{ title }}' };
		expect(await render(template, { functions: { later }, templates })).toBe(
			"Layout",
		);
	});

	test("a layout named by a top-level set waits for it", async () => {
		const template = lines(
			"{% extends name %}",
			'{% set name = later("layout", 5) %}',
		);
		const templates = { layout: "in layout" };
		expect(await render(template, { functions: { later }, templates })).toBe(
			"in layout",
		);
	});

	test("every layout in a chain starts while the pages below it wait", async () => {
		const { calls, load } = tracked();
		const template = lines(
			'{% extends "section" %}',
			'{% set post = load("post", 10) %}',
			"{% block content %}{{ post }}/{{ side }}{% endblock %}",
		);
		const templates = {
			section: lines(
				'{% extends "base" %}',
				'{% set side = load("side", 10) %}',
			),
			base: '{{ load("header") }}|{% block content %}{% endblock %}',
		};
		expect(await render(template, { functions: { load }, templates })).toBe(
			"header|post/side",
		);
		expect(calls.most).toBe(3);
	});

	test("the page's error wins over its layout's", async () => {
		const fail = (message: string, ms: number) =>
			later(null, ms).then(() => {
				throw new Error(message);
			});
		const template = lines(
			'{% extends "layout" %}',
			'{% set post = fail("page", 10) %}',
		);
		const templates = { layout: '{{ fail("layout", 1) }}' };
		const error = await renderError(template, {
			functions: { fail },
			templates,
		});
		expect((error.cause as Error).message).toBe("page");
		await settle();
	});
});

describe("running at the same time with outlets", () => {
	test("outlets get content in the page's order", async () => {
		const template =
			'{% outlet "head" %}|{% for n in [30, 1, 15] %}{% set v = later(n, n) %}{% add to "head" %}[{{ v }}]{% endadd %}{% endfor %}';
		expect(await render(template, { functions: { later } })).toBe(
			"[30][1][15]|",
		);
	});

	test("an outlet in a part that runs early stands in its place", async () => {
		const template =
			'{{ later("a", 10) }}<h>{% outlet "o" %}</h>{{ later("b") }}{% add to "o" %}x{% endadd %}';
		const options = { functions: { later } };
		expect(await render(template, options)).toBe("a<h>x</h>b");
		const parts = await readParts(await renderStream(template, options));
		expect(parts.join("")).toBe("a<h>x</h>b");
	});

	test("once keeps the content of the first tag in the page", async () => {
		const template =
			'{% outlet "o" %}|{% for n in [20, 1] %}{% set v = later(n, n) %}{% add to "o" once %}{{ v }}{% endadd %}{% endfor %}';
		expect(await render(template, { functions: { later } })).toBe("20|");
	});

	test("a once tag runs its content only the first time in the page", async () => {
		const template =
			'{% outlet "o" %}{{ later(1, 10) }}{% include "q" %}{% include "q" %}';
		const templates = {
			q: '{% set n = 0 %}{% add to "o" once %}x{% set n = 1 %}{% endadd %}[{{ n }}]',
		};
		expect(await render(template, { functions: { later }, templates })).toBe(
			"x1[1][0]",
		);
	});

	test("repeats of a once tag after a flush add nothing, and are no error", async () => {
		const template = lines(
			'{% outlet "o" %}',
			"{{ later(1, 10) }}",
			'{% include "q" %}',
			"{% flush %}",
			"{{ later(2) }}",
			'{% include "q" %}',
		);
		const templates = { q: '{% add to "o" once %}x{% endadd %}' };
		expect(await render(template, { functions: { later }, templates })).toBe(
			lines("x1", "2", ""),
		);
	});

	test("content added early after a flush is an error", async () => {
		const template =
			'{% outlet "o" %}{% for n in [1, 2] %}{% if n == 1 %}{{ later("x", 10) }}{% flush %}{% else %}{% add to "o" %}late{% endadd %}{% endif %}{% endfor %}';
		expect(await errorCode(template, { functions: { later } })).toBe(
			"outlet-closed",
		);
	});

	test("a streamed render sends the page in order", async () => {
		const template = lines(
			'<head>{% outlet "head" %}</head>{% flush %}',
			"{% for n in [20, 1] %}{% set v = later(n, n) %}<p>{{ v }}</p>{% endfor %}",
		);
		const parts = await readParts(
			await renderStream(template, { functions: { later } }),
		);
		expect(parts.join("")).toBe(lines("<head></head>", "<p>20</p><p>1</p>"));
	});

	test("the first deferred island in the page brings the script", async () => {
		const template =
			'{% for n in [20, 1] %}{% set v = later(n, n) %}{% island "card" with { n: v } %}{% endisland %}{% endfor %}';
		const output = await render(template, {
			functions: { later },
			templates: { card: "{% props n %}{{ n }}" },
			islands: deferIslands({ url: "/i/" }),
		});
		const first = output.indexOf("<kiln-island");
		expect(output.startsWith(`<script>${islandScript}</script>`)).toBe(true);
		expect(output.indexOf("<script>", first)).toBe(-1);
	});

	test("cached sections work in items that run at the same time", async () => {
		const cache = memoryCache();
		const template =
			"{% for n in [20, 1] %}{% cache n %}[{{ later(n, n) }}]{% endcache %}{% endfor %}";
		expect(await render(template, { cache, functions: { later } })).toBe(
			"[20][1]",
		);
		expect(await render(template, { cache, functions: { later } })).toBe(
			"[20][1]",
		);
	});
});

describe("running at the same time when parts fail", () => {
	const fail = (message: string, ms: number) =>
		later(null, ms).then(() => {
			throw new Error(message);
		});

	test("parts that wait for the parts before them make no changes after one fails", async () => {
		const islands = deferIslands({ url: "/i/" });
		expect(
			await errorCode(
				'{{ fail("first", 10) }}{% island "card" with { n: 1 } %}{% endisland %}',
				{
					functions: { fail },
					templates: { card: "{% props n %}{{ n }}" },
					islands,
				},
			),
		).toBe("host-error");
		expect(Object.keys(islands.manifest)).toEqual([]);
	});

	test("the error that comes first in the page wins", async () => {
		const error = await renderError(
			'{{ fail("first", 20) }}{{ fail("second", 1) }}',
			{ functions: { fail } },
		);
		expect(error instanceof KilnRenderError && error.code).toBe("host-error");
		expect((error.cause as Error).message).toBe("first");
		await settle();
	});

	test("the render fails once every part it started is done", async () => {
		const { calls, load } = tracked();
		const template =
			'{{ fail("first", 1) }}{% for n in [1, 2, 3] %}{{ load(n, 20) }}{% endfor %}';
		expect(await errorCode(template, { functions: { fail, load } })).toBe(
			"host-error",
		);
		expect(calls.started).toEqual(["1", "2", "3"]);
		expect(calls.active).toBe(0);
	});

	test("output running early counts towards the output limit", async () => {
		const template = '{% for n in 1..4 %}{{ later("0123456789") }}{% endfor %}';
		expect(
			await errorCode(template, {
				functions: { later },
				limits: { maxOutputLength: 30 },
			}),
		).toBe("limit-output");
	});
});
