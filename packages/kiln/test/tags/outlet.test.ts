import { describe, expect, test } from "vite-plus/test";
import {
	hostComponent,
	memoryCache,
	safe,
	withRender,
} from "../../src/index.js";
import { errorCode, lines, render } from "../helpers.js";

const base = lines(
	"<html>",
	"	<head>",
	"		<title>{{ title }}</title>",
	'		{% outlet "head" %}',
	"	</head>",
	"	<body>",
	"		{% block content %}{% endblock %}",
	"	</body>",
	"</html>",
);

const card = lines(
	"{% props title %}",
	'{% add to "head" once %}',
	'	<link rel="stylesheet" href="/card.css">',
	"{% endadd %}",
	'<article class="card">{{ title }}</article>',
	"",
);

describe("outlet", () => {
	test("holds content added after it", async () => {
		const page = lines(
			'{% extends "layouts/base" %}',
			'{% set title = "Home" %}',
			"{% block content %}",
			'	{% include "components/card" with { title: "One" } %}',
			'	{% include "components/card" with { title: "Two" } %}',
			"{% endblock %}",
		);
		expect(
			await render(page, {
				templates: { "layouts/base": base, "components/card": card },
			}),
		).toBe(
			lines(
				"<html>",
				"	<head>",
				"		<title>Home</title>",
				'<link rel="stylesheet" href="/card.css">',
				"	</head>",
				"	<body>",
				'<article class="card">One</article>',
				'<article class="card">Two</article>',
				"	</body>",
				"</html>",
			),
		);
	});

	test("holds content added before it", async () => {
		expect(
			await render(
				'{% add to "end" %}a{% endadd %}[{% outlet "end" %}]{% add to "end" %}b{% endadd %}',
			),
		).toBe("[ab]");
	});

	test("outputs nothing when nothing was added", async () => {
		expect(
			await render(lines("<head>", '	{% outlet "head" %}', "</head>")),
		).toBe(lines("<head>", "</head>"));
	});

	test("can share a line", async () => {
		const template = lines(
			'<head>{% outlet "head" %}</head>',
			'{% add to "head" %}',
			"	<link>",
			"{% endadd %}",
		);
		expect(await render(template)).toBe("<head><link>\n</head>\n");
	});

	test("can only be used once per render", async () => {
		expect(await errorCode('{% outlet "a" %}{% outlet "a" %}')).toBe(
			"duplicate-outlet",
		);
	});

	test("can't be inside a capture or a cached section", async () => {
		expect(await errorCode('{% set x %}{% outlet "a" %}{% endset %}')).toBe(
			"misplaced-outlet",
		);
		expect(
			await errorCode('{% macro m() %}{% outlet "a" %}{% endmacro %}{{ m() }}'),
		).toBe("misplaced-outlet");
		expect(
			await errorCode('{% cache "k" %}{% outlet "a" %}{% endcache %}'),
		).toBe("misplaced-outlet");
	});

	test("needs a string name", async () => {
		expect(await errorCode("{% outlet head %}")).toBe("unexpected-token");
	});
});

describe("addTo", () => {
	const functions = {
		picker: withRender((info) => {
			info.addTo("head", "<script src=/picker.js></script>", {
				once: "picker",
			});
			return safe("<date-picker></date-picker>");
		}),
		note: withRender((info, text: string) => {
			info.addTo("head", `<meta name=${text}>`);
			return "";
		}),
	};

	test("adds HTML from a function, once per key", async () => {
		expect(
			await render(
				'<head>{% outlet "head" %}</head>{{ picker() }}{{ picker() }}{{ note("a") }}',
				{ functions },
			),
		).toBe(
			"<head><script src=/picker.js></script><meta name=a></head><date-picker></date-picker><date-picker></date-picker>",
		);
	});

	test("adds HTML from a host component", async () => {
		const templates = {
			"Meta.tsx": hostComponent((_props, _slots, info) => {
				info.addTo("head", "<title>Hi</title>");
				return safe("<p></p>");
			}),
		};
		expect(
			await render('<head>{% outlet "head" %}</head>{% include "Meta.tsx" %}', {
				templates,
			}),
		).toBe("<head><title>Hi</title></head><p></p>");
	});

	test("never shares a once key with an add to once tag", async () => {
		const template = lines(
			'<head>{% outlet "head" %}</head>',
			'{% add to "head" once %}tag{% endadd %}',
			"{{ picker() }}",
		);
		expect(await render(template, { functions })).toContain(
			"<head>tag<script src=/picker.js></script></head>",
		);
	});

	test("is saved and added again with a cached section", async () => {
		const cache = memoryCache();
		const template =
			'<head>{% outlet "head" %}</head>{% cache "c" %}{{ note("cached") }}{% endcache %}';
		await render(template, { functions, cache });
		expect(
			await render(template, {
				functions: { ...functions, note: () => "" },
				cache,
			}),
		).toBe("<head><meta name=cached></head>");
	});

	test("fails for a closed outlet, as add to does", async () => {
		expect(
			await errorCode('{% outlet "head" %}{% flush %}{{ note("late") }}', {
				functions,
			}),
		).toBe("outlet-closed");
	});
});
