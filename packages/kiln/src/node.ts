import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { Loader } from "./environment.js";

export type FileLoaderOptions = {
	/** Directory that template names are relative to. */
	root: string;
};

/**
 * A loader that reads templates from disk. Node only; use `memoryLoader` on Cloudflare Workers.
 *
 * ```ts
 * const kiln = createKiln({ loader: fileLoader({ root: "src/site" }) });
 * ```
 */
export const fileLoader = (options: FileLoaderOptions): Loader => {
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
	};
};
