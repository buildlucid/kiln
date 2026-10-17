import { describe, expect, test } from "vite-plus/test";
import { bindingAt, bindingsAt, templateScopes } from "./scopes.js";

describe("templateScopes", () => {
	const text = [
		"{% set total = 0 %}",
		"{% for item in items %}{% set total = total + 1 %}{% set note = item %}[1]{% endfor %}",
		"[2]{% macro card(title) %}[3]{% endmacro %}[4]",
	].join("\n");
	const scopes = templateScopes(text, () => false);
	const at = (marker: string) => text.indexOf(marker);
	const names = (marker: string) =>
		bindingsAt(scopes, at(marker))
			.map((binding) => binding.name)
			.sort();

	test("follows Kiln's scope rules", () => {
		expect(names("[1]")).toEqual(["item", "note", "total"]);
		// The loop's variables end with it, and `card`'s argument only exists inside it.
		expect(names("[2]")).toEqual(["total"]);
		expect(names("[3]")).toEqual(["title", "total"]);
		expect(names("[4]")).toEqual(["total"]);
	});

	test("a set updates a visible variable rather than declaring a new one", () => {
		const total = bindingAt(scopes, "total", at("[1]"));
		expect(total?.definition.start).toBe(text.indexOf("total"));
		expect(
			scopes.bindings.filter((binding) => binding.name === "total"),
		).toHaveLength(1);
	});
});
