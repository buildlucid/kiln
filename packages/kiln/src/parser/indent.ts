import type { LexResult, TextLine } from "../lexer/lexer.js";
import type { PlacedStatement, Statement, TemplateNode } from "./ast.js";

/**
 * The statements inside one tag, with where the tag starts and where its whole span ends. `full` bodies are inserted
 * where another tag stands, so they lose all their shared indentation and take the indentation of where they land.
 */
type Body = {
	open: number;
	end: number;
	lists: Statement[][];
	full: boolean;
	/** Keeps every line's indentation, for content written back inside a wrapper, such as an island's fallback. */
	keep?: boolean;
};

/** The bodies a statement holds. Branches share their tag's body. A component's fills are bodies of their own, inside the component's. */
const bodiesOf = (node: Statement): Body[] => {
	const own = (lists: Statement[][], full = false): Body => ({
		open: node.span.start,
		end: node.span.end,
		lists,
		full,
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
					full: true,
				})),
				own([node.body, ...node.fills.map((fill) => fill.body)], true),
			];
		case "Island":
			return [{ ...own([node.body]), keep: true }];
		case "Block":
		case "Slot":
		case "Add":
			return [own([node.body], true)];
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

/** Where `<pre>` and `<textarea>` elements start and end in the template's text, whose whitespace is content. */
const preformatted = (
	text: string,
	textTokens: LexResult["tokens"],
): [number, number][] => {
	const ranges: [number, number][] = [];
	let open: { name: string; start: number } | null = null;
	// One search of the whole source, keeping matches in text rather than in tags or comments.
	for (const match of text.matchAll(/<(\/?)(pre|textarea)(?=[\s/>])/gi)) {
		const at = match.index;
		const token = textTokens[firstAtLeast(textTokens, at + 1, (t) => t.end)];
		if (token === undefined || token.start > at) continue;
		const name = (match[2] as string).toLowerCase();
		if (open === null && match[1] === "") open = { name, start: at };
		else if (open?.name === name && match[1] === "/") {
			ranges.push([open.start, at]);
			open = null;
		}
	}
	if (open) ranges.push([open.start, text.length]);
	return ranges;
};

/**
 * Works out the indentation of a template's text, so content can be inserted elsewhere and still line up.
 *
 * - Removes the extra indentation inside tags that stand on their own line: the spaces and tabs that every content line inside shares, beyond the tag's own. Blocks, slots and a component's content can be inserted where another tag stands, so they lose all of it and take the indentation of where they land.
 * - Sets `indent` on the tags in `placedNodes`, which insert content, when they stand on their own line: the line's indentation once that removal is done.
 * - Sets `lines` on text nodes: where each line of text starts, to take the indentation of where the text is inserted.
 *
 * Lines inside `<pre>` and `<textarea>` keep their whitespace. Amounts come from the source alone, so nested tags each remove their own step whatever order they are visited in.
 */
export const arrangeIndentation = (
	ast: TemplateNode,
	text: string,
	{ tokens, standalone, lines }: LexResult,
	placedNodes: readonly PlacedStatement[],
): void => {
	const textTokens = tokens.filter((token) => token.type === "text");
	const pre = preformatted(text, textTokens);
	const inPre = (offset: number): boolean => {
		const range = pre[firstAtLeast(pre, offset, (range) => range[1])];
		return range !== undefined && range[0] < offset;
	};
	const textLines =
		pre.length > 0 ? lines.filter((line) => !inPre(line.start)) : lines;

	const lineOf = (offset: number): TextLine => {
		const start = text.lastIndexOf("\n", offset - 1) + 1;
		let indentEnd = start;
		while (text[indentEnd] === " " || text[indentEnd] === "\t") indentEnd++;
		return { start, indentEnd };
	};

	// Standalone tags that insert content count as content lines, so the tags around them remove their step.
	const placed: { node: PlacedStatement; line: TextLine }[] = [];
	// A deferred island writes its end tag back as `</kiln-island>`, so a standalone `endisland` counts as one too.
	const islandEnds: {
		node: Extract<PlacedStatement, { type: "Island" }>;
		line: TextLine;
	}[] = [];
	for (const node of placedNodes) {
		if (node.type === "Island") {
			const end = text.lastIndexOf("{%", node.span.end - 1);
			if (standalone.has(end)) islandEnds.push({ node, line: lineOf(end) });
		}
		if (!standalone.has(node.span.start)) continue;
		placed.push({ node, line: lineOf(node.span.start) });
	}
	const contentLines =
		placed.length > 0 || islandEnds.length > 0
			? [
					...textLines,
					...placed.map((item) => item.line),
					...islandEnds.map((item) => item.line),
				].sort((a, b) => a.start - b.start)
			: textLines;

	// Source ranges to drop, as [start, end).
	const cuts: [number, number][] = [];

	const indentOf = (offset: number): string => {
		const start = text.lastIndexOf("\n", offset - 1) + 1;
		let end = start;
		while (text[end] === " " || text[end] === "\t") end++;
		return text.slice(start, end);
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
		let keep = 0;
		if (!body.full) {
			const own = indentOf(body.open);
			if (shared <= own.length) return;
			if (text.slice(firstLine.start, firstLine.start + own.length) !== own)
				return;
			keep = own.length;
		} else if (shared === 0) return;
		for (let i = first; i < last; i++) {
			const line = contentLines[i] as TextLine;
			cuts.push([line.start + keep, line.start + shared]);
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

	for (const { node, line } of placed) {
		node.indent = uncut(line.start, line.indentEnd);
	}
	for (const { node, line } of islandEnds) {
		const sameLine = line.start === lineOf(node.span.start).start;
		node.closing = {
			indent: sameLine ? null : uncut(line.start, line.indentEnd),
			newline: text.includes("\n", node.span.end),
		};
	}

	const hasCut = (start: number, end: number): boolean => {
		const range = merged[firstAtLeast(merged, start, (range) => range[1] - 1)];
		return range !== undefined && range[0] < end;
	};

	// A text token's value is its source slice, and a text node joins one or more tokens, so nodes are rebuilt token by token.
	const rewrite = (list: Statement[]): void => {
		for (const node of list) {
			if (node.type === "Text") {
				let line = firstAtLeast(textLines, node.span.start, (l) => l.start);
				const hasLines = (textLines[line]?.start ?? Infinity) <= node.span.end;
				const cut = hasCut(node.span.start, node.span.end);
				if (!hasLines && !cut) continue;
				let value = "";
				let size = 0;
				const starts: number[] = [];
				for (
					let i = firstAtLeast(textTokens, node.span.start, (t) => t.start);
					i < textTokens.length;
					i++
				) {
					const token = textTokens[i] as (typeof textTokens)[number];
					if (token.end > node.span.end) break;
					for (
						let next = textLines[line];
						next !== undefined && next.start <= token.end;
						next = textLines[++line]
					) {
						starts.push(
							size +
								(cut
									? uncut(token.start, next.start).length
									: next.start - token.start),
						);
					}
					if (cut) {
						const piece = uncut(token.start, token.end);
						value += piece;
						size += piece.length;
					} else size += token.end - token.start;
				}
				if (cut) node.value = value;
				if (starts.length > 0) node.lines = starts;
			}
			const bodies = bodiesOf(node);
			if (bodies.length > 0) {
				for (const child of childLists(bodies)) rewrite(child);
			}
		}
	};
	rewrite(ast.body);
};
