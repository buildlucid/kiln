import { readdir, readFile } from "node:fs/promises";
import { dirname, join, posix, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import * as bundledKiln from "@lucidkiln/core";
import type {
	Diagnostic,
	Kiln,
	KilnManifest,
	ManifestComponent,
} from "@lucidkiln/core";
import * as bundledFormat from "@lucidkiln/core/format";
import {
	type FileChange,
	openTypeScript,
	type TypeScriptProject,
} from "./typescript.js";

type KilnModule = Pick<typeof bundledKiln, "createKiln"> &
	Partial<Pick<typeof bundledKiln, "hostComponent">>;
type FormatModule = Pick<
	typeof bundledFormat,
	"formatEdits" | "KilnFormatError"
>;

/** Diagnostics that need to know the project's names and templates, so they are dropped without a `kiln.json`. */
const NEEDS_MANIFEST = new Set([
	"unknown-function",
	"unknown-filter",
	"unknown-test",
	"unknown-type",
	"missing-template",
]);

/**
 * The templates under one `kiln.json`, or a workspace folder without one, and a Kiln environment that checks them.
 *
 * Template names are paths relative to `root`, such as `pages/home.kiln`, as Kiln resolves them.
 */
export type Project = {
	/** The `kiln.json` file, or null without one. */
	manifestPath: string | null;
	manifest: KilnManifest | null;
	root: string;
	kiln: Kiln;
	format: FormatModule;
	/** Unsaved text of open templates, by name. The loader reads these before the disk. */
	overlay: Map<string, string>;
	/**
	 * The project's own TypeScript, started the first time it's needed. Null without `kiln.json`, a `tsconfig.json`, or
	 * TypeScript 6 or later.
	 */
	typescript: () => Promise<TypeScriptProject | null>;
	/** Tells the project's TypeScript, if it started, which TypeScript files changed on disk. */
	typescriptChanged: (changes: FileChange[]) => void;
	/** Stops the project's TypeScript, if it started. */
	close: () => void;
};

/**
 * Resolves a template name as Kiln does: relative to `from` when it starts with `./` or `../`, with `.kiln` added when the last part has no extension. Null when the name is invalid.
 */
export const resolveName = (name: string, from?: string): string | null => {
	const relativeName = name.startsWith("./") || name.startsWith("../");
	const segments =
		relativeName && from ? from.split("/").slice(0, -1) : ([] as string[]);
	for (const segment of name.split("/")) {
		if (segment === "" || segment === ".") continue;
		if (segment === "..") {
			if (segments.length === 0) return null;
			segments.pop();
		} else segments.push(segment);
	}
	const last = segments.at(-1);
	if (last === undefined || name.startsWith("/")) return null;
	if (!last.includes(".")) segments[segments.length - 1] = `${last}.kiln`;
	return segments.join("/");
};

/** The template name for a file, or null when it is outside the project's root. */
export const nameOf = (project: Project, path: string): string | null => {
	const name = relative(project.root, path);
	if (name.startsWith("..") || name.startsWith(sep) || name === "") return null;
	return name.split(sep).join("/");
};

export const pathOf = (project: Project, name: string): string =>
	join(project.root, ...name.split("/"));

/** The `kiln.json` entry for a host component's resolved name, such as `components/Counter.tsx`, or null. */
export const componentOf = (
	manifest: KilnManifest | null,
	name: string,
): ManifestComponent | null => {
	const matches = (globs: string[] | undefined) =>
		globs?.some((glob) => posix.matchesGlob(name, glob)) ?? false;
	return (
		manifest?.components.find(
			(entry) =>
				entry.extensions.includes(posix.extname(name)) &&
				(!entry.include || matches(entry.include)) &&
				!matches(entry.exclude),
		) ?? null
	);
};

/** Every template and host component under the root, skipping dot folders and node_modules. */
export const listTemplates = async (project: Project): Promise<string[]> => {
	const names: string[] = [];
	const visit = async (folder: string, from: string): Promise<void> => {
		// An unreadable folder should not hide templates found elsewhere in the project.
		const entries = await readdir(folder, { withFileTypes: true }).catch(
			() => [],
		);
		for (const entry of entries) {
			if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
			const name = from + entry.name;
			if (entry.isDirectory())
				await visit(join(folder, entry.name), name + "/");
			else if (
				entry.isFile() &&
				(name.endsWith(".kiln") || componentOf(project.manifest, name))
			) {
				names.push(name);
			}
		}
	};
	await visit(project.root, "");
	return names.sort();
};

/** The nearest `kiln.json` in `folder` or above it, stopping at `stop` when given. */
export const findManifest = async (
	folder: string,
	stop: string | null,
): Promise<string | null> => {
	for (let current = folder; ; current = dirname(current)) {
		const candidate = join(current, "kiln.json");
		try {
			await readFile(candidate, "utf8");
			return candidate;
		} catch {
			// Keep looking.
		}
		if (current === stop || dirname(current) === current) return null;
	}
};

/** Reads `kiln.json`, filling in defaults. Throws when it isn't valid. */
export const readManifest = async (path: string): Promise<KilnManifest> => {
	const data: unknown = JSON.parse(await readFile(path, "utf8"));
	if (typeof data !== "object" || data === null || Array.isArray(data)) {
		throw new Error("kiln.json must hold an object");
	}
	const field = (key: keyof KilnManifest): string[] => {
		const value = (data as Record<string, unknown>)[key];
		if (value === undefined) return [];
		if (
			!Array.isArray(value) ||
			value.some((item) => typeof item !== "string")
		) {
			throw new Error(`"${key}" in kiln.json must be a list of names`);
		}
		return value;
	};
	const {
		root = ".",
		strict = true,
		htmlChecks = true,
		components = [],
	} = data as Partial<KilnManifest>;
	if (typeof root !== "string")
		throw new Error('"root" in kiln.json must be a string');
	if (typeof strict !== "boolean") {
		throw new Error('"strict" in kiln.json must be true or false');
	}
	// createKiln checks the levels inside.
	if (
		typeof htmlChecks !== "boolean" &&
		(typeof htmlChecks !== "object" ||
			htmlChecks === null ||
			Array.isArray(htmlChecks))
	) {
		throw new Error(
			'"htmlChecks" in kiln.json must be true, false or an object',
		);
	}
	const names = (value: unknown) =>
		value === undefined ||
		(Array.isArray(value) && value.every((item) => typeof item === "string"));
	if (
		!Array.isArray(components) ||
		components.some(
			(entry: unknown) =>
				typeof entry !== "object" ||
				entry === null ||
				!("extensions" in entry) ||
				!Array.isArray(entry.extensions) ||
				!names(entry.extensions) ||
				("include" in entry && !names(entry.include)) ||
				("exclude" in entry && !names(entry.exclude)) ||
				("props" in entry && typeof entry.props !== "string"),
		)
	) {
		throw new Error(
			'"components" in kiln.json must be a list of { extensions, include?, exclude?, props? }',
		);
	}
	return {
		root,
		strict,
		htmlChecks,
		components,
		functions: field("functions"),
		filters: field("filters"),
		tests: field("tests"),
		globals: field("globals"),
		types: field("types"),
	};
};

/** Imports an entry point of the copy of Kiln installed in a project, or returns null. */
const importInstalled = async <T>(
	from: string,
	entry: "." | "./format",
): Promise<T | null> => {
	for (let current = from; ; current = dirname(current)) {
		const folder = join(current, "node_modules", "@lucidkiln", "core");
		try {
			const pkg = JSON.parse(
				await readFile(join(folder, "package.json"), "utf8"),
			) as { exports?: Record<string, { import?: string } | undefined> };
			const file = pkg.exports?.[entry]?.import;
			return file
				? ((await import(pathToFileURL(join(folder, file)).href)) as T)
				: null;
		} catch {
			// Not installed here, or too old for this entry point.
		}
		if (dirname(current) === current) return null;
	}
};

const stubs = <T>(names: readonly string[], value: T) =>
	Object.fromEntries(names.map((name) => [name, value]));

/**
 * Opens the project for a template folder: the nearest `kiln.json`, or `fallbackRoot` without one. Prefers the project's own copy of Kiln, so errors match how it renders.
 *
 * A broken `kiln.json` is reported through `warn`, and the project is opened as if it had none.
 */
export const openProject = async (
	manifestPath: string | null,
	fallbackRoot: string,
	warn: (message: string) => void,
): Promise<Project> => {
	let manifest: KilnManifest | null = null;
	if (manifestPath) {
		try {
			manifest = await readManifest(manifestPath);
		} catch (error) {
			warn(`Kiln: ignoring ${manifestPath}. ${(error as Error).message}`);
		}
	}
	const root =
		manifestPath && manifest
			? join(dirname(manifestPath), manifest.root)
			: fallbackRoot;
	const base = manifestPath ? dirname(manifestPath) : fallbackRoot;
	const { createKiln, hostComponent } =
		(await importInstalled<KilnModule>(base, ".")) ?? bundledKiln;
	// The project's own Kiln makes it, since Kiln knows host components by a symbol of its own. One too old for them
	// gets an empty template.
	const component = hostComponent ? hostComponent(() => "") : "";
	const format =
		(await importInstalled<FormatModule>(base, "./format")) ?? bundledFormat;

	const overlay = new Map<string, string>();
	const options = {
		loader: {
			load: async (name: string) => {
				const open = overlay.get(name);
				if (open !== undefined) return open;
				if (!manifest) return null;
				if (componentOf(manifest, name)) return component;
				try {
					return await readFile(join(root, ...name.split("/")), "utf8");
				} catch {
					return null;
				}
			},
		},
	};
	let kiln: Kiln;
	try {
		kiln = manifest
			? createKiln({
					...options,
					functions: stubs(manifest.functions, () => null),
					filters: stubs(manifest.filters, () => null),
					tests: stubs(manifest.tests, () => true),
					globals: stubs(manifest.globals, null),
					types: stubs(manifest.types, () => true),
					strict: manifest.strict,
					htmlChecks: manifest.htmlChecks,
				})
			: createKiln(options);
	} catch (error) {
		warn(`Kiln: ignoring ${manifestPath}. ${(error as Error).message}`);
		manifest = null;
		kiln = createKiln(options);
	}
	let typescript: Promise<TypeScriptProject | null> | undefined;
	const folder = manifestPath && manifest ? dirname(manifestPath) : null;
	return {
		manifestPath,
		manifest,
		root,
		kiln,
		format,
		overlay,
		typescript: () =>
			(typescript ??= folder
				? openTypeScript(folder, warn)
				: Promise.resolve(null)),
		typescriptChanged: (changes) =>
			void typescript?.then((opened) => opened?.changed(changes)),
		close: () => void typescript?.then((opened) => opened?.close()),
	};
};

/** Checks a template's text and returns its own diagnostics. */
export const diagnose = async (
	project: Project,
	name: string,
	text: string,
): Promise<Diagnostic[]> => {
	const diagnostics = await project.kiln.check(name, text);
	return diagnostics.filter(
		(diagnostic) =>
			diagnostic.template === name &&
			(project.manifest !== null || !NEEDS_MANIFEST.has(diagnostic.code)),
	);
};
