import { fileURLToPath } from "node:url";
import { createKiln, type Kiln } from "@lucidkiln/core";
import { fileLoader } from "@lucidkiln/core/node";
import { createCodeFilters } from "../plugin/code.js";
import { anchorHeadings } from "../plugin/html.js";
import { toMarkdown } from "../plugin/markdown.js";
import { navigation, pageContext } from "./navigation.js";
import { site } from "./site.js";

/** One name's docs: Markdown from its section of the docs, up to its first example, and that section's URL. */
type EditorDoc = { markdown: string; url: string };
type EditorDocs = Record<
	"tags" | "filters" | "functions" | "tests",
	Record<string, EditorDoc>
>;

/** The file the language server reads hover and completion docs from. The docs build writes it. */
export const EDITOR_DOCS_FILE = fileURLToPath(
	new URL("../../../packages/language-server/src/docs.json", import.meta.url),
);

const templatesRoot = fileURLToPath(new URL(".", import.meta.url));

/** Tags documented in a section of another tag's page: the page, and the section's heading or null for the intro. */
const TAG_SECTIONS: Record<string, [page: string, heading: string | null]> = {
	elseif: ["if", null],
	else: ["if", null],
	block: ["extends", "Blocks"],
	fill: ["component", "Slots"],
	slot: ["component", "Slots"],
	import: ["macro", "Importing"],
	from: ["macro", "Importing"],
	add: ["outlet", "Adding content"],
};

type Section = { heading: string | null; blocks: string[] };

/** Splits a page's Markdown into its intro and its `##` sections, each as blocks between blank lines. Code fences stay whole. */
const sectionsOf = (markdown: string): Section[] => {
	let current: Section = { heading: null, blocks: [] };
	const sections = [current];
	let block: string[] = [];
	let fence: string | null = null;
	const endBlock = () => {
		if (block.length > 0) current.blocks.push(block.join("\n"));
		block = [];
	};
	for (const line of markdown.split("\n")) {
		if (fence !== null) {
			block.push(line);
			if (line === fence) {
				fence = null;
				endBlock();
			}
			continue;
		}
		const open = /^`{3,}/.exec(line)?.[0];
		if (open) {
			endBlock();
			fence = open;
			block.push(line);
		} else if (line.startsWith("## ")) {
			endBlock();
			current = { heading: line.slice(3), blocks: [] };
			sections.push(current);
		} else if (line.trim() === "") {
			endBlock();
		} else {
			block.push(line);
		}
	}
	endBlock();
	return sections;
};

const isFence = (block: string | undefined) =>
	block?.startsWith("```") ?? false;
/** A file name or "Output:" above a code block in an example. */
const isLabel = (block: string | undefined) => /^\S+:$/.test(block ?? "");

/** A section's blocks up to the end of its first example, including the example's other files and its output. */
const excerpt = (blocks: string[]): string => {
	const first = blocks.findIndex(isFence);
	if (first === -1) return blocks.join("\n\n");
	let end = first;
	while (isLabel(blocks[end + 1]) && isFence(blocks[end + 2])) end += 2;
	return blocks.slice(0, end + 1).join("\n\n");
};

/** The names a heading such as "`upper` and `lower`" documents. */
const namesIn = (heading: string) =>
	Array.from(heading.matchAll(/`([^`]+)`/g), (match) => match[1] ?? "");

const kindOf = (url: string): keyof EditorDocs | null => {
	if (url.startsWith("/docs/tags/")) return "tags";
	if (url.startsWith("/docs/filters/")) return "filters";
	if (url === "/docs/functions/") return "functions";
	if (url === "/docs/tests/") return "tests";
	return null;
};

/**
 * Renders the docs pages for tags, filters, functions and tests, and returns `docs.json` for the language server: each
 * name's docs as Markdown, the same Markdown the site publishes, with a link to its section.
 */
export const generateEditorDocs = async (): Promise<string> => {
	const kiln: Kiln = createKiln({
		loader: fileLoader({ root: templatesRoot }),
		globals: { site, navigation },
		filters: await createCodeFilters((name, context) =>
			kiln.render(name, context),
		),
	});
	const docs: EditorDocs = { tags: {}, filters: {}, functions: {}, tests: {} };
	/** Each tag page's URL, intro and sections, and the id of each section after the intro. */
	const tagPages = new Map<
		string,
		{ url: string; sections: Section[]; ids: string[] }
	>();

	for (const item of navigation.flatMap((section) => section.items)) {
		const kind = kindOf(item.url);
		if (!kind) continue;
		const template = `pages${item.url.replace(/\/$/, "")}.kiln`;
		const html = await kiln.renderBlock(
			template,
			"content",
			pageContext(item.url, template),
		);
		const url = `${site.url}${item.url}`;
		const sections = sectionsOf(toMarkdown(html, site.url));
		// The `h2`s match the `##` sections in order, and give each its id on the page.
		const ids = anchorHeadings(html).headings.map((heading) => heading.id);
		const intro = {
			blocks: [item.description, ...(sections[0]?.blocks ?? [])],
		};

		if (kind === "tags") {
			const page = item.url.split("/").at(-2) ?? "";
			docs.tags[page] = { markdown: excerpt(intro.blocks), url };
			tagPages.set(page, {
				url,
				sections: [{ heading: null, ...intro }, ...sections.slice(1)],
				ids,
			});
			continue;
		}
		sections.slice(1).forEach((section, index) => {
			for (const name of namesIn(section.heading ?? "")) {
				docs[kind][name] = {
					markdown: excerpt(section.blocks),
					url: `${url}#${ids[index]}`,
				};
			}
		});
	}

	for (const [tag, [page, heading]] of Object.entries(TAG_SECTIONS)) {
		const found = tagPages.get(page);
		const index =
			found?.sections.findIndex((section) => section.heading === heading) ?? -1;
		const section = found?.sections[index];
		if (!found || !section) {
			throw new Error(`No "${heading ?? "intro"}" section on the ${page} page`);
		}
		docs.tags[tag] = {
			markdown: excerpt(section.blocks),
			url: heading ? `${found.url}#${found.ids[index - 1]}` : found.url,
		};
	}

	const sorted = Object.fromEntries(
		Object.entries(docs).map(([kind, entries]) => [
			kind,
			Object.fromEntries(
				Object.entries(entries).sort(([a], [b]) => a.localeCompare(b)),
			),
		]),
	);
	return `${JSON.stringify(sorted, null, "\t")}\n`;
};
