import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import type { Loader } from "./environment.js";

export type FileLoaderOptions = {
	/** Directory that template names are relative to. */
	root: string;
};

/**
 * A loader that reads templates from disk. Node only; use `memoryLoader` on Cloudflare Workers.
 *
 * `list` returns every file under the root, skipping files and folders whose names start with a dot.
 *
 * ```ts
 * const kiln = createKiln({ loader: fileLoader({ root: "src/site" }) });
 * ```
 */
export const fileLoader = (
	options: FileLoaderOptions,
): Omit<Loader, "list"> & { list(): Promise<string[]> } => {
	const root = resolve(options.root);
	return {
		load: async (name) => {
			const path = resolve(root, name);
			// Kiln never resolves names above the root, but check anyway.
			if (!path.startsWith(root + sep)) return null;
			try {
				return await readFile(path, "utf8");
			} catch (error) {
				if ((error as { code?: unknown }).code === "ENOENT") return null;
				throw error;
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
				return name.split("/").some((part) => part.startsWith("."))
					? []
					: [name];
			});
		},
	};
};
