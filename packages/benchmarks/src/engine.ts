import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

/** Template sources keyed by path inside the scenario's engine directory, such as `partials/header.njk`. */
export type Templates = Record<string, string>;

/** Renders the scenario's entry template, `page` plus the engine's extension, with the scenario's data. */
export type Render = (
	data: Record<string, unknown>,
) => string | Promise<string>;

export type PrepareOptions = {
	/** The scenario calls async functions, so the engine must render in its async mode. */
	async: boolean;
	/** The scenario times `prepare`, as a cold start or a template edit in a CMS would run it. */
	cold: boolean;
};

/**
 * One template engine. An adapter sets the engine up the way its documentation recommends for production: templates
 * are compiled once and cached, output is HTML-escaped, and templates come from memory so no time goes on the disk.
 */
export type Engine = {
	id: string;
	name: string;
	/** The npm package, for the version and link in the results. */
	package: string;
	homepage: string;
	/** File extension of the engine's templates, including the dot. */
	extension: string;
	/** Can templates call async functions and wait for the result? */
	async: boolean;
	/** Sets up a fresh environment holding `templates` and returns a function that renders the entry template. */
	prepare(
		templates: Templates,
		options: PrepareOptions,
	): Render | Promise<Render>;
};

/** Reads every file in `dir` and below. */
export const readTemplates = async (dir: string): Promise<Templates> => {
	const templates: Templates = {};
	const entries = await readdir(dir, { recursive: true, withFileTypes: true });
	for (const entry of entries) {
		if (!entry.isFile()) continue;
		const path = join(entry.parentPath, entry.name);
		const name = relative(dir, path).split(sep).join("/");
		templates[name] = await readFile(path, "utf8");
	}
	return templates;
};
