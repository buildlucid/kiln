import { describe, expect, test } from "vite-plus/test";
import { KilnIssue } from "./errors.js";
import { resolveTemplateName } from "./names.js";

describe("resolveTemplateName", () => {
	test("adds the .kiln extension when the name has none", () => {
		expect(resolveTemplateName("pages/home")).toBe("pages/home.kiln");
		expect(resolveTemplateName("pages/home.kiln")).toBe("pages/home.kiln");
		expect(resolveTemplateName("data/config.json")).toBe("data/config.json");
	});

	test("resolves ./ and ../ against the directory of the current template", () => {
		expect(resolveTemplateName("./card", "components/list.kiln")).toBe(
			"components/card.kiln",
		);
		expect(resolveTemplateName("../layouts/base", "pages/blog/post.kiln")).toBe(
			"pages/layouts/base.kiln",
		);
		expect(resolveTemplateName("./a/../b", "x/y.kiln")).toBe("x/b.kiln");
	});

	test("other names are relative to the root, wherever they are used", () => {
		expect(resolveTemplateName("partials/nav", "pages/home.kiln")).toBe(
			"partials/nav.kiln",
		);
	});

	test.each([
		["", undefined],
		["/abs", undefined],
		["a\\b", undefined],
		["a//b", undefined],
		["../up", "index.kiln"],
		["./a/../../up", "index.kiln"],
	])("refuses %j", (name, from) => {
		expect(() => resolveTemplateName(name, from)).toThrow(KilnIssue);
	});
});
