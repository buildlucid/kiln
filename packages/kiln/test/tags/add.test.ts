import { describe, expect, test } from "vite-plus/test";
import { createKiln, memoryLoader } from "../../src/index.js";
import { errorCode, render } from "../helpers.js";

describe("add", () => {
	test("adds content to an outlet in the order it runs", async () => {
		expect(
			await render(
				'{% outlet "end" %}{% for n in [1, 2] %}{% add to "end" %}{{ n }}{% endadd %}{% endfor %}',
			),
		).toBe("12");
	});

	test("once adds only the first time the tag runs", async () => {
		expect(
			await render(
				'{% outlet "end" %}{% for n in [1, 2] %}{% add to "end" once %}{{ n }}{% endadd %}{% add to "end" once %}x{% endadd %}{% endfor %}',
			),
		).toBe("1x");
	});

	test("reads the variables around it, and keeps its own", async () => {
		expect(
			await render(
				'{% outlet "end" %}{% set name = "a" %}{% add to "end" %}{% set inner = "b" %}{{ name }}{{ inner }}{% endadd %}{{ inner ?? "-" }}',
				{ strict: false },
			),
		).toBe("ab-");
	});

	test("is escaped like any other output", async () => {
		expect(
			await render(
				'{% outlet "end" %}{% add to "end" %}{{ "<b>" }}{% endadd %}',
			),
		).toBe("&lt;b&gt;");
	});

	test("content for an outlet the page doesn't have is dropped", async () => {
		expect(await render('{% add to "head" %}<link>{% endadd %}ok')).toBe("ok");
	});

	test("content for an outlet outside a rendered block is dropped", async () => {
		const kiln = createKiln({
			loader: memoryLoader({
				page: '<head>{% outlet "head" %}</head>{% block main %}{% add to "head" %}<link>{% endadd %}main{% endblock %}',
			}),
		});
		expect(await kiln.renderBlock("page", "main")).toBe("main");
		expect(await kiln.render("page")).toBe("<head><link></head>main");
	});

	test("needs to and a string name, and an endadd", async () => {
		expect(await errorCode('{% add "head" %}{% endadd %}')).toBe(
			"unexpected-token",
		);
		expect(await errorCode("{% add to head %}{% endadd %}")).toBe(
			"unexpected-token",
		);
		expect(await errorCode('{% add to "head" %}')).toBe("unclosed-block");
	});
});
