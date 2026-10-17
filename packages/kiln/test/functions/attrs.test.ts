import { describe, expect, test } from "vite-plus/test";
import { errorCode, render } from "../helpers.js";

describe("attrs", () => {
	test("builds escaped attributes", async () => {
		const template =
			"<a{{ attrs({ href: url, class: ['card', featured ? 'card--featured', null], hidden: false, disabled: true, 'aria-current': current ? 'page', title: '\"Hi\" <x>' }) }}>";
		expect(
			await render(template, {
				context: { url: "/blog?a=1&b=2", featured: true, current: false },
			}),
		).toBe(
			'<a href="/blog?a=1&amp;b=2" class="card card--featured" disabled title="&quot;Hi&quot; &lt;x&gt;">',
		);
	});

	test("leaves out empty class lists", async () => {
		expect(await render('<p{{ attrs({ class: [false, ""] }) }}>')).toBe("<p>");
	});

	test("keeps html markup but escapes its quotes", async () => {
		const template =
			'{% set icon %}<i class="x">{% endset %}<a{{ attrs({ title: icon }) }}>';
		expect(await render(template)).toBe('<a title="<i class=&quot;x&quot;>">');
	});

	test("refuses invalid attribute names", async () => {
		expect(await errorCode('<p{{ attrs({ "on click": "x" }) }}>')).toBe(
			"invalid-argument",
		);
	});

	test("counts its items and output against the limits", async () => {
		expect(
			await errorCode(
				'{% set s = "x" %}{% for i in 1..8 %}{% set s = attrs({ a: s, b: s }) %}{% endfor %}',
				{ limits: { maxOutputLength: 128 } },
			),
		).toBe("limit-output");
		const list = Array.from({ length: 1000 }, (_, i) => i);
		expect(
			await errorCode("{{ attrs({ class: list }) }}", {
				context: { list },
				limits: { maxSteps: 100 },
			}),
		).toBe("limit-steps");
		expect(
			await errorCode("{{ attrs({ class: [text, text, text] }) }}", {
				context: { text: "x".repeat(10) },
				limits: { maxOutputLength: 20 },
			}),
		).toBe("limit-output");
	});

	test("renders nothing for null", async () => {
		expect(await render("<p{{ attrs(null) }}>")).toBe("<p>");
	});
});

describe("edge cases", () => {
	test("empty strings and 0 are written", async () => {
		expect(
			await render('<p{{ attrs({}) }}>|<img{{ attrs({ alt: "", n: 0 }) }}>'),
		).toBe('<p>|<img alt="" n="0">');
	});

	test("hashes and nested arrays cannot be values", async () => {
		expect(await errorCode("<p{{ attrs({ style: { a: 1 } }) }}>")).toBe(
			"not-printable",
		);
		expect(await errorCode('<p{{ attrs({ class: [["a"]] }) }}>')).toBe(
			"not-printable",
		);
	});
});
