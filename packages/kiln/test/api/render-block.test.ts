import { describe, expect, test } from "vite-plus/test";
import {
	createKiln,
	type KilnOptions,
	KilnRenderError,
	memoryLoader,
} from "../../src/index.js";
import { later } from "../helpers.js";

const layout =
	'{% props title = "Site" %}<html><title>{{ title }}</title>{% block content %}base{% endblock %}{% block aside %}aside{% endblock %}</html>';

const create = (
	templates: Record<string, string>,
	options: Omit<KilnOptions, "loader"> = {},
) => createKiln({ ...options, loader: memoryLoader(templates) });

describe("renderBlock", () => {
	test("renders only the named block", async () => {
		const kiln = create({
			search:
				"<form></form>{% block results %}{{ query }}{% endblock %}<footer>",
		});
		expect(await kiln.renderBlock("search", "results", { query: "q" })).toBe(
			"q",
		);
	});

	test("templates the block includes render in full", async () => {
		const kiln = create({
			page: '<h1></h1>{% block list %}{% include "item" %}{% endblock %}',
			item: "<li>{% block label %}item{% endblock %}</li>",
		});
		expect(await kiln.renderBlock("page", "list")).toBe("<li>item</li>");
	});

	test("uses the most derived definition, and parent() works", async () => {
		const kiln = create({
			base: layout,
			page: '{% extends "base" %}{% block content %}page {{ parent() }}{% endblock %}',
		});
		expect(await kiln.renderBlock("page", "content")).toBe("page base");
		expect(await kiln.renderBlock("page", "aside")).toBe("aside");
	});

	test("runs a child template's top-level statements first", async () => {
		const kiln = create(
			{
				base: layout,
				page: '{% extends "base" %}{% set post = load() %}{% block content %}{{ post }}{% endblock %}',
			},
			{ functions: { load: () => later("loaded") } },
		);
		expect(await kiln.renderBlock("page", "content")).toBe("loaded");
	});

	test("applies the top-most template's props", async () => {
		const kiln = create({
			base: layout,
			page: '{% extends "base" %}{% block content %}{{ title }}{% endblock %}',
		});
		expect(await kiln.renderBlock("page", "content")).toBe("Site");
	});

	test("does not see variables the layout sets around the block", async () => {
		const kiln = create({
			base: "{% for item in [1] %}{% block row %}{% endblock %}{% endfor %}",
			page: '{% extends "base" %}{% block row %}{{ item }}{% endblock %}',
		});
		await expect(kiln.renderBlock("page", "row")).rejects.toMatchObject({
			code: "undefined-variable",
		});
	});

	test("a missing block is an error", async () => {
		const kiln = create({ page: "{% block content %}{% endblock %}" });
		const error = await kiln.renderBlock("page", "contnet").catch((e) => e);
		expect(error).toBeInstanceOf(KilnRenderError);
		expect(error.code).toBe("unknown-block");
		expect(error.message).toContain('Did you mean "content"?');
	});
});
