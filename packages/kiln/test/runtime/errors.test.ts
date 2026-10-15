import { describe, expect, test } from "vite-plus/test";
import { KilnRenderError, KilnSyntaxError } from "../../src/index.js";
import { lines, renderError } from "../helpers.js";

describe("render errors", () => {
	test("name the template, line and column, with a hint and a code frame", async () => {
		const error = await renderError(
			lines("{% block content %}", "  <h1>{{ titel }}</h1>", "{% endblock %}"),
			{
				context: { title: "x" },
			},
		);
		expect(error).toBeInstanceOf(KilnRenderError);
		expect(error).toMatchObject({
			code: "undefined-variable",
			template: "index.kiln",
			line: 2,
			column: 10,
		});
		expect(error.message).toBe(
			lines(
				'Unknown variable "titel" in index.kiln at line 2, column 10. Did you mean "title"?',
				"",
				"  1 | {% block content %}",
				"> 2 |   <h1>{{ titel }}</h1>",
				"    |          ^^^^^",
				"  3 | {% endblock %}",
			),
		);
	});

	test("record the chain of includes", async () => {
		const error = (await renderError(lines("line one", '{% include "a" %}'), {
			templates: { a: "{% include 'b' %}", b: "\n\n{{ boom }}" },
		})) as KilnRenderError;
		expect(error.templateStack).toEqual([
			{ template: "index.kiln", line: 2, column: 1 },
			{ template: "a.kiln", line: 1, column: 1 },
			{ template: "b.kiln", line: 3, column: 4 },
		]);
	});

	test("in imported macros record the call site", async () => {
		const error = (await renderError(
			lines('{% import "lib" as lib %}', "{{ lib.boom() }}"),
			{
				templates: { lib: "{% macro boom() %}{{ nope }}{% endmacro %}" },
			},
		)) as KilnRenderError;
		expect(
			error.templateStack.map((entry) => [entry.template, entry.line]),
		).toEqual([
			["index.kiln", 2],
			["lib.kiln", 1],
		]);
	});

	test("in fills record the component that output them", async () => {
		const error = (await renderError(
			'{% component "box" %}{{ nope }}{% endcomponent %}',
			{
				templates: { box: "\n{% slot %}{% endslot %}" },
			},
		)) as KilnRenderError;
		expect(error.templateStack.map((entry) => entry.template)).toEqual([
			"index.kiln",
			"box.kiln",
			"index.kiln",
		]);
	});

	test("in child blocks record where the layout placed them", async () => {
		const error = (await renderError(
			lines('{% extends "base" %}', "{% block b %}{{ nope }}{% endblock %}"),
			{
				templates: { base: "\n\n{% block b %}{% endblock %}" },
			},
		)) as KilnRenderError;
		expect(
			error.templateStack.map((entry) => [entry.template, entry.line]),
		).toEqual([
			["index.kiln", 1],
			["base.kiln", 3],
			["index.kiln", 2],
		]);
	});

	test("from host functions keep the original error as cause", async () => {
		const original = new Error("not found");
		const error = (await renderError("{{ load() }}", {
			functions: { load: async () => Promise.reject(original) },
		})) as KilnRenderError;
		expect(error.code).toBe("host-error");
		expect(error.cause).toBe(original);
	});
});

describe("syntax errors", () => {
	test("list every problem in source order", async () => {
		const error = (await renderError(
			lines("{{ 1 + }}", "{{ x|nope }}", "{% if %}{% endif %}"),
		)) as KilnSyntaxError;
		expect(error).toBeInstanceOf(KilnSyntaxError);
		expect(error.diagnostics.map((d) => [d.code, d.start.line])).toEqual([
			["unexpected-token", 1],
			["unknown-filter", 2],
			["unexpected-token", 3],
		]);
		expect(error.message).toContain("2 more problems found.");
	});
});
