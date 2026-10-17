import { environmentOf, type Kiln } from "./environment.js";
import { type HtmlChecks, htmlChecksOption } from "./html.js";
import { variableNames } from "./runtime/scope.js";
import type { CallableEntry } from "./runtime/types.js";

/** The contents of `kiln.json`, which tells the language server about a project. See the editor support docs. */
export type KilnManifest = {
	/** The folder template names are relative to, from the folder holding `kiln.json`. */
	root: string;
	strict: boolean;
	functions: string[];
	filters: string[];
	tests: string[];
	globals: string[];
	types: string[];
	htmlChecks: HtmlChecks;
};

const hostNames = (registry: ReadonlyMap<string, CallableEntry>) =>
	[...registry]
		.filter(([, entry]) => entry.kind === "host")
		.map(([name]) => name)
		.sort();

/**
 * Writes `kiln.json` for an environment: the names of its functions, filters, tests, globals and prop types, and its HTML check levels, so editors can check templates without running your code. `root` is the template folder, relative to where you write the file.
 *
 * ```ts
 * await writeFile("kiln.json", generateManifest(kiln, { root: "src/templates" }));
 * ```
 */
export const generateManifest = <State>(
	kiln: Kiln<State>,
	options: { root: string },
): string => {
	const env = environmentOf(kiln);
	const manifest: KilnManifest = {
		root: options.root,
		strict: env.strict,
		functions: hostNames(env.functions),
		filters: hostNames(env.filters),
		tests: hostNames(env.tests),
		globals: variableNames(env.globals).sort(),
		types: [...env.types.keys()].sort(),
		htmlChecks: htmlChecksOption(env.htmlChecks),
	};
	return `${JSON.stringify(manifest, null, "\t")}\n`;
};
