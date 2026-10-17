import { describe, expect, test } from "vite-plus/test";
import { errorCode, lines, render } from "../helpers.js";

describe("extends", () => {
	test("renders the layout with the child's blocks", async () => {
		const page = lines(
			'{% extends "layouts/base" %}',
			'{% set page = { title: "Home" } %}',
			"",
			"{% block title %}{{ page.title }} | {{ parent() }}{% endblock %}",
			"",
			"{% block content %}",
			"<h1>{{ page.title }}</h1>",
			"{% endblock %}",
		);
		const base = lines(
			"<title>{% block title %}{{ site }}{% endblock %}</title>",
			"<main>",
			"{% block content %}{% endblock %}",
			"</main>",
		);
		expect(
			await render(page, {
				templates: { "layouts/base": base },
				globals: { site: "Example" },
			}),
		).toBe(
			lines(
				"<title>Home | Example</title>",
				"<main>",
				"<h1>Home</h1>",
				"</main>",
			),
		);
	});

	test("blocks the child does not override keep the layout's content", async () => {
		const templates = {
			base: "{% block a %}A{% endblock %}{% block b %}B{% endblock %}",
		};
		expect(await render('{% extends "base" %}', { templates })).toBe("AB");
	});

	test("the layout name can be an expression", async () => {
		const templates = { "layouts/default": "[{% block body %}{% endblock %}]" };
		const page = lines(
			'{% extends layout ?? "layouts/default" %}',
			"{% block body %}child{% endblock %}",
		);
		expect(await render(page, { templates })).toBe("[child]");
	});

	test("chains can be several levels deep", async () => {
		const templates = {
			middle: lines(
				'{% extends "base" %}',
				"{% block b %}middle>{{ parent() }}{% endblock %}",
			),
			base: "{% block b %}base{% endblock %}",
		};
		const page = lines(
			'{% extends "middle" %}',
			"{% block b %}child>{{ parent() }}{% endblock %}",
		);
		expect(await render(page, { templates })).toBe("child>middle>base");
	});

	test("the child's top-level set runs before the layout and is visible to it", async () => {
		const templates = { base: "{{ title }}|{% block b %}{% endblock %}" };
		const page = lines(
			'{% extends "base" %}',
			"{% block b %}{{ title }}{% endblock %}",
			'{% set title = "T" %}',
		);
		expect(await render(page, { templates })).toBe("T|T");
	});

	test("layouts and pages can each declare props", async () => {
		const templates = {
			layout: lines(
				'{% props lang, title = "Site" %}',
				'<html lang="{{ lang }}"><title>{{ title }}</title>{% block body %}{% endblock %}</html>',
			),
		};
		const page = lines(
			'{% extends "layout" %}',
			'{% props page, lang = "en" %}',
			"{% block body %}{{ page }}{% endblock %}",
		);
		expect(await render(page, { templates, context: { page: "P" } })).toBe(
			'<html lang="en"><title>Site</title>P</html>',
		);
	});

	test("must be the first tag", async () => {
		expect(
			await errorCode(lines("<p></p>", '{% extends "base" %}'), {
				templates: { base: "" },
			}),
		).toBe("extends-not-first");
	});

	test("a child template can only contain blocks and declarations", async () => {
		expect(
			await errorCode(lines('{% extends "base" %}', "<p>stray</p>"), {
				templates: { base: "" },
			}),
		).toBe("invalid-child-content");
	});

	test("a missing layout is an error", async () => {
		expect(await errorCode('{% extends "nope" %}')).toBe("missing-template");
	});

	test("a layout extending itself stops at the depth limit", async () => {
		expect(await errorCode('{% extends "index" %}')).toBe("limit-depth");
	});
});

describe("block", () => {
	test("renders its content in a template without a layout", async () => {
		expect(await render("{% block a %}x{% endblock %}")).toBe("x");
	});

	test("the short form outputs one expression", async () => {
		const templates = {
			base: "<title>{% block title %}{% endblock %}</title>",
		};
		const page = lines(
			'{% extends "base" %}',
			"{% block title page.title|upper %}",
		);
		expect(
			await render(page, { templates, context: { page: { title: "news" } } }),
		).toBe("<title>NEWS</title>");
	});

	test("a block inside if can set a variable read after it", async () => {
		const template =
			"{% set x = 1 %}{{ x }}{% if true %}{% block b %}{% set x = 2 %}{% endblock %}{% endif %}{{ x }}";
		expect(await render(template)).toBe("12");
	});

	test("a child's block placed in a component's content can set a variable read after it", async () => {
		const templates = {
			base: "{% set x = 1 %}{{ x }}{% if true %}{% component 'box' %}{% block b %}{% endblock %}{% endcomponent %}{% endif %}{{ x }}",
			box: "{% slot %}{% endslot %}",
		};
		const page =
			'{% extends "base" %}{% block b %}{% set x = 2 %}{% endblock %}';
		expect(await render(page, { templates })).toBe("12");
	});

	test("nested blocks can be overridden on their own", async () => {
		const templates = {
			base: "{% block outer %}<{% block inner %}old{% endblock %}>{% endblock %}",
		};
		const page = lines(
			'{% extends "base" %}',
			"{% block inner %}new{% endblock %}",
		);
		expect(await render(page, { templates })).toBe("<new>");
	});

	test("a child's block lines up with where the layout places it", async () => {
		const templates = {
			base: lines(
				"<body>",
				"\t<main>",
				"\t\t{% block content %}{% endblock %}",
				"\t</main>",
				"</body>",
			),
		};
		const page = lines(
			'{% extends "base" %}',
			"{% block content %}",
			"\t<h1>Title</h1>",
			"\t<p>Text</p>",
			"{% endblock %}",
		);
		expect(await render(page, { templates })).toBe(
			lines(
				"<body>",
				"\t<main>",
				"\t\t<h1>Title</h1>",
				"\t\t<p>Text</p>",
				"\t</main>",
				"</body>",
			),
		);
	});

	test("sees the variables where it is placed in the layout", async () => {
		const templates = {
			base: '{% for item in ["a", "b"] %}{% block item %}{% endblock %}{% endfor %}',
		};
		const page = lines(
			'{% extends "base" %}',
			"{% block item %}{{ item }}{{ loop.index }}{% endblock %}",
		);
		expect(await render(page, { templates })).toBe("a1b2");
	});

	test("set inside a block stays in the block", async () => {
		expect(
			await render(
				'{% block a %}{% set x = 1 %}{% endblock %}{{ x ?? "none" }}',
			),
		).toBe("none");
	});

	test("endblock may repeat the name", async () => {
		expect(await render("{% block content %}x{% endblock content %}")).toBe(
			"x",
		);
	});

	test("a repeated name must match", async () => {
		expect(await errorCode("{% block content %}x{% endblock other %}")).toBe(
			"mismatched-end",
		);
	});

	test("names must be unique in a template", async () => {
		expect(
			await errorCode("{% block a %}{% endblock %}{% block a %}{% endblock %}"),
		).toBe("duplicate-block");
	});
});

describe("parent()", () => {
	test("can only be used inside a block", async () => {
		expect(await errorCode("{{ parent() }}")).toBe("parent-outside-block");
	});

	test("needs a parent block", async () => {
		expect(await errorCode("{% block a %}{{ parent() }}{% endblock %}")).toBe(
			"missing-parent-block",
		);
	});

	test("can be used more than once", async () => {
		const templates = { base: "{% block b %}x{% endblock %}" };
		const page = lines(
			'{% extends "base" %}',
			"{% block b %}{{ parent() }}{{ parent() }}{% endblock %}",
		);
		expect(await render(page, { templates })).toBe("xx");
	});

	test("a variable the parent's block sets is read after the block", async () => {
		const templates = {
			base: "{% set x = 1 %}{{ x }}{% if true %}{% block b %}{% set x = 2 %}{% endblock %}{% endif %}{{ x }}",
		};
		const page = lines(
			'{% extends "base" %}',
			"{% block b %}[{{ parent() }}]{% endblock %}",
		);
		expect(await render(page, { templates })).toBe("1[]2");
	});

	test("can read the loop it is called in", async () => {
		const templates = { base: "{% block b %}{{ loop.index }}{% endblock %}" };
		const page = lines(
			'{% extends "base" %}',
			"{% block b %}{% for i in [1, 2] %}{{ parent() }}{% endfor %}{% endblock %}",
		);
		expect(await render(page, { templates })).toBe("12");
	});
});

describe("block()", () => {
	test("renders a block again", async () => {
		expect(
			await render('{% block title %}Hello{% endblock %}|{{ block("title") }}'),
		).toBe("Hello|Hello");
	});

	test("is defined tells whether a block exists", async () => {
		expect(
			await render(
				'{% block a %}{% endblock %}{{ block("a") is defined }}|{{ block("nope") is defined }}',
			),
		).toBe("true|false");
	});

	test("an unknown block is an error", async () => {
		expect(await errorCode('{{ block("nope") }}')).toBe("unknown-block");
	});

	test("calls through a placed block count towards maxDepth", async () => {
		expect(
			await errorCode(
				'{% block a %}A{{ block("b") }}{% endblock %}{% block b %}B{% block c %}{{ block("a") }}{% endblock %}{% endblock %}',
			),
		).toBe("limit-depth");
	});

	test("can read the loop it is called in", async () => {
		const template =
			'{% for x in [1, 2] %}{{ block("row") }}{% endfor %}{% if false %}{% block row %}{{ loop.index ?? "" }}{% endblock %}{% endif %}';
		expect(await render(template)).toBe("12");
	});

	test("a variable the block it renders sets is read after the block placing it", async () => {
		const templates = {
			base: "{% set x = 1 %}{{ x }}{% if true %}{% block b %}{% endblock %}{% endif %}{{ x }}{% block c %}{% endblock %}",
		};
		const page = lines(
			'{% extends "base" %}',
			'{% block b %}[{{ block("c") }}]{% endblock %}',
			"{% block c %}{% set x = 2 %}{% endblock %}",
		);
		expect(await render(page, { templates })).toBe("1[]2");
	});

	test("cannot recurse forever", async () => {
		expect(await errorCode('{% block a %}{{ block("a") }}{% endblock %}')).toBe(
			"limit-depth",
		);
	});
});

describe("edge cases", () => {
	test("whitespace and comments may come before extends", async () => {
		expect(
			await render('\n{# c #}\n{% extends "base" %}', {
				templates: { base: "B" },
			}),
		).toBe("B");
	});

	test("extends can only appear once, at the top", async () => {
		const templates = { base: "" };
		expect(
			await errorCode('{% extends "base" %}{% extends "base" %}', {
				templates,
			}),
		).toBe("extends-not-first");
		expect(
			await errorCode('{% block a %}{% extends "base" %}{% endblock %}', {
				templates,
			}),
		).toBe("extends-not-first");
	});

	test("output is not allowed at a child's top level", async () => {
		expect(
			await errorCode('{% extends "base" %}{{ x }}', {
				templates: { base: "" },
			}),
		).toBe("invalid-child-content");
	});

	test("the layout name can wait for async data", async () => {
		const later = (value: string) => Promise.resolve(value);
		expect(
			await render('{% extends later("base") %}', {
				templates: { base: "B" },
				functions: { later },
			}),
		).toBe("B");
	});

	test("templates extending each other stop at the depth limit", async () => {
		expect(
			await errorCode('{% extends "b" %}', {
				templates: { b: '{% extends "index" %}' },
			}),
		).toBe("limit-depth");
	});

	test("an included template's inheritance is separate from the includer's", async () => {
		const templates = {
			base: "[{% block c %}C{% endblock %}|{% block f %}F{% endblock %}]",
			inc: lines('{% extends "base" %}', "{% block c %}IC{% endblock %}"),
		};
		const page = lines(
			'{% extends "base" %}',
			'{% block c %}{% include "inc" %}{% endblock %}',
			"{% block f %}PF{% endblock %}",
		);
		expect(await render(page, { templates })).toBe("[[IC|F]|PF]");
	});

	test("a dynamic layout is chosen on every render", async () => {
		const templates = {
			p: '{% extends n ~ "_base" %}{% block c %}{{ parent() }}!{% endblock %}',
			"1_base": "{% block c %}1{% endblock %}",
			"2_base": "{% block c %}2{% endblock %}",
		};
		expect(
			await render(
				'{% include "p" with { n: 1 } %}{% include "p" with { n: 2 } %}',
				{ templates },
			),
		).toBe("1!2!");
	});
});

describe("block edge cases", () => {
	test("a nested block cannot repeat its parent's name", async () => {
		expect(
			await errorCode("{% block a %}{% block a %}{% endblock %}{% endblock %}"),
		).toBe("duplicate-block");
	});

	test("an outer and inner block can be overridden together", async () => {
		const templates = {
			base: "{% block o %}<{% block i %}i{% endblock %}>{% endblock %}",
		};
		const page = lines(
			'{% extends "base" %}',
			"{% block o %}[{{ parent() }}]{% endblock %}",
			"{% block i %}I{% endblock %}",
		);
		expect(await render(page, { templates })).toBe("[<I>]");
	});

	test("blocks cannot be defined in macros", async () => {
		expect(
			await errorCode(
				"{% macro m() %}{% block a %}{% endblock %}{% endmacro %}",
			),
		).toBe("invalid-block-placement");
	});

	test("block() in a layout renders the child's override", async () => {
		const templates = {
			base: '{% block a %}{{ block("b") }}{% endblock %}{% block b %}B0{% endblock %}',
		};
		expect(
			await render(
				lines('{% extends "base" %}', "{% block b %}B1{% endblock %}"),
				{ templates },
			),
		).toBe("B1B1");
	});

	test("block() can render a tree recursively", async () => {
		const template =
			'{% block tree %}({% for node in nodes %}{{ node.name }}{% with { nodes: node.children ?? [] } %}{{ block("tree") }}{% endwith %}{% endfor %}){% endblock %}';
		const context = { nodes: [{ name: "a", children: [{ name: "b" }] }] };
		expect(await render(template, { context })).toBe("(a(b()))");
	});

	test("parent() needs the layout to define the block", async () => {
		const templates = { base: '{{ block("label") }}' };
		expect(
			await errorCode(
				lines(
					'{% extends "base" %}',
					"{% block label %}{{ parent() }}{% endblock %}",
				),
				{ templates },
			),
		).toBe("missing-parent-block");
	});
});
