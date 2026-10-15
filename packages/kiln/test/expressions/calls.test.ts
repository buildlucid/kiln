import { describe, expect, test } from "vite-plus/test";
import { errorCode, render } from "../helpers.js";

describe("host functions", () => {
	test("receive named arguments as one trailing hash", async () => {
		const received: unknown[][] = [];
		const fetch = (...args: unknown[]) => {
			received.push(args);
			return "ok";
		};
		await render('{{ fetch("page", fullSlug: "/", limit: 2) }}', {
			functions: { fetch },
		});
		expect(received).toEqual([["page", { fullSlug: "/", limit: 2 }]]);
	});

	test("receive the same arguments from a hash literal", async () => {
		const received: unknown[][] = [];
		const fetch = (...args: unknown[]) => {
			received.push(args);
			return "ok";
		};
		await render('{{ fetch("page", { fullSlug: "/" }) }}', {
			functions: { fetch },
		});
		expect(received).toEqual([["page", { fullSlug: "/" }]]);
	});
});

describe("built-in functions", () => {
	test("take named arguments by parameter name", async () => {
		expect(await render('{{ range(start: 1, end: 3)|join(",") }}')).toBe(
			"1,2,3",
		);
	});

	test("refuse unknown named arguments", async () => {
		expect(await errorCode("{{ range(1, 3, by: 2) }}")).toBe(
			"unknown-argument",
		);
	});
});

describe("arguments", () => {
	test("can be spread from an array", async () => {
		expect(
			await render("{{ max(...numbers) }}", {
				context: { numbers: [3, 9, 2] },
			}),
		).toBe("9");
	});

	test("positional arguments cannot follow named ones", async () => {
		expect(await errorCode("{{ range(start: 1, 3) }}")).toBe(
			"positional-after-named",
		);
	});

	test("allow a trailing comma", async () => {
		expect(await render("{{ max(1, 2,) }}")).toBe("2");
	});
});

describe("calling", () => {
	test("an unknown function is an error", async () => {
		expect(await errorCode("{{ nope() }}")).toBe("unknown-function");
	});

	test("only named functions, macros and methods can be called", async () => {
		expect(await errorCode('{{ "text"(1) }}')).toBe("invalid-call");
	});

	test("the result of a call cannot be called", async () => {
		expect(
			await errorCode('{{ ""["constructor"]["constructor"]("return 1")() }}'),
		).toBe("invalid-call");
	});
});

describe("namespaces", () => {
	test("functions, filters and tests are separate", async () => {
		expect(await errorCode('{{ upper("x") }}')).toBe("unknown-function");
		expect(await errorCode("{{ 1|range(3) }}")).toBe("unknown-filter");
		expect(await errorCode("{{ 1 is upper }}")).toBe("unknown-test");
	});

	test("variables are not callable", async () => {
		expect(await errorCode('{% set f = "upper" %}{{ f() }}')).toBe(
			"unknown-function",
		);
	});

	test("a spread cannot follow named arguments", async () => {
		expect(await errorCode("{{ range(start: 1, ...[3]) }}")).toBe(
			"positional-after-named",
		);
	});
});
