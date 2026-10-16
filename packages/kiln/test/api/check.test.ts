import { describe, expect, test } from "vite-plus/test";
import { createKiln, memoryLoader } from "../../src/index.js";

describe("check", () => {
	const kiln = createKiln({ loader: memoryLoader({ saved: "{{ fine }}" }) });

	test("reports every problem in unsaved source, in source order", async () => {
		const diagnostics = await kiln.check("draft", "{{ a|nope }}\n{% if %}");
		expect(diagnostics.map((d) => d.code)).toEqual([
			"unknown-filter",
			"unclosed-block",
			"unexpected-token",
		]);
		expect(diagnostics[2]).toMatchObject({
			template: "draft.kiln",
			severity: "error",
			start: { line: 2, column: 7 },
		});
	});

	test("returns nothing for a valid template", async () => {
		expect(await kiln.check("saved")).toEqual([]);
		expect(await kiln.check("draft", "{{ fine }}")).toEqual([]);
	});

	test("reports a missing template", async () => {
		expect((await kiln.check("missing")).map((d) => d.code)).toEqual([
			"missing-template",
		]);
	});

	test("does not render, so unknown variables are not reported", async () => {
		expect(await kiln.check("draft", "{{ anything.at.all }}")).toEqual([]);
	});

	test("reports deep nesting instead of crashing", async () => {
		const deep = `{{ ${"(".repeat(1000)}1${")".repeat(1000)} }}`;
		expect((await kiln.check("a", deep)).map((d) => d.code)).toContain(
			"too-deep",
		);
		const nestedIfs = "{% if true %}".repeat(3000) + "{% endif %}".repeat(3000);
		expect((await kiln.check("b", nestedIfs)).map((d) => d.code)).toContain(
			"too-deep",
		);
	});
});

describe("check across templates", () => {
	const kiln = createKiln({
		loader: memoryLoader({
			button:
				'{% props label: string, variant: "primary" | "secondary" = "primary" %}',
			card: "{% props title %}{% slot %}{% endslot %}",
			link: "{% props href, ...attributes %}",
			"layouts/base":
				'{% props lang, title = "" %}{% block content %}{% endblock %}',
			"layouts/docs": '{% extends "layouts/base" %}{% set lang = "en" %}',
			open: "{{ anything }}",
		}),
		types: { Post: () => true },
	});
	const codes = async (source: string) =>
		(await kiln.check("draft", source)).map((d) => d.code);

	test("reports templates that don't exist", async () => {
		expect(
			await codes(
				'{% extends "nope" %}{% import "macros" as m %}{% block a %}{% include "gone" %}{% include "skip" ignore missing %}{% endblock %}',
			),
		).toEqual(["missing-template", "missing-template", "missing-template"]);
	});

	test("accepts any key for a template with a rest prop, but still needs its props", async () => {
		expect(
			await codes('{% include "link" with { href: "/", class: "x" } %}'),
		).toEqual([]);
		expect(await codes('{% include "link" with { class: "x" } %}')).toEqual([
			"missing-prop",
		]);
	});

	test("reports props passed that a template doesn't declare", async () => {
		const [missing, unknown] = await kiln.check(
			"draft",
			'{% include "button" with { lable: "Go" } %}',
		);
		expect(missing).toMatchObject({ code: "missing-prop" });
		expect(unknown).toMatchObject({
			code: "unknown-prop",
			severity: "error",
			start: { line: 1, column: 28 },
		});
		expect(unknown?.message).toContain('Did you mean "label"?');
	});

	test("reports required props that are not passed", async () => {
		expect(await codes('{% include "button" %}')).toEqual(["missing-prop"]);
		expect(await codes('{% component "card" %}Body{% endcomponent %}')).toEqual(
			["missing-prop"],
		);
		expect(await codes('{% island "card" %}Loading{% endisland %}')).toEqual([
			"missing-prop",
		]);
	});

	test("reports written-out values of the wrong type", async () => {
		expect(
			await codes(
				'{% include "button" with { label: 1, variant: "danger" } %}',
			),
		).toEqual(["prop-type", "prop-type"]);
		expect(
			await codes('{% include "button" with { label: "Go", variant: null } %}'),
		).toEqual([]);
	});

	test("skips calls it can't see into", async () => {
		expect(
			await codes(
				'{% include "button" with data %}{% include "button" with { ...data } %}{% include "but" ~ "ton" %}{% include "open" with { any: 1 } %}',
			),
		).toEqual([]);
	});

	test("reports layout props a page with props can't provide", async () => {
		expect(
			await codes('{% extends "layouts/base" %}{% props title %}'),
		).toEqual(["missing-prop"]);
		expect(
			await codes(
				'{% extends "layouts/base" %}{% props title %}{% set lang = "en" %}',
			),
		).toEqual([]);
		expect(
			await codes('{% extends "layouts/docs" %}{% props title %}'),
		).toEqual([]);
		// Without props, the render data may hold it.
		expect(await codes('{% extends "layouts/base" %}')).toEqual([]);
	});

	test("warns about undeclared variables in a template with props", async () => {
		const diagnostics = await kiln.check(
			"draft",
			'{% props title %}{% set x = 1 %}{{ titel }}{{ x }}{{ title }}{{ maybe ?? "" }}{{ other?.name }}{{ gone|default("") }}{% if what is defined %}{% endif %}',
		);
		expect(diagnostics).toMatchObject([
			{ code: "undeclared-variable", severity: "warning" },
		]);
		expect(diagnostics[0]?.message).toContain('Did you mean "title"?');
	});

	test("follows strict mode", async () => {
		const lenient = createKiln({
			loader: memoryLoader({ button: "{% props label %}" }),
			strict: false,
		});
		expect(
			await lenient.check(
				"draft",
				'{% props a %}{% include "button" %}{{ b }}',
			),
		).toEqual([]);
	});
});
