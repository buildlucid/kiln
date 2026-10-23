import type { KilnPagesOptions } from "../plugin/index.js";
import { toMarkdown } from "../plugin/markdown.js";
import { home, markdownPath, navigation } from "./navigation.js";
import { site } from "./site.js";

/**
 * Builds the files that sit beside the pages: `sitemap.xml`, `llms.txt`, `llms-full.txt`,
 * and a Markdown copy of each docs page for language models and the "Copy as Markdown" button.
 */
export const siteFiles: NonNullable<KilnPagesOptions["files"]> = async ({
	pages,
	renderBlock,
}) => {
	const files: Record<string, string> = {};

	const urls = pages
		.filter((page) => page.file !== "404.html")
		.map((page) => `\t<url><loc>${site.url}${page.url}</loc></url>`);
	files["sitemap.xml"] =
		`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`;

	const docs: string[] = [];
	for (const section of navigation) {
		for (const item of section.items) {
			const page = pages.find((candidate) => candidate.url === item.url);
			if (!page)
				throw new Error(`${item.url} is in the navigation but has no page`);
			const body = toMarkdown(await renderBlock(page, "content"), site.url);
			const markdown = `# ${item.title}\n\n> ${item.description}\n\n${body}\n`;
			files[markdownPath(item.url).slice(1)] = markdown;
			docs.push(markdown);
		}
	}

	const index = navigation.map(
		(section) =>
			`## ${section.title}\n\n${section.items
				.map(
					(item) =>
						`- [${item.title}](${site.url}${markdownPath(item.url)}): ${item.description}`,
				)
				.join("\n")}`,
	);

	files["llms.txt"] = `# ${site.name}

> ${home.description}

Install it with \`npm install ${site.package}\`. Things to know when writing Kiln templates:

- The syntax is close to Twig: \`{{ value }}\` prints, \`{% tag %}\` runs logic, \`{# comment #}\` is ignored.
- Names of filters, functions, tests and variables are camelCase, like JavaScript: \`formatDate\`, not \`format_date\`.
- Strict mode is on by default, so unknown variables, properties, filters and functions are errors.
- Output is HTML-escaped by default. \`raw\` marks trusted HTML.
- Templates can call async functions to load data. Kiln only waits where a call returns a promise.
- Kiln has no runtime dependencies and runs on Node 24, Node 26 and Cloudflare Workers.

${index.join("\n\n")}

## Optional

- [Full documentation](${site.url}/llms-full.txt): Every docs page above in one Markdown file.
- [Source code](${site.repository}): The Kiln repository on GitHub.
`;

	files["llms-full.txt"] =
		`# ${site.name} documentation\n\n> ${home.description}\n\n${docs.join("\n---\n\n")}`;

	return files;
};
