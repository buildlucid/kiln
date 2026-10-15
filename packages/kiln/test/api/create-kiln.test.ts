import { describe, expect, test } from "vite-plus/test";
import {
	createKiln,
	type EscapeStrategy,
	isSafe,
	memoryLoader,
	safe,
	withRender,
} from "../../src/index.js";
import { render } from "../helpers.js";

describe("createKiln", () => {
	test("registers host functions, filters and tests", async () => {
		const kiln = createKiln({
			loader: memoryLoader({
				index: '{{ greet("Ada") }}|{{ 3|double }}|{{ 4 is big }}',
			}),
			functions: { greet: (name: string) => `Hi ${name}` },
			filters: { double: (value: number) => value * 2 },
			tests: { big: (value: number) => value > 3 },
		});
		expect(await kiln.render("index")).toBe("Hi Ada|6|true");
	});

	test("host functions can override built-in functions", async () => {
		expect(
			await render("{{ range(1, 2) }}", { functions: { range: () => "mine" } }),
		).toBe("mine");
	});

	test("refuses reserved and invalid names", () => {
		const loader = memoryLoader({});
		expect(() => createKiln({ loader, filters: { raw: () => "" } })).toThrow(
			/reserved/,
		);
		expect(() =>
			createKiln({ loader, functions: { parent: () => "" } }),
		).toThrow(/reserved/);
		expect(() =>
			createKiln({ loader, tests: { defined: () => true } }),
		).toThrow(/reserved/);
		expect(() =>
			createKiln({ loader, functions: { "bad-name": () => "" } }),
		).toThrow(/valid/);
	});

	test("refuses type names that don't start with a capital letter", () => {
		const loader = memoryLoader({});
		expect(() => createKiln({ loader, types: { post: () => true } })).toThrow(
			/capital letter/,
		);
		expect(() =>
			createKiln({ loader, types: { Post: () => true } }),
		).not.toThrow();
	});

	test("refuses an unknown escaping strategy", () => {
		// A value from untyped code, which the types would otherwise reject.
		const autoescape = "xml" as EscapeStrategy;
		expect(() => createKiln({ loader: memoryLoader({}), autoescape })).toThrow(
			/strategy/,
		);
	});

	test("the render context must be a plain object", async () => {
		const kiln = createKiln({ loader: memoryLoader({ index: "" }) });
		// @ts-expect-error: testing a value from untyped code.
		await expect(kiln.render("index", [])).rejects.toThrow(/plain object/);
	});
});

describe("withRender", () => {
	test("gives host functions the render's state and template", async () => {
		type SiteState = { locale: string };
		const kiln = createKiln<SiteState>({
			loader: memoryLoader({ index: "{{ greet() }}" }),
			functions: {
				greet: withRender(
					(render) => `${render.state.locale}:${render.template}`,
				),
			},
		});
		expect(await kiln.render("index", {}, { state: { locale: "cy" } })).toBe(
			"cy:index.kiln",
		);
	});
});

describe("safe", () => {
	test("lets host functions return trusted html", async () => {
		const functions = { rich: () => safe("<b>x</b>"), plain: () => "<b>x</b>" };
		expect(await render("{{ rich() }}|{{ plain() }}", { functions })).toBe(
			"<b>x</b>|&lt;b&gt;x&lt;/b&gt;",
		);
		expect(isSafe(safe("x"))).toBe(true);
		expect(isSafe("x")).toBe(false);
	});
});

describe("locale and time zone", () => {
	test("can change per render", async () => {
		const kiln = createKiln({
			loader: memoryLoader({
				index:
					'{{ 1234.5|formatNumber }} {{ d|formatDate(timeStyle: "short") }}',
			}),
		});
		const d = new Date("2026-01-01T12:00:00Z");
		expect(await kiln.render("index", { d })).toBe("1,234.5 12:00 PM");
		expect(
			await kiln.render(
				"index",
				{ d },
				{ locale: "de-DE", timeZone: "Europe/Berlin" },
			),
		).toBe("1.234,5 13:00");
	});
});
