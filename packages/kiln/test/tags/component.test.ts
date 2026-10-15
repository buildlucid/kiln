import { describe, expect, test } from "vite-plus/test";
import { errorCode, lines, render } from "../helpers.js";

describe("component", () => {
	test("renders a component with props, the default slot and named fills", async () => {
		const card = lines(
			"{% props title %}",
			"<article>",
			"<h2>{{ title }}</h2>",
			"{% slot %}{% endslot %}",
			"{% if slots.footer %}",
			'<footer>{% slot "footer" %}{% endslot %}</footer>',
			"{% endif %}",
			"</article>",
		);
		const template = lines(
			'{% component "components/card" with { title: post.title } %}',
			"\t<p>{{ post.excerpt }}</p>",
			'\t{% fill "footer" %}',
			'<a href="{{ post.url }}">More</a>',
			"\t{% endfill %}",
			"{% endcomponent %}",
		);
		const context = {
			post: { title: "Hello", excerpt: "Short", url: "/hello" },
		};
		expect(
			await render(template, {
				templates: { "components/card": card },
				context,
			}),
		).toBe(
			lines(
				"<article>",
				"<h2>Hello</h2>",
				"\t<p>Short</p>",
				'<footer><a href="/hello">More</a>',
				"</footer>",
				"</article>",
			),
		);
	});

	test("sees only its props, globals and slots", async () => {
		const templates = { box: '{{ secret ?? "isolated" }}{{ site }}' };
		const template =
			'{% set secret = "s" %}{% component "box" %}{% endcomponent %}';
		expect(await render(template, { templates, globals: { site: "S" } })).toBe(
			"isolatedS",
		);
	});

	test("fills render in the caller's scope", async () => {
		const templates = { box: "{{ who }}:{% slot %}{% endslot %}" };
		const template =
			'{% set who = "caller" %}{% component "box" with { who: "component" } %}{{ who }}{% endcomponent %}';
		expect(await render(template, { templates })).toBe("component:caller");
	});

	test("can be nested, each with its own slots", async () => {
		const templates = { box: "[{% slot %}{% endslot %}]" };
		const template =
			'{% component "box" %}a{% component "box" %}b{% endcomponent %}c{% endcomponent %}';
		expect(await render(template, { templates })).toBe("[a[b]c]");
	});

	test("a missing component is an error", async () => {
		expect(await errorCode('{% component "nope" %}{% endcomponent %}')).toBe(
			"missing-template",
		);
	});

	test("must be closed", async () => {
		expect(
			await errorCode('{% component "box" %}x', { templates: { box: "" } }),
		).toBe("unclosed-block");
	});
});

describe("slot", () => {
	test("renders its fallback when not filled, from component or include", async () => {
		const templates = {
			box: '[{% slot %}default{% endslot %}/{% slot "extra" %}extra{% endslot %}/{{ slots.extra }}]',
		};
		expect(
			await render(
				'{% component "box" %}{% endcomponent %}|{% include "box" %}',
				{ templates },
			),
		).toBe("[default/extra/false]|[default/extra/false]");
	});

	test("whitespace-only content does not fill the default slot", async () => {
		const templates = { box: "[{% slot %}fallback{% endslot %}]" };
		expect(
			await render(
				lines('{% component "box" %}', "   ", "{% endcomponent %}"),
				{ templates },
			),
		).toBe("[fallback]");
	});

	test("a slot can be output more than once", async () => {
		const templates = { box: "{% slot %}{% endslot %}{% slot %}{% endslot %}" };
		expect(
			await render('{% component "box" %}x{% endcomponent %}', { templates }),
		).toBe("xx");
	});

	test("slots belong to the component, not the templates it includes", async () => {
		const templates = {
			box: '{% include "inner" %}',
			inner: "[{% slot %}fallback{% endslot %}]",
		};
		expect(
			await render('{% component "box" %}filled{% endcomponent %}', {
				templates,
			}),
		).toBe("[fallback]");
	});
});

describe("fill", () => {
	test("a slot can only be filled once", async () => {
		const template =
			'{% component "box" %}{% fill "a" %}1{% endfill %}{% fill "a" %}2{% endfill %}{% endcomponent %}';
		expect(await errorCode(template, { templates: { box: "" } })).toBe(
			"duplicate-fill",
		);
	});

	test("the default slot cannot be filled both ways", async () => {
		const template =
			'{% component "box" %}text{% fill "default" %}x{% endfill %}{% endcomponent %}';
		expect(await errorCode(template, { templates: { box: "" } })).toBe(
			"duplicate-fill",
		);
	});

	test("must be inside a component", async () => {
		expect(await errorCode('{% fill "a" %}x{% endfill %}')).toBe(
			"unexpected-tag",
		);
	});
});

describe("edge cases", () => {
	const templates = { box: "[{% slot %}{% endslot %}]" };

	test("fills can read the caller's loop", async () => {
		const template =
			'{% for p in ["a", "b"] %}{% component "box" %}{{ loop.index }}{{ p }}{% endcomponent %}{% endfor %}';
		expect(await render(template, { templates })).toBe("[1a][2b]");
	});

	test("fills can use the caller's imports and macros", async () => {
		const template =
			'{% import "lib" as l %}{% component "box" %}{{ l.say() }}{{ local() }}{% endcomponent %}{% macro local() %}L{% endmacro %}';
		expect(
			await render(template, {
				templates: { ...templates, lib: "{% macro say() %}hi{% endmacro %}" },
			}),
		).toBe("[hiL]");
	});

	test("a fill can pass through to a nested component", async () => {
		const nested = {
			outer: '<{% slot %}{% endslot %}|{% slot "a" %}oa{% endslot %}>',
			inner: '({% slot "a" %}ia{% endslot %})',
		};
		const template =
			'{% component "outer" %}{% component "inner" %}{% fill "a" %}A{% endfill %}{% endcomponent %}{% endcomponent %}';
		expect(await render(template, { templates: nested })).toBe("<(A)|oa>");
	});

	test("text on both sides of a fill makes up the default slot", async () => {
		expect(
			await render(
				'{% component "box" %}x{% fill "f" %}F{% endfill %}y{% endcomponent %}',
				{ templates },
			),
		).toBe("[xy]");
	});

	test("component output can be filtered by apply", async () => {
		expect(
			await render(
				'{% apply upper %}{% component "box" %}a{% endcomponent %}{% endapply %}',
				{ templates },
			),
		).toBe("[A]");
	});

	test("a component that renders itself stops at the depth limit", async () => {
		const self = { c: '{% component "c" %}{% endcomponent %}' };
		expect(
			await errorCode('{% component "c" %}{% endcomponent %}', {
				templates: self,
			}),
		).toBe("limit-depth");
	});
});
