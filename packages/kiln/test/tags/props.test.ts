import { describe, expect, test } from "vite-plus/test";
import { errorCode, lines, render, renderError } from "../helpers.js";

describe("props", () => {
	test("declares variables and applies defaults", async () => {
		const template = '{% props title, size = "md" %}{{ title }}-{{ size }}';
		expect(await render(template, { context: { title: "T" } })).toBe("T-md");
	});

	test("a default replaces null", async () => {
		expect(
			await render('{% props size = "md" %}{{ size }}', {
				context: { size: null },
			}),
		).toBe("md");
	});

	test("a passed value replaces the default", async () => {
		expect(
			await render('{% props size = "md" %}{{ size }}', {
				context: { size: "lg" },
			}),
		).toBe("lg");
	});

	test("defaults can use earlier props", async () => {
		const template = '{% props first, label = first ~ "!" %}{{ label }}';
		expect(await render(template, { context: { first: "Hi" } })).toBe("Hi!");
	});

	test("required props must be passed in strict mode", async () => {
		expect(await errorCode("{% props title %}{{ title }}")).toBe(
			"missing-prop",
		);
	});

	test("missing required props are null in lenient mode", async () => {
		expect(
			await render("{% props title %}[{{ title }}]", { strict: false }),
		).toBe("[]");
	});

	test("undeclared variables are refused in strict mode", async () => {
		expect(
			await errorCode("{% props title %}{{ title }}", {
				context: { title: "T", extra: 1 },
			}),
		).toBe("unknown-prop");
	});

	test("undeclared variables are allowed in lenient mode", async () => {
		expect(
			await render("{% props title %}{{ title }}", {
				strict: false,
				context: { title: "T", extra: 1 },
			}),
		).toBe("T");
	});

	test("must come before content", async () => {
		expect(await errorCode("<p></p>{% props title %}")).toBe("props-not-first");
	});

	test("can only appear once", async () => {
		expect(await errorCode("{% props a %}{% props b %}")).toBe(
			"duplicate-props",
		);
	});

	test("must be at the top level", async () => {
		expect(await errorCode("{% if true %}{% props a %}{% endif %}")).toBe(
			"props-not-first",
		);
	});
});

describe("edge cases", () => {
	test("falsy passed values are kept", async () => {
		const template =
			'{% props flag = true, n = 5, s = "d" %}{{ flag }}{{ n }}[{{ s }}]';
		expect(
			await render(template, { context: { flag: false, n: 0, s: "" } }),
		).toBe("false0[]");
	});

	test("a prop is found before a global of the same name", async () => {
		expect(
			await render('{% props site = "local" %}{{ site }}', {
				globals: { site: "G" },
			}),
		).toBe("local");
	});

	test("names cannot be reserved or repeated", async () => {
		expect(await errorCode("{% props loop %}")).toBe("reserved-name");
		expect(await errorCode("{% props a, a %}")).toBe("duplicate-parameter");
	});

	test("are checked for includes and components", async () => {
		const templates = { p: "{% props a %}" };
		expect(
			await errorCode('{% include "p" with { a: 1, b: 2 } %}', { templates }),
		).toBe("unknown-prop");
		expect(await errorCode('{% include "p" %}', { templates })).toBe(
			"missing-prop",
		);
		expect(
			await errorCode('{% component "p" with { b: 1 } %}{% endcomponent %}', {
				templates,
			}),
		).toBe("unknown-prop");
	});

	test("a layout's required props are checked", async () => {
		expect(
			await errorCode('{% extends "base" %}', {
				templates: { base: "{% props lang %}{{ lang }}" },
			}),
		).toBe("missing-prop");
	});
});

describe("types", () => {
	test("accepts values of the declared type", async () => {
		const template =
			"{% props title: string, count: number, tags: array, meta: hash %}{{ title }}{{ count }}{{ tags|length }}{{ meta|length }}";
		expect(
			await render(template, {
				context: { title: "T", count: 2, tags: ["a"], meta: { a: 1 } },
			}),
		).toBe("T211");
	});

	test("refuses a value of another type in strict mode", async () => {
		expect(
			await errorCode("{% props count: number %}{{ count }}", {
				context: { count: "3" },
			}),
		).toBe("prop-type");
	});

	test("passes a value of another type through in lenient mode", async () => {
		expect(
			await render("{% props count: number %}{{ count }}", {
				strict: false,
				context: { count: "3" },
			}),
		).toBe("3");
	});

	test("a union accepts any of its members", async () => {
		const template = "{% props href: string | null %}[{{ href }}]";
		expect(await render(template, { context: { href: "/a" } })).toBe("[/a]");
		expect(await render(template, { context: { href: null } })).toBe("[]");
	});

	test("null is refused unless the type includes it", async () => {
		expect(
			await errorCode("{% props title: string %}", {
				context: { title: null },
			}),
		).toBe("prop-type");
	});

	test("literals list the values a prop allows", async () => {
		const template =
			'{% props variant: "primary" | "secondary", level: 2 | 3 %}{{ variant }}{{ level }}';
		expect(
			await render(template, { context: { variant: "secondary", level: 3 } }),
		).toBe("secondary3");
		const error = await renderError(template, {
			context: { variant: "danger", level: 2 },
		});
		expect(error).toMatchObject({ code: "prop-type" });
		expect(error.message).toContain('but got "danger"');
	});

	test("the value is checked after the default applies", async () => {
		expect(
			await render('{% props variant: "a" | "b" = "a" %}{{ variant }}', {
				context: { variant: null },
			}),
		).toBe("a");
	});

	test("string accepts markup, and markup accepts only markup", async () => {
		const templates = {
			text: "{% props value: string %}{{ value }}",
			html: "{% props value: markup %}{{ value }}",
		};
		expect(
			await render(
				'{% include "text" with { value: "<b>"|raw } %}{% include "html" with { value: "<i>"|raw } %}',
				{ templates },
			),
		).toBe("<b><i>");
		expect(
			await errorCode('{% include "html" with { value: "<i>" } %}', {
				templates,
			}),
		).toBe("prop-type");
	});

	test("object accepts class instances, and date accepts dates", async () => {
		class Post {}
		expect(
			await render("{% props post: object, at: date %}ok", {
				context: { post: new Post(), at: new Date(0) },
			}),
		).toBe("ok");
		expect(
			await errorCode("{% props post: object %}", {
				context: { post: { title: "T" } },
			}),
		).toBe("prop-type");
	});

	test("are checked for components, with the caller in the error", async () => {
		const error = await renderError(
			'{% component "card" with { title: 1 } %}{% endcomponent %}',
			{ templates: { card: "{% props title: string %}{{ title }}" } },
		);
		expect(error).toMatchObject({
			code: "prop-type",
			template: "card.kiln",
			templateStack: [{ template: "index.kiln" }, { template: "card.kiln" }],
		});
	});

	test("a literal default that does not match the type is a syntax error", async () => {
		expect(await errorCode("{% props href: string = null %}")).toBe(
			"prop-type",
		);
	});

	test("unknown type names are syntax errors", async () => {
		expect(await errorCode("{% props title: text %}")).toBe("unknown-type");
	});

	test("macros cannot declare types", async () => {
		expect(await errorCode("{% macro m(a: string) %}{% endmacro %}")).toBe(
			"unexpected-token",
		);
	});

	test("can span several lines", async () => {
		const template = lines(
			"{% props",
			"	title: string,",
			'	size: "sm" | "md" = "md"',
			"%}",
			"{{ title }}-{{ size }}",
		);
		expect(await render(template, { context: { title: "T" } })).toBe("T-md");
	});
});
