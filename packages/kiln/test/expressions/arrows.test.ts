import { describe, expect, test } from "vite-plus/test";
import { errorCode, render } from "../helpers.js";

const items = [1, 2, 3];

describe("arrow functions", () => {
	test("take one parameter without parentheses", async () => {
		expect(
			await render('{{ items|map(i => i * 2)|join(",") }}', {
				context: { items },
			}),
		).toBe("2,4,6");
	});

	test("take several parameters in parentheses", async () => {
		expect(
			await render("{{ items|reduce((total, i) => total + i, 0) }}", {
				context: { items },
			}),
		).toBe("6");
	});

	test("receive the key or index as their second argument", async () => {
		expect(
			await render('{{ items|map((i, index) => index)|join(",") }}', {
				context: { items },
			}),
		).toBe("0,1,2");
	});

	test("can read outer variables", async () => {
		const template =
			'{% set factor = 10 %}{{ items|map(i => i * factor)|join(",") }}';
		expect(await render(template, { context: { items } })).toBe("10,20,30");
	});

	test("parameters shadow outer variables", async () => {
		const template =
			'{% set i = "outer" %}{{ items|map(i => i)|join(",") }}|{{ i }}';
		expect(await render(template, { context: { items } })).toBe("1,2,3|outer");
	});

	test("can be passed as named arguments", async () => {
		expect(
			await render('{{ items|sort(by: i => -i)|join(",") }}', {
				context: { items },
			}),
		).toBe("3,2,1");
	});

	test("cannot be stored in a variable", async () => {
		expect(await errorCode("{% set f = x => x %}")).toBe("invalid-arrow");
	});

	test("cannot be printed", async () => {
		expect(await errorCode("{{ (x) => x }}")).toBe("invalid-arrow");
	});
});

describe("edge cases", () => {
	test("can take no parameters", async () => {
		expect(await render("{{ [1, 2]|map(() => 0)|join }}")).toBe("00");
	});

	test("can return a hash", async () => {
		expect(await render('{{ [1]|map(x => { v: x })|column("v")|join }}')).toBe(
			"1",
		);
	});

	test("nested arrows see the outer parameter", async () => {
		expect(
			await render(
				'{{ [1, 2]|map(a => [10]|map(b => a + b)|first)|join(",") }}',
			),
		).toBe("11,12");
	});

	test("can read loop", async () => {
		expect(
			await render(
				"{% for i in [1, 2] %}{{ [0]|map(x => loop.index)|join }}{% endfor %}",
			),
		).toBe("12");
	});

	test("bodies only run when called", async () => {
		expect(await render("[{{ []|map(x => nope)|join }}]")).toBe("[]");
	});

	test("parameters cannot use reserved names or literals", async () => {
		expect(await errorCode("{{ [1]|map(loop => 1) }}")).toBe("reserved-name");
		expect(await errorCode("{{ [1]|map(true => 1) }}")).not.toBe("");
	});

	test("cannot sit in hashes or arrays", async () => {
		expect(await errorCode("{{ { f: x => x }.f }}")).toBe("invalid-arrow");
		expect(await errorCode("{{ [x => x]|length }}")).toBe("invalid-arrow");
	});

	test("a parenthesised value is not mistaken for an arrow", async () => {
		expect(await render('{{ ["a", "b"]|join(("-")) }}')).toBe("a-b");
	});
});
