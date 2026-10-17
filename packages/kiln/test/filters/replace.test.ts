import { describe, expect, test } from "vite-plus/test";
import { errorCode, render } from "../helpers.js";

describe("replace", () => {
	test("replaces every occurrence of a string", async () => {
		expect(await render('{{ "a.b.c"|replace(".", "/") }}')).toBe("a/b/c");
	});

	test("replaces several strings at once from a hash", async () => {
		expect(
			await render(
				'{{ "I like cats"|replace({ "cats": "dogs", "I": "We" }) }}',
			),
		).toBe("We like dogs");
	});

	test("prefers the longest match and does not replace replacements", async () => {
		expect(
			await render(
				'{{ "aaa"|replace({ "a": "b", "aa": "c" }) }}|{{ "ab"|replace({ "a": "b", "b": "a" }) }}',
			),
		).toBe("cb|ba");
	});

	test("treats the search text literally, not as a regular expression", async () => {
		expect(
			await render(
				'{{ "a.b"|replace("[.]", "x") }}|{{ "1+1"|replace("+", " plus ") }}',
			),
		).toBe("a.b|1 plus 1");
	});

	test("checks the length of the result against maxOutputLength", async () => {
		const limits = { maxOutputLength: 4 };
		expect(await render('{{ "aaaa"|replace("aa", "a") }}', { limits })).toBe(
			"aa",
		);
		expect(await errorCode('{{ "aa"|replace("a", "abc") }}', { limits })).toBe(
			"limit-output",
		);
	});

	test("an empty search changes nothing", async () => {
		expect(await render('{{ "abc"|replace("", "x") }}')).toBe("abc");
	});
});

describe("replacement text", () => {
	test("dollar signs are literal", async () => {
		expect(await render('{{ "a"|replace("a", "$&$&")|raw }}')).toBe("$&$&");
	});
});

describe("markup", () => {
	test("replaces text in safe markup, escaping a plain replacement", async () => {
		expect(
			await render('{{ "<b>X</b>"|raw|replace("X", name) }}', {
				context: { name: "<i>Ada</i>" },
			}),
		).toBe("<b>&lt;i&gt;Ada&lt;/i&gt;</b>");
	});

	test("matches the text, not tags or entities, and keeps a safe replacement", async () => {
		expect(
			await render(
				'{{ "<b>a&lt;b</b>"|raw|replace({ b: "<i>B</i>"|raw, "<": "[" }) }}',
			),
		).toBe("<b>a[<i>B</i></b>");
	});
});

describe("limits", () => {
	test("a hash counts the characters it compares against maxSteps", async () => {
		const keys = Object.fromEntries(
			Array.from({ length: 50 }, (_, i) => [`${"a".repeat(i + 2)}b`, "x"]),
		);
		expect(
			await errorCode("{{ text|replace(keys) }}", {
				context: { text: "a".repeat(2000), keys },
				limits: { maxSteps: 1000 },
			}),
		).toBe("limit-steps");
	});

	test("a hash stops before building text longer than maxOutputLength", async () => {
		expect(
			await errorCode('{{ "aaaa"|replace({ a: "xxxx" }) }}', {
				limits: { maxOutputLength: 10 },
			}),
		).toBe("limit-output");
	});
});
