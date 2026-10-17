import { describe, expect, test } from "vite-plus/test";
import { lex, scanParts } from "./lexer.js";

describe("lexer", () => {
	test("tokens carry offsets", () => {
		const { tokens, problems } = lex('a{{ x.y|f("s") }}');
		expect(problems).toEqual([]);
		expect(tokens.map((t) => [t.type, t.value, t.start, t.end])).toEqual([
			["text", "a", 0, 1],
			["outputOpen", "{{", 1, 3],
			["name", "x", 4, 5],
			["punct", ".", 5, 6],
			["name", "y", 6, 7],
			["punct", "|", 7, 8],
			["name", "f", 8, 9],
			["punct", "(", 9, 10],
			["string", "s", 10, 13],
			["punct", ")", 13, 14],
			["outputClose", "}}", 15, 17],
			["eof", "", 17, 17],
		]);
	});

	test("interpolated strings split into parts", () => {
		const { tokens } = lex('{{ "a#{ b }c" }}');
		expect(tokens.map((t) => t.type)).toEqual([
			"outputOpen",
			"stringStart",
			"string",
			"interpOpen",
			"name",
			"interpClose",
			"string",
			"stringEnd",
			"outputClose",
			"eof",
		]);
	});

	test("numbers after a dot are integers, so items.0.1 reads two indexes", () => {
		const { tokens } = lex("{{ items.0.1 }}");
		expect(
			tokens.filter((t) => t.type === "number").map((t) => t.value),
		).toEqual(["0", "1"]);
	});

	test("standalone lines keep text on other lines untouched", () => {
		const text = lex("a\n  {% if x %}  \nb\n").tokens.filter(
			(t) => t.type === "text",
		);
		expect(text.map((t) => t.value)).toEqual(["a\n", "b\n"]);
	});

	test("a byte order mark is skipped, and offsets still count it", () => {
		const { tokens } = lex("\uFEFFa{{ x }}");
		expect(tokens.slice(0, 2).map((t) => [t.type, t.value, t.start])).toEqual([
			["text", "a", 1],
			["outputOpen", "{{", 2],
		]);
	});

	test("an endverbatim tag keeps its trim markers", () => {
		const end = scanParts("{% verbatim %}x{%- endverbatim -%}").parts.at(-1);
		expect(
			end?.kind === "tag" && end.tokens.map((t) => [t.value, t.start, t.end]),
		).toEqual([
			["{%-", 15, 17],
			["endverbatim", 19, 30],
			["-%}", 32, 34],
		]);
	});
});
