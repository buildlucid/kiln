import { describe, expect, test } from "vite-plus/test";
import { check } from "../helpers.js";

const codes = async (source: string) =>
	(await check(source)).map((d) => d.code);

describe("html-attribute-value", () => {
	test("reports a keyword an attribute doesn't accept, with a suggestion", async () => {
		expect(await check('<input type="emial">')).toMatchObject([
			{
				code: "html-attribute-value",
				message: 'type="emial" isn\'t valid on <input>. Did you mean "email"?',
				severity: "warning",
				start: { column: 14 },
				end: { column: 19 },
			},
		]);
		expect(await codes('<img src=a alt="" loading="lazzy">')).toEqual([
			"html-attribute-value",
		]);
		expect(await codes('<form method="put"></form>')).toEqual([
			"html-attribute-value",
		]);
	});

	test("checks the keywords of the element the attribute is on", async () => {
		expect(
			await codes(
				'<button type="submit">A</button><input type="submit"><ol type="i"></ol>',
			),
		).toEqual([]);
		expect(await codes('<button type="text">A</button>')).toEqual([
			"html-attribute-value",
		]);
	});

	test("matches keywords in any case, apart from <ol type>", async () => {
		expect(await codes('<input type="EMAIL"><div dir="RTL">')).toEqual([]);
		expect(await codes('<ol type="A"></ol><ol type="I"></ol>')).toEqual([]);
		expect(await codes('<ol type="b"></ol>')).toEqual(["html-attribute-value"]);
	});

	test("accepts an empty value only where it has a meaning", async () => {
		expect(
			await codes(
				'<img src=a alt="" crossorigin><video preload=""></video><div hidden>',
			),
		).toEqual([]);
		expect(await check('<input type="">')).toMatchObject([
			{
				code: "html-attribute-value",
				start: { column: 8 },
				end: { column: 15 },
			},
		]);
	});

	test("checks attributes any element can have, on custom elements too", async () => {
		expect(await codes('<p dir="left"><my-card hidden="false">')).toEqual([
			"html-attribute-value",
			"html-attribute-value",
		]);
		expect(await codes('<my-card type="anything" loading="soon">')).toEqual([]);
	});

	test("checks each keyword in a list", async () => {
		expect(
			await check('<iframe title="x" sandbox="allow-forms allow-scirpts">'),
		).toMatchObject([
			{
				message:
					'sandbox="allow-scirpts" isn\'t valid on <iframe>. Did you mean "allow-scripts"?',
				start: { column: 40 },
			},
		]);
		expect(await codes('<iframe title="x" sandbox="">')).toEqual([]);
	});

	test("accepts target names and custom commands, but not names starting with _", async () => {
		expect(
			await codes(
				'<a href="/" target="preview">A</a><a href="/" target="_blank">B</a><button type="button" command="--open" commandfor="menu">C</button>',
			),
		).toEqual([]);
		expect(await codes('<a href="/" target="_new">A</a>')).toEqual([
			"html-attribute-value",
		]);
	});

	test("reports a boolean attribute written as off", async () => {
		expect(
			await check('<button type="button" disabled="false">'),
		).toMatchObject([
			{
				code: "html-attribute-value",
				message:
					'disabled="false" still turns disabled on, since any value does. Leave the attribute out to turn it off',
				start: { column: 23 },
				end: { column: 39 },
			},
		]);
		expect(
			await codes(
				'<video autoplay="0" muted="no"></video><details open="off">',
			),
		).toEqual([
			"html-attribute-value",
			"html-attribute-value",
			"html-attribute-value",
		]);
	});

	test("accepts boolean attributes written on, and leaves other elements and custom elements alone", async () => {
		expect(
			await codes(
				'<input disabled><input required="required"><input checked=""><div open="false"><my-switch checked="false">',
			),
		).toEqual([]);
	});

	test("only checks written-out values", async () => {
		expect(
			await codes(
				'<input type="{{ type }}"><button type="button" disabled="{{ x }}">',
			),
		).toEqual([]);
	});
});
