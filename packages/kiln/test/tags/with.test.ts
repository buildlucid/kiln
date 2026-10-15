import { describe, expect, test } from "vite-plus/test";
import { errorCode, render } from "../helpers.js";

describe("with", () => {
	test("adds variables in a new scope", async () => {
		const template =
			'{% with { title: "Latest", count: 2 } %}{{ title }} {{ count }}{% endwith %}|{{ title ?? "gone" }}';
		expect(await render(template)).toBe("Latest 2|gone");
	});

	test("can read outer variables", async () => {
		const template =
			'{% set outer = "o" %}{% with { inner: "i" } %}{{ outer }}{{ inner }}{% endwith %}';
		expect(await render(template)).toBe("oi");
	});

	test("can take a variable holding a hash", async () => {
		expect(
			await render("{% with settings %}{{ size }}{% endwith %}", {
				context: { settings: { size: "lg" } },
			}),
		).toBe("lg");
	});

	test("set inside it stays inside it", async () => {
		expect(
			await render(
				'{% with {} %}{% set x = 1 %}{% endwith %}{{ x ?? "gone" }}',
			),
		).toBe("gone");
	});

	test("needs a hash", async () => {
		expect(await errorCode("{% with [1] %}{% endwith %}")).toBe("type-error");
	});
});

describe("scope", () => {
	test("set updates a variable that existed outside", async () => {
		expect(
			await render(
				"{% set a = 1 %}{% with {} %}{% set a = 2 %}{% endwith %}{{ a }}",
			),
		).toBe("2");
	});

	test("setting one of its own keys stays inside", async () => {
		expect(
			await render(
				'{% with { a: 1 } %}{% set a = 5 %}{{ a }}{% endwith %}{{ a ?? "gone" }}',
			),
		).toBe("5gone");
	});

	test("Twig's only keyword is not supported", async () => {
		expect(await errorCode("{% with {} only %}{% endwith %}")).toBe(
			"unexpected-token",
		);
	});
});
