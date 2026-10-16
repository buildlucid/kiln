import { posix } from "node:path";
import { compile } from "pug";
import type { Engine } from "../engine.ts";
import { helpers } from "../helpers.ts";

declare module "pug" {
	interface Options {
		/** Compiler hooks. Pug supports them, but `@types/pug` leaves them out. */
		plugins?: {
			resolve?: (filename: string, source: string) => string;
			read?: (filename: string) => string;
		}[];
	}
}

/**
 * Pug compiles the entry once, inlining its layout, includes and mixins into one function. A plugin's `resolve` and
 * `read` hooks load them from memory. `doctype: "html"` renders boolean attributes tersely in templates without a
 * `doctype` line, and `compileDebug` is off as Pug's docs advise for production. Pug has no filter registry: its
 * `globals` option only exposes names from the global scope, so the helpers are passed as locals and merged with the
 * data per render, as Express merges `app.locals` into every render.
 */
export const pug: Engine = {
	id: "pug",
	name: "Pug",
	package: "pug",
	homepage: "https://pugjs.org/",
	extension: ".pug",
	async: false,
	prepare(templates) {
		const template = compile(templates["page.pug"] ?? "", {
			filename: "page.pug",
			doctype: "html",
			compileDebug: false,
			plugins: [
				{
					resolve: (filename, source) =>
						posix.join(posix.dirname(source), filename),
					read: (filename) => {
						const source = templates[filename];
						if (source === undefined)
							throw new Error(`Template ${filename} not found`);
						return source;
					},
				},
			],
		});
		return (data) => template({ ...helpers, ...data });
	},
};
