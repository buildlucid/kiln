import type { LexResult } from "../lexer/lexer.js";
import type { Statement, TemplateNode } from "./ast.js";

/** The statements inside one tag, with where the tag starts and where its whole span ends. */
type Body = { open: number; end: number; lists: Statement[][] };

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
		case "SetBlock":
		case "Block":
		case "Slot":
		case "Macro":
		case "With":
		case "Apply":
		case "Autoescape":
			return [own([node.body])];
		default:
			return [];
	}
};

/** The statement lists inside a statement, each once. */
const childLists = (bodies: Body[]): Set<Statement[]> =>
	new Set(bodies.flatMap((body) => body.lists));

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
 * Removes the extra indentation inside tags that stand on their own line: the spaces and tabs that every content line inside shares, beyond the tag's own indentation.
 *
 * Amounts come from the source alone, so nested tags each remove their own step whatever order they are visited in. Then the text nodes holding those offsets are rebuilt.
 */
export const removeIndentation = (
	ast: TemplateNode,
	text: string,
	{ tokens, standalone, lines }: LexResult,
): void => {
	// Source ranges to drop, as [start, end).
	const cuts: [number, number][] = [];

	const indentOf = (offset: number): string => {
		const start = text.lastIndexOf("\n", offset - 1) + 1;
		let end = start;
		while (text[end] === " " || text[end] === "\t") end++;
		return text.slice(start, end);
	};

	const trim = (body: Body): void => {
		const openEnd = standalone.get(body.open);
		if (openEnd === undefined) return;
		const newline = text.indexOf("\n", openEnd);
		if (newline === -1) return;
		// Lines from the one after the tag up to the end tag, which starts at the span's last `{%`.
		const to = text.lastIndexOf("{%", body.end - 1);
		const first = firstAtLeast(lines, newline + 1, (line) => line.start);
		const last = firstAtLeast(lines, to, (line) => line.start);
		if (first >= last) return;

		const own = indentOf(body.open);
		let shared = Infinity;
		const firstLine = lines[first] as (typeof lines)[number];
		for (let i = first; i < last; i++) {
			const line = lines[i] as (typeof lines)[number];
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
			const line = lines[i] as (typeof lines)[number];
			cuts.push([line.start + own.length, line.start + shared]);
		}
	};

	const visit = (list: Statement[]): void => {
		for (const node of list) {
			const bodies = bodiesOf(node);
			for (const child of childLists(bodies)) visit(child);
			for (const body of bodies) trim(body);
		}
	};
	visit(ast.body);
	if (cuts.length === 0) return;

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

	const hasCut = (start: number, end: number): boolean => {
		const range = merged[firstAtLeast(merged, start, (range) => range[1] - 1)];
		return range !== undefined && range[0] < end;
	};

	// A text token's value is its source slice, and a text node joins one or more tokens, so nodes are rebuilt token by token.
	const textTokens = tokens.filter((token) => token.type === "text");
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
			for (const child of childLists(bodiesOf(node))) rewrite(child);
		}
	};
	rewrite(ast.body);
};
