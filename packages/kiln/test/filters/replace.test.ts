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
