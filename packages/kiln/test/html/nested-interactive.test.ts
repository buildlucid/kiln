import { describe, expect, test } from "vite-plus/test";
import { check } from "../helpers.js";

const messages = async (source: string) =>
	(await check(source)).map((d) => d.message);

describe("html-nested-interactive", () => {
	test("reports an interactive element inside a link or button", async () => {
		expect(
			await check('<a href="/">\n\t<button type="button">Buy</button>\n</a>'),
		).toMatchObject([
			{
				code: "html-nested-interactive",
				message:
					"<button> can't be inside <a>, since interactive elements can't hold each other",
				severity: "warning",
				start: { line: 2, column: 2 },
				end: { line: 2, column: 9 },
			},
		]);
		expect(
			await messages(
				'<button type="button"><span><a href="/">A</a></span><input><span tabindex="0">B</span></button>',
			),
		).toEqual([
			"<a> can't be inside <button>, since interactive elements can't hold each other",
			"<input> can't be inside <button>, since interactive elements can't hold each other",
			"<span> can't be inside <button>, since interactive elements can't hold each other",
		]);
	});

	test("reports a link in a link and a button in a button, which the browser ends early", async () => {
		expect(
			await messages(
				'<a href="/a">A <a href="/b">B</a></a><button type="button">C <button type="button">D</button></button>',
			),
		).toEqual([
			"<a> can't be inside another <a>, so the browser ends the first one here",
			"<button> can't be inside another <button>, so the browser ends the first one here",
		]);
	});

	test("reports a label inside a label", async () => {
		expect(await messages("<label>Name <label>Other</label></label>")).toEqual([
			"<label> can't be inside another <label>",
		]);
	});

	test("accepts content that isn't interactive", async () => {
		expect(
			await check(
				'<a href="/"><img src=a alt=""><span>Text</span><div>Block</div></a><button type="button"><svg></svg><a>No href</a><input type="hidden"></button><label>Name <input></label>',
			),
		).toEqual([]);
	});

	test("only knows what is in the same template", async () => {
		expect(
			await check('<a href="/">{% include "button" %}</a>', {
				templates: { button: '<button type="button">B</button>' },
			}),
		).toEqual([]);
	});
});
