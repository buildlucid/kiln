import { BLOCK_TAGS } from "./builtins.js";

/**
 * What the text before the cursor is in the middle of, for completions. `start` is where the word being typed starts.
 *
 * - `tag`: a tag's name, just after `{%`. `end` is where an existing `%}` on the line ends, so a snippet can replace it.
 * - `template`: a template name in the string after `extends`, `include`, `component`, `import` or `from`.
 * - `filter`, `test`: a name after `|`, or after `is` or `is not`.
 * - `loop`: a property after `loop.`.
 * - `prop`: a key in the `with { }` hash of an `include` or `component` of `template`.
 * - `expression`: a variable or function name.
 */
export type CursorContext =
	| { kind: "tag"; start: number; end: number | null; open: string | null }
	| { kind: "template"; start: number; prefix: string }
	| { kind: "filter" | "test" | "loop" | "expression"; start: number }
	| { kind: "prop"; start: number; template: string };

/** Where the output or tag around `offset` opens, and its kind. Null outside one, or inside a comment. */
export const enclosingDelimiter = (
	text: string,
	offset: number,
): { start: number; kind: "output" | "tag" } | null => {
	const before = text.slice(0, offset);
	const output = before.lastIndexOf("{{");
	const tag = before.lastIndexOf("{%");
	const comment = before.lastIndexOf("{#");
	if (comment !== -1 && before.indexOf("#}", comment) === -1) return null;
	const start = Math.max(output, tag);
	if (start === -1 || start < comment) return null;
	const kind = start === tag ? "tag" : "output";
	if (before.indexOf(kind === "tag" ? "%}" : "}}", start) !== -1) return null;
	return { start, kind };
};

/** The block tags open at `offset`, innermost last, from the tags before it. */
export const openBlocks = (text: string, offset: number): string[] => {
	const stack: string[] = [];
	const tags = /\{%-?\s*(\w+)([^%]*)%\}/g;
	for (const match of text.slice(0, offset).matchAll(tags)) {
		const name = match[1] as string;
		const rest = match[2] as string;
		if (BLOCK_TAGS.has(name)) {
			if (name === "set" && rest.includes("=")) continue;
			if (name === "block" && rest.trim().includes(" ")) continue;
			stack.push(name);
		} else if (name.startsWith("end")) {
			const index = stack.lastIndexOf(name.slice(3));
			if (index !== -1) stack.length = index;
		}
	}
	return stack;
};

const WORD_END = /[A-Za-z_][A-Za-z0-9_]*$/;

export const cursorContext = (
	text: string,
	offset: number,
): CursorContext | null => {
	const delimiter = enclosingDelimiter(text, offset);
	if (!delimiter) return null;
	const inner = text.slice(delimiter.start + 2, offset).replace(/^-/, "");
	const word = WORD_END.exec(inner)?.[0] ?? "";
	const start = offset - word.length;
	const head = inner.slice(0, inner.length - word.length);

	if (delimiter.kind === "tag" && /^\s*$/.test(head)) {
		const after = /^\w*(\s*-?%\})/.exec(
			text.slice(offset).split("\n")[0] ?? "",
		);
		const blocks = openBlocks(text, delimiter.start);
		return {
			kind: "tag",
			start,
			end: after ? offset + (after[0] as string).length : null,
			open: blocks.at(-1) ?? null,
		};
	}

	const template =
		/\b(?:extends|include|component|import|from)\s+(["'])([^"']*)$/.exec(inner);
	if (template) {
		const prefix = template[2] as string;
		return { kind: "template", start: offset - prefix.length, prefix };
	}
	if (/\bloop\.$/.test(head)) return { kind: "loop", start };
	if (/(?:^|[^|])\|\s*$/.test(head)) return { kind: "filter", start };
	if (/\bis\s+(?:not\s+)?$/.test(head)) return { kind: "test", start };

	const props =
		/\b(?:include|component)\s+(["'])([^"']+)\1\s+with\s+\{([^{}]*)$/.exec(
			head,
		);
	if (props && /(?:^|,)\s*$/.test(props[3] as string)) {
		return { kind: "prop", start, template: props[2] as string };
	}
	if (/[.\w]$/.test(head) || /["']$/.test(head)) return null;
	return { kind: "expression", start };
};

/** The name under the cursor, and what it names, for hover and go to definition. */
export type CursorSymbol = {
	kind: "filter" | "test" | "function" | "loop" | "variable" | "template";
	name: string;
	start: number;
	end: number;
};

/** Every template name written as a string after `extends`, `include`, `component`, `import` or `from`, with the name's offsets. */
export const templateStrings = (
	text: string,
): { name: string; start: number; end: number }[] => {
	const found: { name: string; start: number; end: number }[] = [];
	const pattern =
		/\{%-?\s*(?:extends|include|component|import|from)\s+(["'])([^"'\n]*)\1/g;
	for (const match of text.matchAll(pattern)) {
		const name = match[2] as string;
		const end = (match.index as number) + match[0].length - 1;
		found.push({ name, start: end - name.length, end });
	}
	return found;
};

export const symbolAt = (text: string, offset: number): CursorSymbol | null => {
	const string = templateStrings(text).find(
		(found) => offset >= found.start && offset <= found.end,
	);
	if (string) return { kind: "template", ...string };

	const delimiter = enclosingDelimiter(text, offset);
	if (!delimiter) return null;
	let start = offset;
	let end = offset;
	while (start > 0 && /\w/.test(text[start - 1] as string)) start--;
	while (end < text.length && /\w/.test(text[end] as string)) end++;
	if (start === end || !/^[A-Za-z_]/.test(text.slice(start))) return null;
	let name = text.slice(start, end);
	const head = text.slice(delimiter.start + 2, start);
	const tail = text.slice(end, end + 40);

	if (/\|\s*$/.test(head)) return { kind: "filter", name, start, end };
	if (/\bis\s+(?:not\s+)?$/.test(head)) {
		if (name === "divisible" && /^\s+by\b/.test(tail)) name = "divisible by";
		return { kind: "test", name, start, end };
	}
	if (name === "by" && /\bis\s+(?:not\s+)?divisible\s+$/.test(head)) {
		return { kind: "test", name: "divisible by", start, end };
	}
	if (/\bloop\.$/.test(head)) return { kind: "loop", name, start, end };
	if (/[.\w]$/.test(head)) return null;
	if (/^\s*\(/.test(tail)) return { kind: "function", name, start, end };
	return { kind: "variable", name, start, end };
};
