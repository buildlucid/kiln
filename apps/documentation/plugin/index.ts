import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { createKiln, type Kiln } from "@lucidcms/kiln";
import { fileLoader } from "@lucidcms/kiln/node";
import type { Plugin } from "vite-plus";
import { createCodeFilters } from "./code.js";
import { anchorHeadings, internalLinks, wrapTables } from "./html.js";
import { findPages, matchPage, type Page } from "./pages.js";

export type { Page } from "./pages.js";

export type KilnPagesOptions = {
	/** Directory holding every template, relative to the Vite root. Default `src`. */
	templates?: string;
	/** Directory of pages inside `templates`. Default `pages`. */
	pages?: string;
	/** Globals for every template. */
	globals?: Record<string, unknown>;
	/** Variables for one page's render. */
	context?: (page: Page) => Record<string, unknown>;
};

/** Pages put this comment where the "On this page" list goes. */
const TOC = "<!-- toc -->";

/** What a render found, for checking links once every page has rendered. */
type Rendered = { ids: Set<string>; links: string[] };

/**
 * Renders `.kiln` pages to static HTML.
 *
 * Every file in `src/pages` becomes a page: `pages/docs/tags/for.kiln` is published at `/docs/tags/for/`.
 * In dev the plugin renders pages on request. In a build each page becomes an HTML entry, so Vite
 * processes its styles and assets as usual. The build fails on links to pages or headings that don't exist.
 */
export const kilnPages = (options: KilnPagesOptions = {}): Plugin => {
	const pagesDir = options.pages ?? "pages";
	let root = process.cwd();
	let templatesRoot = "";
	let publicDir = "";
	let pages: Page[] = [];
	let kiln: Kiln | undefined;
	const rendered = new Map<Page, Rendered>();

	const environment = async () => {
		if (kiln) return kiln;
		const render = (
			name: string,
			context: Record<string, unknown>,
		): Promise<string> => created.render(name, context);
		const created = createKiln({
			loader: fileLoader({ root: templatesRoot }),
			globals: options.globals,
			filters: await createCodeFilters(render),
		});
		kiln = created;
		return created;
	};

	const renderPage = async (page: Page) => {
		const env = await environment();
		const html = await env.render(page.template, options.context?.(page));
		const anchored = anchorHeadings(wrapTables(html));
		const toc = anchored.html.includes(TOC)
			? await env.render("components/toc", { headings: anchored.headings })
			: "";
		rendered.set(page, {
			ids: anchored.ids,
			links: internalLinks(anchored.html),
		});
		return anchored.html.replace(TOC, toc);
	};

	const pageFile = (page: Page) => resolve(root, page.file);

	return {
		name: "kiln-pages",

		async config(config) {
			root = resolve(config.root ?? process.cwd());
			templatesRoot = join(root, options.templates ?? "src");
			pages = await findPages(templatesRoot, pagesDir);
			return {
				appType: "mpa",
				build: {
					rolldownOptions: {
						input: Object.fromEntries(
							pages.map((page) => [page.file, pageFile(page)]),
						),
					},
				},
			};
		},

		configResolved(config) {
			publicDir = config.publicDir;
		},

		resolveId(id) {
			return pages.some((page) => pageFile(page) === id) ? id : null;
		},

		load(id) {
			const page = pages.find((candidate) => pageFile(candidate) === id);
			return page ? renderPage(page) : null;
		},

		buildEnd(error) {
			if (error) return;
			const problems: string[] = [];
			for (const [page, { ids, links }] of rendered) {
				for (const link of links) {
					const [path = "", fragment] = link.split("#");
					const target = path ? matchPage(pages, path) : page;
					const targetIds = target && rendered.get(target)?.ids;
					if (!target && !existsSync(join(publicDir, path)))
						problems.push(
							`${page.template} links to ${link}, which doesn't exist`,
						);
					else if (fragment && targetIds && !targetIds.has(fragment))
						problems.push(
							`${page.template} links to ${link}, which has no #${fragment}`,
						);
					else if (fragment && !path && !ids.has(fragment))
						problems.push(
							`${page.template} links to #${fragment}, which doesn't exist`,
						);
				}
			}
			if (problems.length) this.error(`Broken links:\n${problems.join("\n")}`);
		},

		configureServer(server) {
			server.watcher.on("all", async (event, file) => {
				if (!file.endsWith(".kiln")) return;
				if (event === "add" || event === "unlink")
					pages = await findPages(templatesRoot, pagesDir);
				kiln?.invalidate();
				server.ws.send({ type: "full-reload" });
			});

			server.middlewares.use(async (req, res, next) => {
				const url = new URL(req.url ?? "/", "http://localhost");
				const isPageRequest =
					!url.pathname.startsWith("/@") &&
					(url.pathname.endsWith("/") ||
						url.pathname.endsWith(".html") ||
						!url.pathname.includes("."));
				if (!isPageRequest) return next();

				const page =
					matchPage(pages, url.pathname) ?? matchPage(pages, "/404.html");
				if (!page) return next();

				try {
					const html = await server.transformIndexHtml(
						url.pathname,
						await renderPage(page),
					);
					res.statusCode = page.file === "404.html" ? 404 : 200;
					res.setHeader("Content-Type", "text/html");
					res.end(html);
				} catch (error) {
					const message =
						error instanceof Error ? error.message : String(error);
					server.config.logger.error(message);
					res.statusCode = 500;
					res.setHeader("Content-Type", "text/plain");
					res.end(message);
				}
			});
		},
	};
};
