import { globSync, readFileSync } from "node:fs";
import htmlDerivative from "@shikijs/langs/html-derivative";
import { createHighlighterCore, type LanguageRegistration } from "shiki/core";
import { createOnigurumaEngine } from "shiki/engine/oniguruma";
import { describe, expect, test } from "vite-plus/test";
import grammar from "./kiln.tmLanguage.json" with { type: "json" };

const repo = new URL("../../../", import.meta.url);

// The same regex engine as VS Code. VS Code embeds its HTML grammar as `text.html.derivative`, and Shiki ships it too.
const highlighter = await createHighlighterCore({
	engine: createOnigurumaEngine(import("shiki/wasm")),
	langs: [
		htmlDerivative,
		{ ...(grammar as unknown as LanguageRegistration), name: "kiln" },
	],
});

/** The scopes of the `nth` token in `code` whose text is exactly `text`, innermost last, without the root scope. */
const scopesOf = (code: string, text: string, nth = 0): string[] => {
	const tokens = highlighter
		.codeToTokensBase(code, { lang: "kiln", includeExplanation: "scopeName" })
		.flat()
		.flatMap((token) => token.explanation ?? [])
		.filter((token) => token.content === text);
	const token = tokens[nth];
	if (!token) throw new Error(`No token ${JSON.stringify(text)} in ${code}`);
	return token.scopes.slice(1).map((scope) => scope.scopeName);
};

/** The innermost scope of a token, as `scopesOf` finds it. */
const scopeOf = (code: string, text: string, nth = 0): string | undefined =>
	scopesOf(code, text, nth).at(-1);

describe("Kiln grammar", () => {
	test("output and tag delimiters, with whitespace control", () => {
		const code = "{{- name -}}{% if a -%}{%- endif %}";
		expect(scopeOf(code, "{{-")).toBe(
			"punctuation.section.embedded.begin.kiln",
		);
		expect(scopeOf(code, "-}}")).toBe("punctuation.section.embedded.end.kiln");
		expect(scopeOf(code, "if")).toBe("keyword.control.kiln");
		expect(scopeOf(code, "-%}")).toBe("punctuation.section.embedded.end.kiln");
		expect(scopeOf(code, "endif")).toBe("keyword.control.kiln");
	});

	test("Kiln inside HTML attribute values and between attributes", () => {
		const code = `<a href="/{{ url }}" {% if on %}hidden{% endif %}>`;
		// `meta.embedded` tells VS Code the expression is code, not part of the HTML string.
		expect(scopesOf(code, "url")).toEqual([
			"meta.tag.inline.a.start.html",
			"meta.attribute.href.html",
			"string.quoted.double.html",
			"meta.embedded.output.kiln",
			"source.kiln",
			"variable.other.readwrite.kiln",
		]);
		expect(scopeOf(code, "on")).toBe("variable.other.readwrite.kiln");
		expect(scopeOf(code, "hidden")).toBe("entity.other.attribute-name.html");
	});

	test("Kiln straight after a tag name", () => {
		const code = `<button{{ attrs({ type: "submit" }) }} disabled>`;
		expect(scopeOf(code, "button")).toBe("entity.name.tag.html");
		expect(scopeOf(code, "attrs")).toBe("entity.name.function.kiln");
		expect(scopeOf(code, "disabled")).toBe("entity.other.attribute-name.html");
		expect(scopeOf(code, ">")).toBe("punctuation.definition.tag.end.html");
	});

	test("Kiln inside script and style", () => {
		const script = "<script>const items = {{ items|json }};</script>";
		expect(scopesOf(script, "json")).toContain("source.js");
		expect(scopeOf(script, "json")).toBe("entity.name.function.filter.kiln");
		const style = "<style>a { color: {{ colour }}; }</style>";
		expect(scopesOf(style, "colour")).toContain("source.css");
		expect(scopeOf(style, "colour")).toBe("variable.other.readwrite.kiln");
	});

	test("filters, tests and word operators", () => {
		const code =
			"{{ n is not divisible by(3) and title starts with 'a' ? list|join(', ') : '' }}";
		expect(scopeOf(code, "is")).toBe("keyword.operator.word.kiln");
		expect(scopeOf(code, "not")).toBe("keyword.operator.word.kiln");
		expect(scopeOf(code, "divisible")).toBe("entity.name.function.test.kiln");
		expect(scopeOf(code, "by")).toBe("entity.name.function.test.kiln");
		expect(scopeOf(code, "and")).toBe("keyword.operator.word.kiln");
		expect(scopeOf(code, "starts with")).toBe("keyword.operator.word.kiln");
		expect(scopeOf(code, "join")).toBe("entity.name.function.filter.kiln");
	});

	test("literals, members, calls and arrow functions", () => {
		const code =
			"{{ [1_000, 2.5, true, null, loop.index, user?.name, range(1, 3)|map(n => n ** 2)] }}";
		expect(scopeOf(code, "1_000")).toBe("constant.numeric.kiln");
		expect(scopeOf(code, "true")).toBe("constant.language.boolean.kiln");
		expect(scopeOf(code, "null")).toBe("constant.language.null.kiln");
		expect(scopeOf(code, "loop")).toBe("variable.language.kiln");
		expect(scopeOf(code, "?.")).toBe("punctuation.accessor.kiln");
		expect(scopeOf(code, "name")).toBe("variable.other.property.kiln");
		expect(scopeOf(code, "range")).toBe("entity.name.function.kiln");
		expect(scopeOf(code, "n")).toBe("variable.parameter.kiln");
		expect(scopeOf(code, "=>")).toBe("storage.type.function.arrow.kiln");
	});

	test("hash keys and named arguments", () => {
		const code = `{% component "card" with { title: post.title, ...rest } %}{{ dump(depth: 2) }}`;
		expect(scopeOf(code, "with")).toBe("keyword.control.kiln");
		expect(scopeOf(code, "title")).toBe("support.type.property-name.kiln");
		expect(scopeOf(code, "...")).toBe("keyword.operator.spread.kiln");
		expect(scopeOf(code, "depth")).toBe("variable.parameter.kiln");
	});

	test("strings, escapes and interpolation", () => {
		const code = `{{ "Hi #{user.name}\\n" ~ 'it\\'s' }}`;
		expect(scopeOf(code, "#{")).toBe(
			"punctuation.section.interpolation.begin.kiln",
		);
		expect(scopesOf(code, "user")).toContain("meta.embedded.line.kiln");
		expect(scopeOf(code, "\\n")).toBe("constant.character.escape.kiln");
		expect(scopeOf(code, "\\'")).toBe("constant.character.escape.kiln");
		expect(scopeOf(code, "~")).toBe("keyword.operator.string.kiln");
	});

	test("comments and verbatim leave their contents alone", () => {
		expect(scopesOf("{# {{ x }} #}", " {{ x }} ")).toEqual([
			"comment.block.kiln",
		]);
		expect(
			scopesOf("{% verbatim %}{{ x }}{% endverbatim %}", "{{ x }}"),
		).toEqual(["meta.verbatim.kiln", "meta.raw.kiln"]);
	});

	test("props and their types", () => {
		const code = `{% props title: string | null = "Hi", items: { id: Post, n?: number }[], ...attributes %}`;
		expect(scopeOf(code, "title")).toBe("variable.parameter.kiln");
		expect(scopeOf(code, "string")).toBe("support.type.primitive.kiln");
		expect(scopeOf(code, "|")).toBe("keyword.operator.type.kiln");
		expect(scopeOf(code, "Hi")).toBe("string.quoted.double.kiln");
		expect(scopeOf(code, "id")).toBe("variable.other.property.kiln");
		expect(scopeOf(code, "Post")).toBe("entity.name.type.kiln");
		expect(scopeOf(code, "?")).toBe("keyword.operator.optional.kiln");
		expect(scopeOf(code, "attributes")).toBe("variable.parameter.kiln");
	});

	test("names that blocks, macros, apply and from define or use", () => {
		const code = `{% block title %}{% endblock title %}{% macro card(size = 1) %}{% endmacro card %}{% apply upper | trim %}{% endapply %}{% from "forms" import input as field %}`;
		expect(scopeOf(code, "title")).toBe("entity.name.section.kiln");
		expect(scopeOf(code, "title", 1)).toBe("entity.name.section.kiln");
		expect(scopeOf(code, "card")).toBe("entity.name.function.macro.kiln");
		expect(scopeOf(code, "card", 1)).toBe("entity.name.function.macro.kiln");
		expect(scopeOf(code, "size")).toBe("variable.parameter.kiln");
		expect(scopeOf(code, "upper")).toBe("entity.name.function.filter.kiln");
		expect(scopeOf(code, "trim")).toBe("entity.name.function.filter.kiln");
		expect(scopeOf(code, "field")).toBe("entity.name.function.kiln");
	});

	// A Kiln region left open swallows the rest of the file, so every template in this repository must close them all.
	test("every template in the repository ends outside Kiln", () => {
		const files = globSync("{apps,packages}/**/*.kiln", {
			cwd: repo,
			exclude: (file) => file.includes("node_modules"),
		});
		expect(files).not.toHaveLength(0);
		const open = files.filter((file) =>
			highlighter
				.getLastGrammarState(readFileSync(new URL(file, repo), "utf8"), {
					lang: "kiln",
				})
				.getScopes()
				?.some(
					(scope) => scope.endsWith(".kiln") && scope !== "text.html.kiln",
				),
		);
		expect(open).toEqual([]);
	});
});
