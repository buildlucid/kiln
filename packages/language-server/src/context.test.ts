import { describe, expect, test } from "vite-plus/test";
import {
	cursorContext,
	openBlocks,
	symbolAt,
	templateStrings,
} from "./context.js";

/** The context at the `|` marker in `source`. */
const at = (source: string) => {
	const offset = source.indexOf("‸");
	return cursorContext(source.replace("‸", ""), offset);
};

describe("cursorContext", () => {
	test("is null outside delimiters and inside comments", () => {
		expect(at("<p>‸</p>")).toBeNull();
		expect(at("{{ a }} ‸")).toBeNull();
		expect(at("{# {{ a‸ #}")).toBeNull();
	});

	test("finds a tag name, and an existing %} to replace", () => {
		expect(at("{% i‸")).toEqual({
			kind: "tag",
			start: 3,
			end: null,
			open: null,
		});
		expect(at("{% if a %}{% e‸ %}")).toEqual({
			kind: "tag",
			start: 13,
			end: 17,
			open: "if",
		});
	});

	test("finds filters, tests and loop properties", () => {
		expect(at("{{ a|up‸ }}")).toMatchObject({ kind: "filter", start: 5 });
		expect(at("{{ a | ‸")).toMatchObject({ kind: "filter" });
		expect(at("{{ a || b‸")).toMatchObject({ kind: "expression" });
		expect(at("{% if a is not em‸")).toMatchObject({ kind: "test", start: 15 });
		expect(at("{{ loop.ind‸")).toMatchObject({ kind: "loop", start: 8 });
		expect(at("{{ post.ti‸")).toBeNull();
	});

	test("finds template names in strings", () => {
		expect(at('{% extends "layouts/b‸')).toEqual({
			kind: "template",
			start: 12,
			prefix: "layouts/b",
		});
		expect(at("{% include 'x‸")).toMatchObject({
			kind: "template",
			prefix: "x",
		});
	});

	test("finds a prop key in a component's with hash", () => {
		expect(at('{% component "card" with { title: a, u‸')).toEqual({
			kind: "prop",
			start: 37,
			template: "card",
		});
		expect(at('{% component "card" with { title: ‸')).toMatchObject({
			kind: "expression",
		});
	});
});

describe("openBlocks", () => {
	test("lists block tags left open, ignoring sets with = and short blocks", () => {
		const source =
			'{% block content %}{% set a = 1 %}{% block title "x" %}{% for a in b %}{% if a %}{% endif %}';
		expect(openBlocks(source, source.length)).toEqual(["block", "for"]);
	});
});

describe("symbolAt", () => {
	const symbol = (source: string) => {
		const offset = source.indexOf("‸");
		return symbolAt(source.replace("‸", ""), offset);
	};

	test("tells filters, tests, functions, loop properties and variables apart", () => {
		expect(symbol("{{ a|up‸per }}")).toMatchObject({
			kind: "filter",
			name: "upper",
		});
		expect(symbol("{{ a is od‸d }}")).toMatchObject({
			kind: "test",
			name: "odd",
		});
		expect(symbol("{{ a is divis‸ible by(3) }}")).toMatchObject({
			kind: "test",
			name: "divisible by",
		});
		expect(symbol("{{ a is divisible b‸y(3) }}")).toMatchObject({
			name: "divisible by",
		});
		expect(symbol("{{ ran‸ge(1, 3) }}")).toMatchObject({
			kind: "function",
			name: "range",
		});
		expect(symbol("{{ loop.fi‸rst }}")).toMatchObject({
			kind: "loop",
			name: "first",
		});
		expect(symbol("{{ ti‸tle }}")).toMatchObject({
			kind: "variable",
			name: "title",
		});
		expect(symbol("{{ post.ti‸tle }}")).toBeNull();
		expect(symbol("<p>ti‸tle</p>")).toBeNull();
	});

	test("finds tag names, including end tags, but not a tag's arguments", () => {
		expect(symbol("{% fo‸r post in posts %}")).toEqual({
			kind: "tag",
			name: "for",
			start: 3,
			end: 6,
		});
		expect(symbol("{%- endf‸or %}")).toMatchObject({
			kind: "tag",
			name: "endfor",
		});
		expect(symbol("{% for po‸st in posts %}")).toMatchObject({
			kind: "variable",
		});
	});

	test("finds template names", () => {
		expect(symbol('{% include "components/ca‸rd" %}')).toEqual({
			kind: "template",
			name: "components/card",
			start: 12,
			end: 27,
		});
	});
});

describe("templateStrings", () => {
	test("lists every template name written as a string", () => {
		expect(
			templateStrings("{% extends 'base' %}{% from \"macros\" import a %}").map(
				(found) => found.name,
			),
		).toEqual(["base", "macros"]);
	});
});
