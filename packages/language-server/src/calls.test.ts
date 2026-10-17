import { describe, expect, test } from "vite-plus/test";
import { callContext, splitParameters } from "./calls.js";

/** The call context at `‸`. */
const at = (marked: string) =>
	callContext(marked.replace("‸", ""), marked.indexOf("‸"));

describe("callContext", () => {
	test("finds the call and argument around the cursor in half-typed text", () => {
		expect(at('{{ testPages("tags", ‸')).toMatchObject({
			kind: "function",
			name: "testPages",
			index: 1,
			named: null,
			namePosition: true,
		});
		expect(at('{{ testPages("tags", limit: ‸ }}')).toMatchObject({
			index: 1,
			named: "limit",
			namePosition: false,
		});
		expect(at('{{ testPages("a, b", li‸')).toMatchObject({
			index: 1,
			start: 21,
		});
		expect(at("{{ x|markdown(‸")).toMatchObject({
			kind: "filter",
			name: "markdown",
		});
		expect(at("{{ a(b(1), ‸")).toMatchObject({ name: "a", index: 1 });
		expect(at("{{ a(limit: 1, ‸")).toMatchObject({ sawNamed: true });
		expect(at('{{ a("ta‸')).toMatchObject({ index: 0, namePosition: false });
	});

	test("ignores grouping, method calls and finished calls", () => {
		expect(at("{% if not (a‸")).toBeNull();
		expect(at("{{ page.load(‸")).toBeNull();
		expect(at("{{ a(1) ‸")).toBeNull();
		expect(at("{{ a(1) }} ‸")).toBeNull();
	});
});

test("splitParameters splits at top-level commas only", () => {
	expect(
		splitParameters(
			"a: string, b?: { c: number; d: Map<string, number> }, ...e: (() => void)[]",
		).map((part) => part.text),
	).toEqual([
		"a: string",
		"b?: { c: number; d: Map<string, number> }",
		"...e: (() => void)[]",
	]);
});
