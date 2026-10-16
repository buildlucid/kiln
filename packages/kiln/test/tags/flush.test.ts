import { describe, expect, test } from "vite-plus/test";
import { errorCode, lines, render } from "../helpers.js";

describe("flush", () => {
	test("outputs nothing, and the outlets above it keep their content", async () => {
		const template = lines(
			"<head>",
			'	{% outlet "head" %}',
			'	{% add to "head" %}',
			"		<title>Home</title>",
			"	{% endadd %}",
			"</head>",
			"{% flush %}",
			"<body></body>",
		);
		expect(await render(template)).toBe(
			lines("<head>", "	<title>Home</title>", "</head>", "<body></body>"),
		);
	});

	test("closes the outlets above it", async () => {
		expect(
			await errorCode(
				'{% outlet "head" %}{% flush %}{% add to "head" %}x{% endadd %}',
			),
		).toBe("outlet-closed");
	});

	test("allows a once tag that already added", async () => {
		const template =
			'{% macro style() %}{% add to "head" once %}<link>{% endadd %}{% endmacro %}[{% outlet "head" %}]{{ style() }}{% flush %}{{ style() }}';
		expect(await render(template)).toBe("[<link>]");
	});

	test("leaves outlets below it open", async () => {
		expect(
			await render(
				'{% flush %}[{% outlet "end" %}]{% add to "end" %}x{% endadd %}',
			),
		).toBe("[x]");
	});

	test("can be used more than once", async () => {
		expect(
			await render(
				'{% outlet "a" %}{% add to "a" %}a{% endadd %}{% flush %}{% outlet "b" %}{% add to "b" %}b{% endadd %}{% flush %}.',
			),
		).toBe("ab.");
	});

	test("can't be inside a capture, an addition or a cached section", async () => {
		for (const template of [
			"{% set x %}{% flush %}{% endset %}",
			"{% apply upper %}{% flush %}{% endapply %}",
			'{% add to "a" %}{% flush %}{% endadd %}',
			"{% macro m() %}{% flush %}{% endmacro %}{{ m() }}",
			'{% cache "k" %}{% flush %}{% endcache %}',
		]) {
			expect(await errorCode(template)).toBe("misplaced-flush");
		}
	});
});
