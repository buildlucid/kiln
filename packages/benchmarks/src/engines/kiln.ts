import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
	createKiln,
	type KilnOptions,
	memoryLoader,
	type PrecompiledTemplate,
} from "@lucidcms/kiln";
import { asyncFunctions } from "../data.ts";
import type { Engine, Templates } from "../engine.ts";

const options: Omit<KilnOptions, "loader"> = {
	functions: asyncFunctions,
	locale: "en-GB",
};

/**
 * Precompiles every template and imports the modules, as a site's build and bundle would, so no time goes on it while
 * timing.
 */
const precompile = async (
	templates: Templates,
): Promise<Record<string, PrecompiledTemplate>> => {
	const builder = createKiln({ ...options, loader: memoryLoader(templates) });
	const dir = await mkdtemp(join(tmpdir(), "kiln-benchmark-"));
	const modules: Record<string, PrecompiledTemplate> = {};
	try {
		for (const name of Object.keys(templates)) {
			const file = join(dir, name.replace(/\.kiln$/, ".js"));
			await mkdir(dirname(file), { recursive: true });
			await writeFile(file, await builder.precompile(name));
			const module = (await import(pathToFileURL(file).href)) as {
				default: PrecompiledTemplate;
			};
			modules[name] = module.default;
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
	return modules;
};

/**
 * Kiln with its defaults, including strict mode. Built-in filters cover dates, prices and truncating. Templates are
 * precompiled, as Kiln's docs recommend for templates in a codebase. The first render scenario compiles from source,
 * since it times compiling, as a template edited in a CMS would be.
 */
export const kiln: Engine = {
	id: "kiln",
	name: "Kiln",
	package: "@lucidcms/kiln",
	homepage: "https://github.com/buildlucid/kiln",
	extension: ".kiln",
	async: true,
	async prepare(templates, { cold }) {
		const env = createKiln({
			...options,
			loader: memoryLoader(cold ? templates : await precompile(templates)),
		});
		return (data) => env.render("page", data);
	},
};
