import { describe, expect, test } from "vite-plus/test";
import { check } from "../helpers.js";

const messages = async (source: string) =>
	(await check(source)).map((d) => d.message);

describe("html-permitted-content", () => {
	test("reports a block in a paragraph that a </p> shows was meant to hold it", async () => {
		expect(await check("<p>Intro\n<div>Box</div>\n</p>")).toMatchObject([
			{
				code: "html-permitted-content",
				message:
					"<div> can't be inside <p>, so the browser ends the paragraph before it",
				severity: "warning",
				start: { line: 2, column: 1 },
				end: { line: 2, column: 5 },
			},
		]);
	});

	test("accepts paragraphs that end without </p>, as HTML allows", async () => {
		expect(
			await check(
				"<p>One<p>Two<ul><li>A<li>B</ul><p>Three<div>Box</div><p>Four</p>",
			),
		).toEqual([]);
	});

	test("reports a block inside an element that only holds text and inline elements", async () => {
		expect(
			await messages(
				'<span><div>A</div></span><h2><p>B</p></h2><button type="button"><ul></ul></button><span><a href="/"><div>C</div></a></span>',
			),
		).toEqual([
			"<div> can't be inside <span>, which only holds text and inline elements",
			"<p> can't be inside <h2>, which only holds text and inline elements",
			"<ul> can't be inside <button>, which only holds text and inline elements",
			"<div> can't be inside <span>, which only holds text and inline elements",
		]);
		expect(
			await check(
				'<a href="/"><div>Card</div></a><details><summary><h3>Title</h3></summary></details>',
			),
		).toEqual([]);
	});

	test("reports a child its parent can't hold", async () => {
		expect(
			await messages(
				"<ul><div>A</div></ul><table><td>B</td></table><dl><p>C</p></dl><picture><div></div></picture>",
			),
		).toEqual([
			"<div> can't be inside <ul>, which only holds <li>, <script> and <template>",
			"<td> can't be inside <table>, which only holds <caption>, <colgroup>, <col>, <thead>, <tbody>, <tfoot>, <tr>, <script> and <template>",
			"<p> can't be inside <dl>, which only holds <dt>, <dd>, <div>, <script> and <template>",
			"<div> can't be inside <picture>, which only holds <source>, <img>, <script> and <template>",
		]);
	});

	test("accepts the children each parent holds, including end tags left out", async () => {
		expect(
			await check(
				'<ul><li>A<li>B</ul><dl><dt>T<dd>D<div><dt>U<dd>E</div></dl><table><caption>C</caption><tr><td>1<td>2<tr><th>3</table><table><thead><tr><th>H<tbody><tr><td>B</table><picture><source srcset=a><img src=a alt=""></picture>',
			),
		).toEqual([]);
	});

	test("reports an element outside the parent it needs", async () => {
		expect(
			await messages(
				"<div><li>A</li></div><section><summary>B</summary><figcaption>C</figcaption></section><span><rt>D</rt></span>",
			),
		).toEqual([
			"<li> must be inside <ul>, <ol> or <menu>",
			"<summary> must be inside <details>",
			"<figcaption> must be inside <figure>",
			"<rt> must be inside <ruby>",
		]);
	});

	test("reports a summary or legend that isn't the first child", async () => {
		expect(
			await messages(
				"<details><p>A</p><summary>B</summary></details><fieldset>{{ intro }}<legend>C</legend></fieldset>",
			),
		).toEqual([
			"<summary> must be the first child of <details>",
			"<legend> must be the first child of <fieldset>",
		]);
		expect(
			await check(
				'<details class="{{ c }}" {% if open %}open{% endif %}><summary>A</summary></details>',
			),
		).toEqual([]);
	});

	test("reports nested forms, headers and footers", async () => {
		expect(
			await messages(
				"<form><form></form></form><header><footer></footer></header><footer><div><header></header></div></footer>",
			),
		).toEqual([
			"<form> can't be inside another <form>, so the browser ignores it",
			"<footer> can't be inside <header>",
			"<header> can't be inside <footer>",
		]);
	});

	test("reports <main> in the wrong place", async () => {
		expect(await messages("<article><main></main></article>")).toEqual([
			"<main> can't be inside <article>. It belongs in <body>, a <div> or a <form>",
		]);
		expect(
			await check(
				'<html lang="en"><head><title>T</title><body><div><main></main></div><my-app><main></main></my-app>',
			),
		).toEqual([]);
	});
});
