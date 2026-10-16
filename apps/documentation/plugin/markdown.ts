const entities: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	"#39": "'",
	nbsp: " ",
};

const decode = (text: string) =>
	text.replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (entity, name: string) => {
		if (name[0] !== "#") return entities[name] ?? entity;
		return String.fromCodePoint(
			name[1] === "x" || name[1] === "X"
				? Number.parseInt(name.slice(2), 16)
				: Number(name.slice(1)),
		);
	});

const stripTags = (html: string) => html.replace(/<[^>]*>/g, "");

/** Converts inline markup, such as the inside of a paragraph, to one line of Markdown. */
const inline = (html: string, origin: string): string =>
	decode(
		html
			.replace(
				/<code>([\s\S]*?)<\/code>/g,
				(_, code: string) => `\`${stripTags(code)}\``,
			)
			.replace(/<(strong|b)>([\s\S]*?)<\/\1>/g, "**$2**")
			.replace(/<(em|i)>([\s\S]*?)<\/\1>/g, "_$2_")
			.replace(
				/<a\s[^>]*?href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g,
				(_, href: string, text: string) =>
					`[${text}](${href.startsWith("/") ? origin + href : href})`,
			)
			.replace(/<br\s*\/?>/g, "\0")
			.replace(/<[^>]*>/g, ""),
	)
		.replace(/\s+/g, " ")
		.replace(/ ?\0 ?/g, "  \n")
		.trim();

const fence = (code: string, lang: string) => {
	const text = decode(stripTags(code)).replace(/\s+$/, "");
	const ticks = text.includes("```") ? "````" : "```";
	return `${ticks}${lang}\n${text}\n${ticks}`;
};

/** A code block or an example: each file's label, then its code. */
const figure = (html: string) =>
	Array.from(
		html.matchAll(
			/<(\w+) class="code-label">([\s\S]*?)<\/\1>|<pre[^>]*?data-lang="([^"]*)"[^>]*>([\s\S]*?)<\/pre>/g,
		),
		([, , label, lang = "", code = ""]) =>
			label === undefined
				? fence(code, lang)
				: `${decode(stripTags(label)).trim()}:`,
	).join("\n\n");

const table = (html: string, origin: string) => {
	const rows = Array.from(
		html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g),
		([, row = ""]) =>
			Array.from(
				row.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g),
				([, cell = ""]) => inline(cell, origin).replace(/\|/g, "\\|"),
			),
	);
	const [head = [], ...body] = rows;
	return [head, head.map(() => "---"), ...body]
		.map((cells) => `| ${cells.join(" | ")} |`)
		.join("\n");
};

const list = (tag: string, html: string, origin: string) =>
	Array.from(
		html.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g),
		([, item = ""], n) =>
			`${tag === "ol" ? `${n + 1}.` : "-"} ${inline(item, origin)}`,
	).join("\n");

/** Block elements the docs use, in the order they appear. Anything else between them is skipped. */
const blocks =
	/<figure[\s\S]*?<\/figure>|<table[\s\S]*?<\/table>|<h([2-4])[^>]*>([\s\S]*?)<\/h\1>|<(ul|ol)[^>]*>([\s\S]*?)<\/\3>|<aside[^>]*>([\s\S]*?)<\/aside>|<p[^>]*>([\s\S]*?)<\/p>/g;

/**
 * Converts a docs page's rendered content to Markdown, for `llms.txt` and the `.md` copy of each page.
 *
 * It handles the markup the docs use: headings, paragraphs, flat lists, tables, callouts and code blocks.
 * Root-relative links become absolute, using `origin`.
 */
export const toMarkdown = (html: string, origin: string): string =>
	Array.from(html.matchAll(blocks), (match) => {
		const [block, level, heading, listTag, listBody, aside, paragraph] = match;
		if (block.startsWith("<figure")) return figure(block);
		if (block.startsWith("<table")) return table(block, origin);
		if (level)
			return `${"#".repeat(Number(level))} ${inline(heading ?? "", origin)}`;
		if (listTag) return list(listTag, listBody ?? "", origin);
		if (aside !== undefined)
			return aside
				.split(/<\/p>/)
				.map((part) => inline(part, origin))
				.filter(Boolean)
				.map((text) => `> ${text}`)
				.join("\n>\n");
		return inline(paragraph ?? "", origin);
	})
		.filter(Boolean)
		.join("\n\n");
