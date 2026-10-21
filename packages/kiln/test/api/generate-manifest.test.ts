import { describe, expect, test } from "vite-plus/test";
import {
	createKiln,
	generateManifest,
	type HtmlChecks,
	memoryLoader,
} from "../../src/index.js";

describe("generateManifest", () => {
	test("lists the names the environment adds, sorted, with the root and strict mode", () => {
		const kiln = createKiln({
			loader: memoryLoader({}),
			functions: { documents: () => [], document: () => null },
			filters: { markdown: (value: string) => value },
			tests: { published: () => true },
			globals: { site: {}, menu: [] },
			types: { Post: () => true },
			strict: false,
		});
		expect(
			JSON.parse(generateManifest(kiln, { root: "src/templates" })),
		).toEqual({
			root: "src/templates",
			strict: false,
			functions: ["document", "documents"],
			filters: ["markdown"],
			tests: ["published"],
			globals: ["menu", "site"],
			types: ["Post"],
			htmlChecks: true,
			components: [],
		});
	});

	test("lists the files the loader returns as host components", () => {
		const components = [
			{ extensions: [".tsx"], include: ["components/solid/**"] },
			{ extensions: [".vue"], props: "VueProps<$file>" },
		];
		expect(
			JSON.parse(
				generateManifest(createKiln({ loader: memoryLoader({}) }), {
					root: ".",
					components,
				}),
			).components,
		).toEqual(components);
	});

	test("writes only the HTML check levels that differ from a warning", () => {
		const manifest = (htmlChecks: HtmlChecks) =>
			JSON.parse(
				generateManifest(createKiln({ loader: memoryLoader({}), htmlChecks }), {
					root: ".",
				}),
			).htmlChecks;
		expect(
			manifest({ "html-img-alt": "error", "html-lang": "warning" }),
		).toEqual({
			"html-img-alt": "error",
		});
		expect(manifest(false)).toBe(false);
	});

	test("leaves out Kiln's own functions, filters and tests", () => {
		const manifest = JSON.parse(
			generateManifest(createKiln({ loader: memoryLoader({}) }), { root: "." }),
		);
		expect(manifest).toMatchObject({
			strict: true,
			functions: [],
			filters: [],
			tests: [],
		});
	});

	test("rejects an object createKiln didn't make", () => {
		expect(() =>
			generateManifest({} as ReturnType<typeof createKiln>, { root: "." }),
		).toThrow("Expected an environment made by createKiln");
	});
});
