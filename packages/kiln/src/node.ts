import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import type { Loader } from "./environment.js";

/** Error codes that mean there is no template file at a path. */
const MISSING = new Set(["ENOENT", "ENOTDIR", "EISDIR"]);

/** Whether any segment of a name starts with a dot, such as `.cache/old.kiln`. */
const isHidden = (name: string): boolean =>
	name.split("/").some((part) => part.startsWith("."));

export type FileLoaderOptions = {
	/** Directory that template names are relative to. */
	root: string;
};

/**
 * A loader that reads templates from disk. Node only; use `memoryLoader` on Cloudflare Workers.
 *
 * It never reads files or folders whose names start with a dot, and `list` skips them too. A name that is missing, is a
 * folder or holds a null character loads as null, so Kiln reports `missing-template`. Other errors name the template
 * and the error code, never the path on disk.
 *
 * ```ts
 * const kiln = createKiln({ loader: fileLoader({ root: "src/site" }) });
 * ```
 */
export const fileLoader = (
	options: FileLoaderOptions,
): Omit<Loader, "list"> & { list(): Promise<string[]> } => {
	const root = resolve(options.root);
	// `resolve` keeps the separator of a root such as "/", so only add one when it is missing.
	const prefix = root.endsWith(sep) ? root : root + sep;
	return {
		load: async (name) => {
			if (name.includes("\0") || isHidden(name)) return null;
			const path = resolve(root, name);
			// Kiln never resolves names above the root, but check anyway.
			if (!path.startsWith(prefix)) return null;
			try {
				return await readFile(path, "utf8");
			} catch (error) {
				const code = (error as { code?: unknown }).code;
				if (typeof code === "string" && MISSING.has(code)) return null;
				throw new Error(
					`Could not read template "${name}"${typeof code === "string" ? ` (${code})` : ""}`,
				);
			}
		},
		list: async () => {
			const entries = await readdir(root, {
				recursive: true,
				withFileTypes: true,
			});
			return entries.flatMap((entry) => {
				if (!entry.isFile()) return [];
				const name = relative(root, join(entry.parentPath, entry.name))
					.split(sep)
					.join("/");
				return isHidden(name) ? [] : [name];
			});
		},
	};
};
