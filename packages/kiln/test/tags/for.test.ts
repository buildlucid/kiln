import { describe, expect, test } from "vite-plus/test";
import { errorCode, render } from "../helpers.js";

describe("for", () => {
	test("loops over array items", async () => {
		expect(await render("{% for x in [1, 2, 3] %}{{ x }}{% endfor %}")).toBe(
			"123",
		);
	});

	test("gives index and value with two names", async () => {
		expect(
			await render('{% for i, v in ["a", "b"] %}{{ i }}{{ v }}{% endfor %}'),
		).toBe("0a1b");
	});

	test("gives values, or keys and values, of a hash", async () => {
		const template =
			"{% for v in h %}{{ v }}{% endfor %}|{% for k, v in h %}{{ k }}={{ v }};{% endfor %}";
		expect(await render(template, { context: { h: { a: 1, b: 2 } } })).toBe(
			"12|a=1;b=2;",
		);
	});

	test("loops over maps, sets and other iterables", async () => {
		const context = {
			map: new Map([["a", 1]]),
			set: new Set(["x", "y"]),
			generated: (function* () {
				yield 1;
				yield 2;
			})(),
		};
		const template =
			"{% for k, v in map %}{{ k }}{{ v }}{% endfor %}|{% for v in set %}{{ v }}{% endfor %}|{% for v in generated %}{{ v }}{% endfor %}";
		expect(await render(template, { context })).toBe("a1|xy|12");
	});

	test("renders else when there are no items", async () => {
		const template = "{% for x in items %}{{ x }}{% else %}none{% endfor %}";
		expect(await render(template, { context: { items: [] } })).toBe("none");
	});

	test("treats null as no items", async () => {
		const template = "{% for x in items %}{{ x }}{% else %}none{% endfor %}";
		expect(await render(template, { context: { items: null } })).toBe("none");
	});

	test("cannot loop over a string", async () => {
		expect(await errorCode('{% for c in "abc" %}{{ c }}{% endfor %}')).toBe(
			"not-iterable",
		);
	});

	test("cannot loop over a number", async () => {
		expect(await errorCode("{% for c in 5 %}{{ c }}{% endfor %}")).toBe(
			"not-iterable",
		);
	});

	test("must be closed", async () => {
		expect(await errorCode("{% for x in [1] %}{{ x }}")).toBe("unclosed-block");
	});
});

describe("the loop variable", () => {
	test("describes the current position", async () => {
		const template =
			'{% for x in ["a", "b", "c"] %}{{ loop.index }}{{ loop.index0 }}{{ loop.revIndex }}{{ loop.revIndex0 }}{{ loop.first ? "F" : "-" }}{{ loop.last ? "L" : "-" }}{{ loop.length }};{% endfor %}';
		expect(await render(template)).toBe("1032F-3;2121--3;3210-L3;");
	});

	test("belongs to the innermost loop; set keeps the outer one", async () => {
		const template =
			"{% for a in [1, 2] %}{% set outer = loop %}{% for b in [1, 2] %}{{ outer.index }}{{ loop.index }};{% endfor %}{% endfor %}";
		expect(await render(template)).toBe("11;12;21;22;");
	});

	test("is restored after a nested loop ends", async () => {
		const template =
			"{% for a in [1, 2] %}{% for b in [1] %}{% endfor %}{{ loop.index }}{% endfor %}";
		expect(await render(template)).toBe("12");
	});

	test("is not defined outside a loop", async () => {
		expect(await errorCode("{{ loop.index }}")).toBe("undefined-variable");
	});

	test("cannot be assigned", async () => {
		expect(await errorCode("{% set loop = 1 %}")).toBe("reserved-name");
	});
});

describe("loop scope", () => {
	test("set updates variables that existed before the loop", async () => {
		const template =
			"{% set total = 0 %}{% for item in items %}{% set total = total + item %}{% endfor %}{{ total }}";
		expect(await render(template, { context: { items: [1, 2, 3] } })).toBe("6");
	});

	test("variables first set inside a loop stay in the loop", async () => {
		expect(
			await errorCode(
				'{% for item in [1] %}{% set label = "x" %}{% endfor %}{{ label }}',
			),
		).toBe("undefined-variable");
	});

	test("each iteration starts fresh", async () => {
		const template =
			'{% for i in [1, 2] %}{% if i == 2 %}{{ seen ?? "fresh" }}{% endif %}{% set seen = "old" %}{% endfor %}';
		expect(await render(template)).toBe("fresh");
	});

	test("the loop variable does not leak", async () => {
		expect(
			await render('{% for x in [1] %}{% endfor %}{{ x ?? "gone" }}'),
		).toBe("gone");
	});
});

describe("nesting", () => {
	test("an inner loop can reuse the outer variable's name", async () => {
		expect(
			await render(
				'{% for i in [1, 2] %}{% for i in ["a"] %}{{ i }}{% endfor %}{{ i }}{% endfor %}',
			),
		).toBe("a1a2");
	});

	test("the loop variable does not overwrite an outer variable", async () => {
		expect(
			await render(
				'{% set item = "x" %}{% for item in [1] %}{% endfor %}{{ item }}',
			),
		).toBe("x");
	});

	test("the inner loop's sequence can read the outer loop", async () => {
		expect(
			await render(
				'{% for i in ["a", "b"] %}{% for j in [loop.index] %}{{ i }}{{ j }}{% endfor %}{% endfor %}',
			),
		).toBe("a1b2");
	});

	test("a nested else can read the outer variable", async () => {
		expect(
			await render(
				'{% for i in ["a", "b"] %}{% for j in [] %}{% else %}no {{ i }};{% endfor %}{% endfor %}',
			),
		).toBe("no a;no b;");
	});
});

describe("unsupported forms", () => {
	test("Twig's if clause is not supported", async () => {
		expect(await errorCode("{% for x in [1, 2] if x > 1 %}{% endfor %}")).toBe(
			"unexpected-token",
		);
	});

	test("loop cannot be a loop variable", async () => {
		expect(await errorCode("{% for loop in [1] %}{% endfor %}")).toBe(
			"reserved-name",
		);
	});

	test("markup is not iterable", async () => {
		expect(
			await errorCode("{% set m %}ab{% endset %}{% for c in m %}{% endfor %}"),
		).toBe("not-iterable");
	});
});
