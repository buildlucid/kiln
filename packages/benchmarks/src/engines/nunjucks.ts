import nunjucksLib, { type ILoader } from "nunjucks";
import { asyncFunctions } from "../data.ts";
import type { Engine } from "../engine.ts";
import { helpers } from "../helpers.ts";

/**
 * Nunjucks with autoescaping on and a small in-memory loader, whose compiled templates the environment caches.
 * `formatDate`, `formatPrice`, `formatNumber` and `truncateText` are custom filters, because Nunjucks has no date or
 * number filters and its `truncate` cuts at a word and adds `...`. Its own `urlencode` matches Kiln's for this data.
 * In async mode the data functions are globals that return promises, and the async `await` filter waits for them.
 */
export const nunjucks: Engine = {
	id: "nunjucks",
	name: "Nunjucks",
	package: "nunjucks",
	homepage: "https://mozilla.github.io/nunjucks/",
	extension: ".njk",
	async: true,
	prepare(templates, options) {
		const loader: ILoader = {
			getSource: (name) => {
				const src = templates[name];
				if (src === undefined) throw new Error(`Template not found: ${name}`);
				return { src, path: name, noCache: false };
			},
		};
		const env = new nunjucksLib.Environment(loader, { autoescape: true })
			.addFilter("formatDate", helpers.formatDate)
			.addFilter("formatPrice", helpers.formatPrice)
			.addFilter("formatNumber", helpers.formatNumber)
			.addFilter("truncateText", helpers.truncate);

		if (!options.async) return (data) => env.render("page.njk", data);

		for (const [name, fn] of Object.entries(asyncFunctions))
			env.addGlobal(name, fn);
		env.addFilter(
			"await",
			(
				value: Promise<unknown>,
				done: (error: unknown, result?: unknown) => void,
			) => {
				value.then((result) => done(null, result), done);
			},
			true,
		);
		return (data) =>
			new Promise<string>((resolve, reject) => {
				env.render("page.njk", data, (error, html) =>
					error ? reject(error) : resolve(html ?? ""),
				);
			});
	},
};
