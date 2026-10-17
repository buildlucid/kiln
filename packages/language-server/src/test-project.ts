import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** The TypeScript versions tests run against, by the package that provides each. */
export const TYPESCRIPT_VERSIONS = {
	6: "typescript-6",
	7: "typescript",
} as const;

/** Host code for test projects: typed functions, filters, globals and a prop type, described for the editor. */
const KILN_TS = `import { withRender } from "@lucidkiln/core";

type Brick = {
	/** Picks the section template. */
	key: string;
	fields: Record<string, unknown>;
};

export class Page {
	/** The page's title. */
	title = "";
	bricks: Brick[] = [];
}

type Collections = { pages: Page; bricks: Brick };

const functions = {
	/**
	 * Finds the published documents in a collection.
	 * @param collection The collection's key.
	 */
	documents: async (collection: string, query: { limit?: number } = {}): Promise<Page[]> => [],
	locale: withRender((render: { state: unknown }, fallback: string) => fallback),
	/** Generic, so each collection gives its own type. */
	first: async <Key extends keyof Collections>(collection: Key): Promise<Collections[Key] | null> => null,
	latest: withRender(<Key extends keyof Collections>(render: { state: unknown }, collection: Key): Collections[Key][] => []),
};

const filters = {
	/** Turns Markdown into HTML. */
	markdown: (value: string, options?: { inline?: boolean }) => value,
	pick: <Value, Key extends keyof Value>(value: Value, key: Key): Value[Key] => value[key],
};

const globals = {
	/** About the site. */
	site: { name: "Kiln", url: "https://kilnlang.com" },
};

type Functions = typeof functions;
type Filters = typeof filters;
type Globals = typeof globals;

declare module "@lucidkiln/core" {
	interface KilnFunctions extends Functions {}
	interface KilnFilters extends Filters {}
	interface KilnGlobals extends Globals {}
	interface KilnTypes {
		Page: Page;
	}
}
`;

/**
 * Writes a project with `kiln.json`, `tsconfig.json`, typed host code and the given TypeScript version linked in, and
 * returns its folder. Kiln itself is linked from this repository.
 */
export const createTestProject = async (
	version: keyof typeof TYPESCRIPT_VERSIONS,
): Promise<string> => {
	const dir = await mkdtemp(join(tmpdir(), "kiln-ts-"));
	await mkdir(join(dir, "src/templates"), { recursive: true });
	await mkdir(join(dir, "node_modules/@lucidkiln"), { recursive: true });
	await symlink(
		join(repo, "packages/kiln"),
		join(dir, "node_modules/@lucidkiln/core"),
	);
	await symlink(
		join(repo, "node_modules", TYPESCRIPT_VERSIONS[version]),
		join(dir, "node_modules/typescript"),
	);
	await writeFile(
		join(dir, "tsconfig.json"),
		JSON.stringify({
			compilerOptions: {
				strict: true,
				module: "nodenext",
				target: "es2022",
				noEmit: true,
				skipLibCheck: true,
			},
			include: ["src"],
		}),
	);
	await writeFile(
		join(dir, "kiln.json"),
		JSON.stringify({
			root: "src/templates",
			functions: ["documents", "locale", "first", "latest"],
			filters: ["markdown", "pick"],
			globals: ["site"],
			types: ["Page"],
		}),
	);
	await writeFile(join(dir, "src/kiln.ts"), KILN_TS);
	return dir;
};
