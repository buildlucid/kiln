import { Eta } from "eta";
import { asyncFunctions } from "../data.ts";
import type { Engine } from "../engine.ts";
import { helpers } from "../helpers.ts";

const globals = { ...helpers, ...asyncFunctions };

/** Holds the template globals, which compiled templates read through `this`. */
class BenchmarkEta extends Eta {
	readonly globals = globals;
}

/**
 * Eta with caching and autoescaping on and debug off. Templates are loaded as named `@` templates, Eta's documented
 * way to skip the file system. Templates only see `it`, so the helpers and async functions become template globals
 * through `functionHeader`, which Eta documents for declaring globals. In async scenarios every template is compiled
 * async and rendered with `renderAsync`.
 */
export const eta: Engine = {
	id: "eta",
	name: "Eta",
	package: "eta",
	homepage: "https://eta.js.org/",
	extension: ".eta",
	async: true,
	prepare(templates, options) {
		const env = new BenchmarkEta({
			cache: true,
			autoEscape: true,
			debug: false,
			functionHeader: `const { ${Object.keys(globals).join(", ")} } = this.globals;`,
		});
		for (const [path, source] of Object.entries(templates)) {
			env.loadTemplate(`@${path.replace(/\.eta$/, "")}`, source, {
				async: options.async,
			});
		}
		return options.async
			? (data) => env.renderAsync("@page", data)
			: (data) => env.render("@page", data);
	},
};
