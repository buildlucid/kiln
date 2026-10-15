import { describe, expect, test } from "vite-plus/test";
import { createKiln, memoryLoader } from "../../src/index.js";
import { lines } from "../helpers.js";

const kiln = createKiln({
	loader: memoryLoader({}),
	globals: { site: {} },
	functions: { document: () => null },
});

describe("analyze", () => {
	test("reports what a template uses", async () => {
		const analysis = await kiln.analyze(
			"pages/page",
			lines(
				'{% extends "layouts/base" %}',
				'{% import "macros/forms" as forms %}',
				"{% props title, size = 'md' %}",
				'{% set page = document("page", fullSlug: route.path) %}',
				"{% macro badge(text) %}{{ text|upper }}{% endmacro %}",
				"{% block content %}",
				"{% for item in page.items %}{{ item.title }}{{ loop.index }}{{ site.name }}{% endfor %}",
				'{% include "partials/" ~ kind with { page } %}',
				"{{ forms.input(x) }}{{ badge(y) }}{% if z is defined %}{% endif %}",
				"{% endblock %}",
			),
		);
		expect(analysis).toMatchObject({
			diagnostics: [],
			variables: ["route", "kind", "x", "y", "z"],
			props: [
				{ name: "title", required: true },
				{ name: "size", required: false },
			],
			functions: ["document"],
			filters: ["upper"],
			tests: ["defined"],
			blocks: ["content"],
			macros: ["badge"],
		});
		expect(analysis.templates.map((t) => [t.kind, t.name])).toEqual([
			["import", "macros/forms.kiln"],
			["extends", "layouts/base.kiln"],
			["include", null],
		]);
	});

	test("reports prop types", async () => {
		const analysis = await kiln.analyze(
			"components/button",
			'{% props label: string, variant: "primary" | 2 | null = null, icon %}',
		);
		expect(analysis.props).toEqual([
			{ name: "label", required: true, type: ["string"] },
			{
				name: "variant",
				required: false,
				type: [{ literal: "primary" }, { literal: 2 }, "null"],
			},
			{ name: "icon", required: true, type: null },
		]);
	});

	test("finds nested imports and child sets written after blocks", async () => {
		const analysis = await kiln.analyze(
			"page",
			'{% extends "base" %}{% block b %}{{ title }}{% if x %}{% import "m" as forms %}{% endif %}{{ forms.input() }}{% endblock %}{% set title = "T" %}',
		);
		expect(analysis.variables).toEqual(["x"]);
		expect(analysis.templates.map((t) => t.name)).toContain("m.kiln");
	});

	test("includes diagnostics for invalid templates", async () => {
		const analysis = await kiln.analyze("bad", "{{ x|nope }}");
		expect(analysis.diagnostics.map((d) => d.code)).toEqual(["unknown-filter"]);
	});
});

describe("deep templates", () => {
	test("analyzing a very long chain reports it instead of overflowing", async () => {
		const analysis = await kiln.analyze(
			"deep",
			`{{ x${" + 1".repeat(20_000)} }}`,
		);
		expect(analysis.diagnostics.map((d) => d.code)).toEqual(["too-deep"]);
	});
});
