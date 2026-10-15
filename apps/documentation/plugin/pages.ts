import { glob } from "node:fs/promises";
import { join } from "node:path";

/** A `.kiln` file under the pages directory, and where it is published. */
export type Page = {
	/** Template name for Kiln, such as `pages/docs/tags/for.kiln`. */
	template: string;
	/** Public URL, such as `/docs/tags/for/`. */
	url: string;
	/** Output file, relative to the build directory, such as `docs/tags/for/index.html`. */
	file: string;
};

/**
 * Maps a template path inside the pages directory to its URL and output file.
 *
 * `index.kiln` becomes `/`, `404.kiln` becomes `/404.html`, and `docs/tags/for.kiln` becomes `/docs/tags/for/`.
 */
export const toPage = (pagesDir: string, path: string): Page => {
	const name = path.replace(/\.kiln$/, "");
	const template = `${pagesDir}/${path}`;
	if (name === "404") return { template, url: "/404.html", file: "404.html" };

	const dir = name === "index" ? "" : name.replace(/\/?index$/, "");
	return {
		template,
		url: dir ? `/${dir}/` : "/",
		file: dir ? `${dir}/index.html` : "index.html",
	};
};

/** Finds every page under `templatesRoot/pagesDir`, sorted by URL. */
export const findPages = async (
	templatesRoot: string,
	pagesDir: string,
): Promise<Page[]> => {
	const pages: Page[] = [];
	for await (const path of glob("**/*.kiln", {
		cwd: join(templatesRoot, pagesDir),
	})) {
		pages.push(toPage(pagesDir, path.split("\\").join("/")));
	}
	return pages.sort((a, b) => a.url.localeCompare(b.url));
};

/** Finds the page for a request path. `/docs/tags/for` and `/docs/tags/for/index.html` both match `/docs/tags/for/`. */
export const matchPage = (
	pages: Page[],
	pathname: string,
): Page | undefined => {
	const path = pathname.replace(/index\.html$/, "");
	return pages.find(
		(page) =>
			page.url === path ||
			page.url === `${path}/` ||
			`/${page.file}` === pathname,
	);
};
