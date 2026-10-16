import { describe, expect, test } from "vite-plus/test";
import { errorCode, lines, render } from "../helpers.js";

describe("include", () => {
	test("renders another template in place", async () => {
		expect(
			await render('a{% include "part" %}c', { templates: { part: "b" } }),
		).toBe("abc");
	});

	test("passes only the given variables", async () => {
		const templates = {
			"partials/card": '[{{ title }}|{{ secret ?? "isolated" }}]',
		};
		const template =
			'{% set secret = "s" %}{% include "partials/card" with { title: "T" } %}';
		expect(await render(template, { templates })).toBe("[T|isolated]");
	});

	test("the included template sees globals", async () => {
		expect(
			await render('{% include "part" %}', {
				templates: { part: "{{ site }}" },
				globals: { site: "S" },
			}),
		).toBe("S");
	});

	test("set in the included template does not change the caller", async () => {
		const templates = { part: '{% set x = "changed" %}' };
		expect(
			await render(
				'{% set x = "kept" %}{% include "part" with { x } %}{{ x }}',
				{ templates },
			),
		).toBe("kept");
	});

	test("the name can be built at render time", async () => {
		const templates = {
			"sections/hero": "<h1>{{ section.title }}</h1>",
			"sections/text": "<p>{{ section.body }}</p>",
		};
		const context = {
			sections: [
				{ type: "hero", title: "Hi" },
				{ type: "text", body: "Body" },
			],
		};
		const template =
			'{% for section in sections %}{% include "sections/" ~ section.type with { section } %}{% endfor %}';
		expect(await render(template, { templates, context })).toBe(
			"<h1>Hi</h1><p>Body</p>",
		);
	});

	test("ignore missing renders nothing for a missing template", async () => {
		expect(await render('a{% include "nope" ignore missing %}b')).toBe("ab");
	});

	test("a missing template is an error", async () => {
		expect(await errorCode('{% include "nope" %}')).toBe("missing-template");
	});

	test("the name must be a string", async () => {
		expect(await errorCode("{% include 5 %}")).toBe("type-error");
	});

	test("with needs a hash", async () => {
		expect(
			await errorCode('{% include "part" with [1] %}', {
				templates: { part: "" },
			}),
		).toBe("type-error");
	});

	test("its output is not escaped again", async () => {
		expect(
			await render('{% include "part" %}', {
				templates: { part: '<b>{{ "<i>" }}</b>' },
			}),
		).toBe("<b>&lt;i&gt;</b>");
	});

	test("cannot recurse forever", async () => {
		expect(await errorCode('{% include "index" %}')).toBe("limit-depth");
	});

	test("on a line of its own, every included line lines up with it", async () => {
		const part = lines("<p>a</p>", "<p>b</p>", "");
		expect(
			await render(lines("<div>", '\t{% include "part" %}', "</div>"), {
				templates: { part },
			}),
		).toBe(lines("<div>", "\t<p>a</p>", "\t<p>b</p>", "</div>"));
	});
});

describe("template names", () => {
	test("the .kiln extension is optional", async () => {
		expect(
			await render('{% include "part.kiln" %}{% include "part" %}', {
				templates: { part: "x" },
			}),
		).toBe("xx");
	});

	test("./ and ../ are relative to the current template", async () => {
		const templates = {
			"pages/home": '{% include "./part" %}{% include "../shared/footer" %}',
			"pages/part": "part;",
			"shared/footer": "footer",
		};
		expect(await render('{% include "pages/home" %}', { templates })).toBe(
			"part;footer",
		);
	});

	test("cannot leave the template root", async () => {
		expect(await errorCode('{% include "../outside" %}')).toBe(
			"invalid-template-name",
		);
	});

	test("cannot start with a slash", async () => {
		expect(await errorCode('{% include "/part" %}')).toBe(
			"invalid-template-name",
		);
	});
});

describe("edge cases", () => {
	test("ignore missing only covers the named template", async () => {
		expect(
			await errorCode('{% include "a" ignore missing %}', {
				templates: { a: '{% include "nope" %}' },
			}),
		).toBe("missing-template");
	});

	test("ignore missing does not hide syntax errors", async () => {
		expect(
			await errorCode('{% include "a" ignore missing %}', {
				templates: { a: "{{ 1|nope }}" },
			}),
		).toBe("unknown-filter");
	});

	test("a passed variable shadows a global", async () => {
		expect(
			await render('{% include "p" with { site: "L" } %}', {
				templates: { p: "{{ site }}" },
				globals: { site: "G" },
			}),
		).toBe("L");
	});

	test("names with another extension are used as they are", async () => {
		expect(
			await render('{% include "partials/x.html" %}', {
				templates: { "partials/x.html": "X" },
			}),
		).toBe("X");
	});

	test("an empty name is an error", async () => {
		expect(await errorCode('{% include "" %}')).toBe("invalid-template-name");
	});

	test("each include starts with a fresh scope", async () => {
		const templates = { p: "{% set n = (n ?? 0) + 1 %}{{ n }}" };
		expect(
			await render('{% include "p" %}{% include "p" %}', { templates }),
		).toBe("11");
	});
});
