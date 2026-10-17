import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { KilnSyntaxError } from "../errors.js";
import { format, KilnFormatError } from "./format.js";

export const USAGE = `Usage: kiln format [--check] [--spaces <width>] <files or folders...>

  --check           List files that need formatting, without changing them. Exits with 1 if any do.
  --spaces <width>  Indent with this many spaces instead of tabs.`;

/**
 * Every `.kiln` file at or under each path, once each, skipping dot folders and node_modules. `skipped` lists files
 * named directly that aren't `.kiln` files. Throws for a path that doesn't exist.
 */
const findTemplates = async (
	paths: readonly string[],
): Promise<{ files: string[]; skipped: string[] }> => {
	const files: string[] = [];
	const skipped: string[] = [];
	for (const path of paths) {
		if (!(await stat(path)).isDirectory()) {
			(path.endsWith(".kiln") ? files : skipped).push(path);
			continue;
		}
		const entries = await readdir(path, {
			recursive: true,
			withFileTypes: true,
		});
		for (const entry of entries) {
			const file = join(entry.parentPath, entry.name);
			const parts = relative(path, file).split(/[\\/]/);
			if (
				entry.isFile() &&
				entry.name.endsWith(".kiln") &&
				!parts.some((part) => part.startsWith(".") || part === "node_modules")
			) {
				files.push(file);
			}
		}
	}
	// The same file can be named directly and found in a folder, or named twice.
	const seen = new Set<string>();
	const unique = files.filter((file) => {
		const key = resolve(file);
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
	return { files: unique.sort(), skipped };
};

/** Paths that don't exist. */
const missingPaths = async (paths: readonly string[]): Promise<string[]> => {
	const missing: string[] = [];
	for (const path of paths) {
		try {
			await stat(path);
		} catch {
			missing.push(path);
		}
	}
	return missing;
};

/** Where the command writes its messages. */
export type CommandOutput = {
	stdout: (text: string) => void;
	stderr: (text: string) => void;
};

/**
 * Runs `kiln format` with the arguments after `format`, and returns the exit code: 0 when done, 1 when files need formatting under `--check` or have errors, and 2 for bad arguments or paths that don't exist.
 */
export const formatCommand = async (
	args: readonly string[],
	io: CommandOutput,
): Promise<number> => {
	let check = false;
	let spaces: number | null = null;
	const paths: string[] = [];
	for (let index = 0; index < args.length; index++) {
		const arg = args[index] as string;
		if (arg === "--check") check = true;
		else if (arg === "--spaces") {
			spaces = Number(args[++index]);
			if (!Number.isInteger(spaces) || spaces < 1) {
				io.stderr("--spaces needs a whole number of at least 1\n");
				return 2;
			}
		} else if (arg.startsWith("-")) {
			io.stderr(`Unknown option ${arg}\n\n${USAGE}\n`);
			return 2;
		} else paths.push(arg);
	}
	if (paths.length === 0) {
		io.stderr(`${USAGE}\n`);
		return 2;
	}

	const missing = await missingPaths(paths);
	if (missing.length > 0) {
		for (const path of missing) io.stderr(`${path}: not found\n`);
		return 2;
	}

	const options = spaces === null ? {} : { useTabs: false, tabWidth: spaces };
	const { files, skipped } = await findTemplates(paths);
	for (const file of skipped) {
		io.stderr(`${file}: skipped, as it isn't a .kiln file\n`);
	}
	let failed = false;
	let unformatted = 0;
	for (const file of files) {
		// Each file's problems are reported, and the rest are still formatted.
		try {
			const source = await readFile(file, "utf8");
			const formatted = format(source, options);
			if (formatted === source) continue;
			unformatted++;
			io.stdout(`${file}\n`);
			if (!check) await writeFile(file, formatted);
		} catch (error) {
			failed = true;
			if (error instanceof KilnSyntaxError) {
				for (const problem of error.diagnostics) {
					io.stderr(
						`${file}:${problem.start.line}:${problem.start.column}: ${problem.message}\n`,
					);
				}
			} else if (error instanceof KilnFormatError) {
				io.stderr(`${file}: ${error.message}\n`);
			} else {
				io.stderr(
					`${file}: ${error instanceof Error ? error.message : String(error)}\n`,
				);
			}
		}
	}
	if (check && unformatted > 0) {
		io.stderr(
			`${unformatted} ${unformatted === 1 ? "file needs" : "files need"} formatting. Run kiln format to fix.\n`,
		);
	}
	return failed || (check && unformatted > 0) ? 1 : 0;
};
