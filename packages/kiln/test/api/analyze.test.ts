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

	test("reports loop and slots where Kiln doesn't provide them, but not what macros read", async () => {
		const analysis = await kiln.analyze(
			"page",
			"{% for x in xs %}{{ loop.index }}{% endfor %}{{ loop }}{{ slots }}{% macro m() %}{{ inner }}{% endmacro %}",
		);
		expect(analysis.variables).toEqual(["xs", "loop", "slots"]);
	});

	test("reports islands, and what their props and fallbacks read", async () => {
		const analysis = await kiln.analyze(
			"page",
			'{% island "components/stock" with { id: product.id } %}{{ loading }}{% endisland %}',
		);
		expect(analysis.variables).toEqual(["product", "loading"]);
		expect(analysis.templates.map((t) => [t.kind, t.name])).toEqual([
			["island", "components/stock.kiln"],
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

	test("reports each function call with its literal arguments", async () => {
		const analysis = await kiln.analyze(
			"page",
			'{{ document("page", locale: "en") }}{% macro m() %}{% endmacro %}{{ m() }}{{ document(kind, ...rest) }}',
		);
		expect(analysis.calls).toMatchObject([
			{
				name: "document",
				args: [
					{ name: null, literal: true, value: "page" },
					{ name: "locale", literal: true, value: "en" },
				],
				start: { line: 1, column: 4 },
			},
			{
				name: "document",
				args: [
					{ name: null, literal: false, value: null },
					{ name: null, literal: false, value: null },
				],
			},
		]);
	});

	test("reports variables set at the top level", async () => {
		const analysis = await kiln.analyze(
			"page",
			'{% extends "base" %}{% set title = "T" %}{% set intro %}Hi{% endset %}{% block b %}{% set local = 1 %}{% endblock %}',
		);
		expect(analysis.sets).toEqual(["title", "intro"]);
	});

	test("reports exports, with the values of literal ones", async () => {
		const analysis = await kiln.analyze(
			"page",
			'{% export revalidate = 300 %}{% export paths = document("post")|map(post => post.url) %}',
		);
		expect(analysis.exports).toEqual([
			{ name: "revalidate", literal: true, value: 300 },
			{ name: "paths", literal: false, value: null },
		]);
		expect(analysis.variables).toEqual([]);
		expect(analysis.functions).toEqual(["document"]);
	});

	test("reports list, shape and host types", async () => {
		const analysis = await createKiln({
			loader: memoryLoader({}),
			types: { Post: () => true },
		}).analyze("card", "{% props posts: Post[], link: { href?: string } %}");
		expect(analysis.props.map((prop) => prop.type)).toEqual([
			[{ list: [{ named: "Post" }] }],
			[
				{
					shape: [{ name: "href", optional: true, type: ["string"] }],
				},
			],
		]);
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
