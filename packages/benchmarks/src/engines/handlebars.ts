import Handlebars from "handlebars";
import type { Engine } from "../engine.ts";
import { helpers } from "../helpers.ts";

/** Small generic helpers for the logic Handlebars leaves out of templates, as its users usually register. */
const logic = {
	eq: (a: unknown, b: unknown) => a === b,
	lte: (a: number, b: number) => a <= b,
	odd: (value: number) => value % 2 === 1,
	inc: (value: number) => value + 1,
	range: (start: number, end: number) =>
		Array.from({ length: end - start + 1 }, (_, index) => start + index),
	concat: (a: string, b: string) => a + b,
	lower: (value: string) => value.toLowerCase(),
	upper: (value: string) => value.toUpperCase(),
	sort: (items: string[]) => items.toSorted(),
	join: (items: string[], separator: string) => items.join(separator),
};

/**
 * Handlebars in an isolated instance from `create()`, with HTML escaping on by default. Every template other than
 * the entry is compiled and registered as a partial named by its path, such as `partials/header`. The shared
 * formatting helpers and the generic logic helpers are registered as helpers.
 */
export const handlebars: Engine = {
	id: "handlebars",
	name: "Handlebars",
	package: "handlebars",
	homepage: "https://handlebarsjs.com/",
	extension: ".hbs",
	async: false,
	prepare(templates) {
		const hbs = Handlebars.create();
		hbs.registerHelper({ ...helpers, ...logic });
		const { "page.hbs": page, ...partials } = templates;
		for (const [path, source] of Object.entries(partials)) {
			hbs.registerPartial(path.replace(/\.hbs$/, ""), hbs.compile(source));
		}
		return hbs.compile(page);
	},
};
