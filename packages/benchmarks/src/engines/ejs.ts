import EJS from "ejs";
import { asyncFunctions } from "../data.ts";
import type { Engine } from "../engine.ts";
import { helpers } from "../helpers.ts";

/** Helpers every template can call, as an Express app would set them on `app.locals`. */
const locals = { ...helpers, ...asyncFunctions };

/**
 * EJS with `cache` on and `compileDebug` off, as its docs advise for production. EJS caches compiled includes
 * globally, so `prepare` clears that cache first. Templates include each other by root-relative paths such as
 * `/partials/header`, which EJS resolves without touching the disk, and the `includer` hook reads the source from
 * memory. Helpers merge into the locals at render, the way Express merges `app.locals` with the render data.
 */
export const ejs: Engine = {
	id: "ejs",
	name: "EJS",
	package: "ejs",
	homepage: "https://ejs.co/",
	extension: ".ejs",
	async: true,
	prepare(templates, { async }) {
		EJS.clearCache();
		const source = (name: string) => {
			const template = templates[`${name}.ejs`];
			if (template === undefined)
				throw new Error(`Can't find the template ${name}`);
			return template;
		};
		const page = EJS.compile(source("page"), {
			filename: "/page.ejs",
			cache: true,
			compileDebug: false,
			async,
			includer: (path) => ({ template: source(path.slice(1)) }),
		});
		return (data) => page({ ...locals, ...data });
	},
};
