/** An `h2` from a rendered page, for the "On this page" list. */
export type Heading = { id: string; text: string };

const entities: Record<string, string> = {
	"&amp;": "&",
	"&lt;": "<",
	"&gt;": ">",
	"&quot;": '"',
	"&#39;": "'",
};

const textOf = (html: string) =>
	html
		.replace(/<[^>]*>/g, "")
		.replace(/&(amp|lt|gt|quot|#39);/g, (entity) => entities[entity] ?? entity)
		.trim();

const slugify = (text: string) =>
	text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "");

/**
 * Gives every `h2` and `h3` an id and wraps its content in a link to itself, so readers can share a section.
 *
 * Returns the updated HTML, the `h2`s in order, and every id on the page.
 */
export const anchorHeadings = (html: string) => {
	const headings: Heading[] = [];
	const ids = new Set<string>(
		Array.from(html.matchAll(/\sid="([^"]+)"/g), (match) => match[1] ?? ""),
	);

	const result = html.replace(
		/<h([23])((?:\s[^>]*)?)>([\s\S]*?)<\/h\1>/g,
		(_, level: string, attributes: string, content: string) => {
			const text = textOf(content);
			let id = /\sid="([^"]+)"/.exec(attributes)?.[1];
			if (!id) {
				const base = slugify(text) || "section";
				id = base;
				for (let n = 2; ids.has(id); n++) id = `${base}-${n}`;
				ids.add(id);
				attributes += ` id="${id}"`;
			}
			if (level === "2") headings.push({ id, text });
			return `<h${level}${attributes}><a href="#${id}">${content}</a></h${level}>`;
		},
	);

	return { html: result, headings, ids };
};

/** Every internal link target on a page: root-relative paths and same-page fragments. */
export const internalLinks = (html: string): string[] =>
	Array.from(
		html.matchAll(/<a\s[^>]*?href="([/#][^"]*)"/g),
		(match) => match[1] ?? "",
	);

/** Wraps each table so it scrolls sideways on narrow screens instead of widening the page. */
export const wrapTables = (html: string): string =>
	html
		.replace(/<table(\s|>)/g, '<div class="table-scroll"><table$1')
		.replace(/<\/table>/g, "</table></div>");
