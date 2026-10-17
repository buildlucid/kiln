import { enclosingDelimiter } from "./context.js";

/**
 * The function or filter call whose arguments the cursor is in. Read from the text, because a half-typed call such as
 * `testPages("tags", ` doesn't parse.
 *
 * - `index`: the positional argument the cursor is on, counting from 0.
 * - `named`: the named argument the cursor is in, as in `limit: ‸`, or null.
 * - `sawNamed`: whether a named argument came before the cursor. Named arguments are gathered into the last parameter.
 * - `namePosition`: whether the cursor is where an argument starts, so a name such as `limit:` could go there. `start`
 *   is where the word being typed starts.
 */
export type CallContext = {
	kind: "function" | "filter";
	name: string;
	index: number;
	named: string | null;
	sawNamed: boolean;
	namePosition: boolean;
	start: number;
};

const CLOSERS: Record<string, string> = { "(": ")", "[": "]", "{": "}" };

type Frame = {
	char: string;
	/** For `(`: the function or filter it calls, or null for grouping brackets and method calls. */
	callee: { kind: "function" | "filter"; name: string } | null;
	commas: number;
	/** Where the current argument starts. */
	segment: number;
	sawNamed: boolean;
};

/** Words before `(` that aren't calls, as in `not (a or b)`. */
const KEYWORDS = new Set(["and", "or", "not", "in", "is", "if", "else"]);

const NAMED = /^\s*([A-Za-z_]\w*)\s*:(?!:)/;

export const callContext = (
	text: string,
	offset: number,
): CallContext | null => {
	const delimiter = enclosingDelimiter(text, offset);
	if (!delimiter) return null;
	const stack: Frame[] = [];
	let quote: string | null = null;
	for (let index = delimiter.start + 2; index < offset; index++) {
		const char = text[index] as string;
		if (quote) {
			if (char === "\\") index++;
			else if (char === quote) quote = null;
			continue;
		}
		if (char === '"' || char === "'") quote = char;
		else if (char in CLOSERS) {
			let callee: Frame["callee"] = null;
			if (char === "(") {
				const match = /(\|\s*|\.\s*)?([A-Za-z_]\w*)\s*$/.exec(
					text.slice(delimiter.start + 2, index),
				);
				const name = match?.[2];
				if (name && !KEYWORDS.has(name) && !match[1]?.startsWith(".")) {
					callee = { kind: match[1] ? "filter" : "function", name };
				}
			}
			stack.push({
				char,
				callee,
				commas: 0,
				segment: index + 1,
				sawNamed: false,
			});
		} else if (char === ")" || char === "]" || char === "}") {
			stack.pop();
		} else if (char === ",") {
			const frame = stack.at(-1);
			if (frame) {
				if (NAMED.test(text.slice(frame.segment, index))) frame.sawNamed = true;
				frame.commas++;
				frame.segment = index + 1;
			}
		}
	}
	const frame = stack.at(-1);
	if (frame?.char !== "(" || !frame.callee) return null;
	const segment = text.slice(frame.segment, offset);
	const word = /[A-Za-z_]\w*$/.exec(segment)?.[0] ?? "";
	return {
		...frame.callee,
		index: frame.commas,
		named: NAMED.exec(segment)?.[1] ?? null,
		sawNamed: frame.sawNamed,
		namePosition: /^\s*[A-Za-z_]?\w*$/.test(segment),
		start: offset - word.length,
	};
};

/**
 * Splits a parameter list, such as `a: string, b?: { c: number }`, at its top-level commas. Each part keeps its
 * offsets, so a signature can point at the parameter it's on.
 */
export const splitParameters = (
	list: string,
): { text: string; start: number; end: number }[] => {
	const parts: { text: string; start: number; end: number }[] = [];
	let depth = 0;
	let start = 0;
	const push = (end: number) => {
		const raw = list.slice(start, end);
		const leading = raw.length - raw.trimStart().length;
		const text = raw.trim();
		if (text)
			parts.push({
				text,
				start: start + leading,
				end: start + leading + text.length,
			});
	};
	for (let index = 0; index < list.length; index++) {
		const char = list[index] as string;
		if ("([{<".includes(char)) depth++;
		else if (")]}".includes(char) || (char === ">" && list[index - 1] !== "="))
			depth--;
		else if (char === "," && depth === 0) {
			push(index);
			start = index + 1;
		}
	}
	push(list.length);
	return parts;
};
