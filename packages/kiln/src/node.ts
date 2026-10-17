import { lstat, readdir, readFile } from "node:fs/promises";
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
 * It skips dot files and folders and symlinks below the root, without entering them. The root itself may be a symlink.
 * A name that is missing, is a folder or holds a null character loads as null, so Kiln reports `missing-template`.
 * Other errors name the template and the error code, never the path on disk.
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
				// Check every component: rejecting only a symlink at the final file still follows linked folders.
				let current = root;
				for (const part of relative(root, path).split(sep)) {
					current = join(current, part);
					if ((await lstat(current)).isSymbolicLink()) return null;
				}
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
			const names: string[] = [];
			const visit = async (folder: string, from: string): Promise<void> => {
				for (const entry of await readdir(folder, { withFileTypes: true })) {
					if (entry.name.startsWith(".")) continue;
					const name = from + entry.name;
					if (entry.isFile()) names.push(name);
					else if (entry.isDirectory()) {
						await visit(join(folder, entry.name), name + "/");
					}
				}
			};
			await visit(root, "");
			return names.sort();
		},
	};
};
