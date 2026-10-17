import { contentStart, type LexResult, type TextLine } from "../lexer/lexer.js";
import type { IslandStatement, Statement, TemplateNode } from "./ast.js";

/** The statements inside one tag, with where the tag starts and where its whole span ends. */
type Body = {
	open: number;
	end: number;
	lists: Statement[][];
	/** Keeps every line's indentation, for content written back inside a wrapper, such as an island's fallback. */
	keep?: boolean;
};

/** The bodies a statement holds. Branches share their tag's body. A component's fills are bodies of their own, inside the component's. */
const bodiesOf = (node: Statement): Body[] => {
	const own = (lists: Statement[][]): Body => ({
		open: node.span.start,
		end: node.span.end,
		lists,
	});
	switch (node.type) {
		case "If":
			return [
				own([
					...node.branches.map((branch) => branch.body),
					node.alternate ?? [],
				]),
			];
		case "For":
			return [own([node.body, node.alternate ?? []])];
		case "Component":
			return [
				...node.fills.map((fill) => ({
					open: fill.span.start,
					end: fill.span.end,
					lists: [fill.body],
				})),
				own([node.body, ...node.fills.map((fill) => fill.body)]),
			];
		case "Island":
			return [{ ...own([node.body]), keep: true }];
		case "Block":
		case "Slot":
		case "Add":
		case "SetBlock":
		case "Macro":
		case "Cache":
		case "With":
		case "Apply":
		case "Autoescape":
			return [own([node.body])];
		default:
			return NO_BODIES;
	}
};

const NO_BODIES: Body[] = [];

/** The statement lists inside a statement, each once. Only a component's fills appear in more than one body. */
const childLists = (bodies: Body[]): Iterable<Statement[]> =>
	bodies.length === 1
		? (bodies[0] as Body).lists
		: new Set(bodies.flatMap((body) => body.lists));

/** The index of the first item whose key is at least `value`, in a list sorted by that key. */
const firstAtLeast = <T>(
	items: readonly T[],
	value: number,
	key: (item: T) => number,
): number => {
	let low = 0;
	let high = items.length;
	while (low < high) {
		const middle = (low + high) >>> 1;
		if (key(items[middle] as T) < value) low = middle + 1;
		else high = middle;
	}
	return low;
};

/**
 * Finds `<pre>` and `<textarea>` tags, and the HTML comments, scripts and styles to skip, whose `<pre` is not a tag.
 * Each region runs to its end, or to the end of the source when it is not closed.
 */
const MARKUP =
	/<!--[\s\S]*?(?:-->|$)|<(script|style)(?=[\s/>])[\s\S]*?(?:<\/\1\s*>|$)|<(\/?)(pre|textarea)(?=[\s/>])/gi;

const MAY_PREFORMAT = /<(?:pre|textarea)/i;

/** Where `<pre>` and `<textarea>` elements start and end in the template's text, whose whitespace is content. */
const preformatted = (
	text: string,
	textTokens: LexResult["tokens"],
): [number, number][] => {
	// Most templates have neither, which one scan finds.
	if (!MAY_PREFORMAT.test(text)) return [];
	// The template's text with everything else, such as tags and outputs, blanked out. Offsets stay the same, and the
	// filler is not a space, so `<pre{{ x }}>` is still not a `<pre>` tag.
	let visible = "";
	for (const token of textTokens) {
		visible += "\0".repeat(token.start - visible.length);
		visible += text.slice(token.start, token.end);
	}
	const ranges: [number, number][] = [];
	let open: { name: string; start: number } | null = null;
	MARKUP.lastIndex = 0;
	for (let match = MARKUP.exec(visible); match; match = MARKUP.exec(visible)) {
		const tag = match[3];
		if (tag === undefined) continue;
		const name = tag.toLowerCase();
		if (open === null && match[2] === "") open = { name, start: match.index };
		else if (open?.name === name && match[2] === "/") {
			ranges.push([open.start, match.index]);
			open = null;
		}
	}
	if (open) ranges.push([open.start, text.length]);
	return ranges;
};

/**
 * Removes the extra indentation inside tags that stand on their own line: the spaces and tabs that every content line
 * inside shares, beyond the tag's own indentation. It happens when compiling, so rendering is no slower.
 *
 * Also sets the indentation of `islands` whose tags stand on lines of their own, since a deferred island writes its
 * tags back as `<kiln-island>` lines. See `IslandStatement`.
 *
 * Lines inside `<pre>` and `<textarea>` keep their whitespace. Amounts come from the source alone, so nested tags each
 * remove their own step whatever order they are visited in. Then the text nodes holding those offsets are rebuilt.
 */
export const removeIndentation = (
	ast: TemplateNode,
	text: string,
	{ tokens, standalone, lines }: LexResult,
	islands: readonly IslandStatement[],
): void => {
	const textTokens = tokens.filter((token) => token.type === "text");
	const pre = preformatted(text, textTokens);
	const inPre = (offset: number): boolean => {
		const range = pre[firstAtLeast(pre, offset, (range) => range[1])];
		return range !== undefined && range[0] < offset;
	};
	const textLines =
		pre.length > 0 ? lines.filter((line) => !inPre(line.start)) : lines;

	// The first line starts after any byte order mark, as the lexer's lines do.
	const lineStart = (offset: number): number =>
		text.lastIndexOf("\n", offset - 1) + 1 || contentStart(text);
	const lineOf = (offset: number): TextLine => {
		const start = lineStart(offset);
		let indentEnd = start;
		while (text[indentEnd] === " " || text[indentEnd] === "\t") indentEnd++;
		return { start, indentEnd };
	};

	// Island tags on lines of their own are written back as lines, so they count as content lines for the tags around them.
	const islandLines: {
		node: IslandStatement;
		open: TextLine | null;
		end: TextLine | null;
	}[] = [];
	for (const node of islands) {
		if (inPre(node.span.start)) continue;
		const end = text.lastIndexOf("{%", node.span.end - 1);
		const open = standalone.has(node.span.start)
			? lineOf(node.span.start)
			: null;
		const close = standalone.has(end) ? lineOf(end) : null;
		if (open || close) islandLines.push({ node, open, end: close });
	}
	const contentLines =
		islandLines.length > 0
			? [
					...textLines,
					...islandLines.flatMap((item) =>
						[item.open, item.end].filter((line) => line !== null),
					),
				].sort((a, b) => a.start - b.start)
			: textLines;

	// Source ranges to drop, as [start, end).
	const cuts: [number, number][] = [];

	const indentOf = (offset: number): string => {
		const line = lineOf(offset);
		return text.slice(line.start, line.indentEnd);
	};

	const trim = (body: Body): void => {
		if (body.keep) return;
		const openEnd = standalone.get(body.open);
		if (openEnd === undefined) return;
		const newline = text.indexOf("\n", openEnd);
		if (newline === -1) return;
		// Lines from the one after the tag up to the end tag, which starts at the span's last `{%`.
		const to = text.lastIndexOf("{%", body.end - 1);
		const first = firstAtLeast(contentLines, newline + 1, (line) => line.start);
		const last = firstAtLeast(contentLines, to, (line) => line.start);
		if (first >= last) return;

		const own = indentOf(body.open);
		let shared = Infinity;
		const firstLine = contentLines[first] as TextLine;
		for (let i = first; i < last; i++) {
			const line = contentLines[i] as TextLine;
			let length = 0;
			while (
				length < line.indentEnd - line.start &&
				text[line.start + length] === text[firstLine.start + length]
			) {
				length++;
			}
			shared = Math.min(shared, length);
		}
		if (shared <= own.length) return;
		if (text.slice(firstLine.start, firstLine.start + own.length) !== own)
			return;
		for (let i = first; i < last; i++) {
			const line = contentLines[i] as TextLine;
			cuts.push([line.start + own.length, line.start + shared]);
		}
	};

	const visit = (list: Statement[]): void => {
		for (const node of list) {
			const bodies = bodiesOf(node);
			if (bodies.length === 0) continue;
			for (const child of childLists(bodies)) visit(child);
			for (const body of bodies) trim(body);
		}
	};
	visit(ast.body);

	// Tags indented unusually can cut overlapping ranges of one line. Merging them keeps both ends in order for the searches below.
	cuts.sort((a, b) => a[0] - b[0]);
	const merged: [number, number][] = [];
	for (const range of cuts) {
		const previous = merged[merged.length - 1];
		if (previous && range[0] <= previous[1]) {
			previous[1] = Math.max(previous[1], range[1]);
		} else merged.push(range);
	}

	/** The source from `start` to `end`, without the cut ranges. */
	const uncut = (start: number, end: number): string => {
		let out = "";
		let at = start;
		for (
			let i = firstAtLeast(merged, start, (range) => range[1] - 1);
			i < merged.length;
			i++
		) {
			const [from, to] = merged[i] as [number, number];
			if (from >= end) break;
			out += text.slice(at, Math.max(at, from));
			at = Math.max(at, to);
		}
		return out + text.slice(Math.min(at, end), end);
	};

	for (const { node, open, end } of islandLines) {
		if (open) node.indent = uncut(open.start, open.indentEnd);
		if (end) {
			const sameLine = open !== null && end.start === open.start;
			node.closing = {
				indent: sameLine ? null : uncut(end.start, end.indentEnd),
				newline: text.includes("\n", node.span.end),
			};
		}
	}
	if (merged.length === 0) return;

	const hasCut = (start: number, end: number): boolean => {
		const range = merged[firstAtLeast(merged, start, (range) => range[1] - 1)];
		return range !== undefined && range[0] < end;
	};

	// A text token's value is its source slice, and a text node joins one or more tokens, so nodes are rebuilt token by token.
	const rewrite = (list: Statement[]): void => {
		for (const node of list) {
			if (node.type === "Text" && hasCut(node.span.start, node.span.end)) {
				let value = "";
				for (
					let i = firstAtLeast(textTokens, node.span.start, (t) => t.start);
					i < textTokens.length;
					i++
				) {
					const token = textTokens[i] as (typeof textTokens)[number];
					if (token.end > node.span.end) break;
					value += uncut(token.start, token.end);
				}
				node.value = value;
			}
			const bodies = bodiesOf(node);
			if (bodies.length > 0) {
				for (const child of childLists(bodies)) rewrite(child);
			}
		}
	};
	rewrite(ast.body);
};
