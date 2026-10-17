import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { openTypeScript6 } from "./typescript-6.js";
import { openTypeScript7 } from "./typescript-7.js";

/** A place in a TypeScript file. `line` and `character` are zero-based, as in the Language Server Protocol. */
export type SourceLocation = { path: string; line: number; character: number };

/** A property of a TypeScript type, with what an editor shows for it. */
export type Member = {
	name: string;
	optional: boolean;
	/** The property's type, written out. */
	type: string;
	/** Its doc comment, without tags. */
	docs: string;
	tags: { name: string; text: string }[];
	location: SourceLocation | null;
};

/** Reads the type aliases of the file passed to `TypeScriptProject.query`. */
export type TypeQuery = {
	/** The alias's type, written out. Null when the alias isn't in the file. */
	describe(alias: string): string | null;
	/** The properties of the alias's type. */
	members(alias: string): Member[];
};

/** A file that changed on disk. */
export type FileChange = {
	path: string;
	kind: "created" | "changed" | "deleted";
};

/**
 * A project's own TypeScript, loaded from its `tsconfig.json`. The language server asks it about types by checking a
 * generated file of type aliases, which lives in the project's first source folder so it sees the same modules and
 * declarations as the project's own code.
 */
export type TypeScriptProject = {
	/** Checks `source` as a file in the project and reads it with `use`. Null when TypeScript can't check the file. */
	query<T>(source: string, use: (query: TypeQuery) => T): T | null;
	/** Tells TypeScript which files changed on disk. */
	changed(changes: FileChange[]): void;
	close(): void;
};

/** The generated file's name. Nothing in the project should use it. */
const VIRTUAL_NAME = "__kiln_types__.ts";

/** Where the generated file goes: the folder of the project's first TypeScript source file, or the config's folder. */
export const virtualPath = (
	configPath: string,
	fileNames: readonly string[],
) => {
	const root = dirname(configPath);
	const source = fileNames.find((name) => {
		const path = relative(root, name);
		return (
			/\.[cm]?tsx?$/.test(name) &&
			!/\.d\.[cm]?ts$/.test(name) &&
			!path.startsWith("..") &&
			!path.split(sep).includes("node_modules")
		);
	});
	return join(source ? dirname(source) : root, VIRTUAL_NAME);
};

/** Whether two paths are the same file. TypeScript may change a path's case on case-insensitive file systems. */
export const samePath = (a: string, b: string) =>
	a === b || a.toLowerCase() === b.toLowerCase();

/** A folder's entries with the generated file added, for TypeScript's include globs. */
export const entriesWith = (folder: string, name: string) => {
	const entries = readdirSync(folder, { withFileTypes: true });
	return {
		files: [
			...entries.filter((entry) => entry.isFile()).map((entry) => entry.name),
			name,
		],
		directories: entries
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name),
	};
};

/** The zero-based line and character of an offset in `text`. */
export const lineAndCharacter = (text: string, offset: number) => {
	const lines = text.slice(0, offset).split("\n");
	return { line: lines.length - 1, character: (lines.at(-1) as string).length };
};

/** The nearest `tsconfig.json` in `folder` or a folder above it. */
const findConfig = (folder: string): string | null => {
	for (let current = folder; ; current = dirname(current)) {
		const candidate = join(current, "tsconfig.json");
		try {
			readFileSync(candidate);
			return candidate;
		} catch {
			// Keep looking.
		}
		if (dirname(current) === current) return null;
	}
};

/**
 * Loads the TypeScript installed for the project in `folder`, with the nearest `tsconfig.json`. Null when either is
 * missing or the version is older than 6. Version 7 and later use TypeScript's new API; version 6 uses the classic one.
 */
export const openTypeScript = async (
	folder: string,
	warn: (message: string) => void,
): Promise<TypeScriptProject | null> => {
	const configPath = findConfig(folder);
	if (!configPath) return null;
	const require = createRequire(join(folder, "kiln.json"));
	let major: number;
	try {
		const pkg = JSON.parse(
			readFileSync(require.resolve("typescript/package.json"), "utf8"),
		) as { version: string };
		major = Number(pkg.version.split(".")[0]);
	} catch {
		return null;
	}
	try {
		if (major >= 7) {
			const sync = (await import(
				pathToFileURL(require.resolve("typescript/unstable/sync")).href
			)) as Parameters<typeof openTypeScript7>[0];
			return openTypeScript7(sync, configPath);
		}
		if (major === 6) {
			return openTypeScript6(
				require("typescript") as Parameters<typeof openTypeScript6>[0],
				configPath,
			);
		}
	} catch (error) {
		warn(`Kiln: couldn't load TypeScript. ${(error as Error).message}`);
	}
	return null;
};
