import { builtinTests } from "../builtins/functions.js";
import { KilnSyntaxError } from "../errors.js";
import { createDiagnostic } from "../errors.js";
import { type DelimitedPart, type Part, scanParts } from "../lexer/lexer.js";
import { parse } from "../parser/parser.js";
import { Source } from "../source.js";
import { printDelimiter } from "./delimiters.js";

export type FormatOptions = {
	/** Indent with tabs. Default `true`. */
	useTabs?: boolean;
	/** Spaces per step without tabs, and the width of a tab when moving lines. Default `4`. */
	tabWidth?: number;
	/** Only format lines that overlap this range of offsets. */
	range?: { start: number; end: number };
};

/** Replace `start` to `end` of the original source with `text`. */
export type FormatEdit = { start: number; end: number; text: string };

/** Thrown when formatting would have changed what a template renders. That is a bug in the formatter. */
export class KilnFormatError extends Error {
	override name = "KilnFormatError";
}

/**
 * How the formatter treats one line.
 *
 * - `indent`: set its indentation to `level` steps.
 * - `shift`: move it by as much as line `anchor` moved, keeping its own indentation relative to it. For scripts, styles and comments.
 * - `keep`: leave it alone, for `<pre>`, `<textarea>`, `verbatim` and text inside attribute values.
 * - `inside`: it starts inside an output or tag, which `printDelimiter` indents.
 */
type Line =
	| { kind: "indent"; start: number; level: number }
	| { kind: "shift"; start: number; anchor: number }
	| { kind: "keep" | "inside"; start: number };

type Frame = { kind: "kiln" | "html"; name: string };

/**
 * Where the scanner is in the HTML.
 *
 * - `tag`: inside `<name ...>` or `</name>`, which started on line `line`. `inner` counts block tags open inside it.
 * - `raw`: inside `<script>` or `<style>`, or kept as written inside `<pre>` and `<textarea>`.
 */
type Mode =
	| { kind: "data" }
	| {
			kind: "tag";
			name: string;
			closing: boolean;
			quote: string | null;
			line: number;
			atLineStart: boolean;
			inner: number;
	  }
	| { kind: "comment"; anchor: number; level: number }
	| { kind: "raw"; name: string; keep: boolean; anchor: number; level: number }
	| { kind: "verbatim"; level: number };

const VOID_ELEMENTS = new Set([
	"area",
	"base",
	"br",
	"col",
	"embed",
	"hr",
	"img",
	"input",
	"link",
	"meta",
	"source",
	"track",
	"wbr",
]);

/** Elements written in `<script>` or `<style>`'s own language, whose lines move together. */
const RAW_ELEMENTS = new Set(["script", "style"]);
/** Elements whose whitespace shows on the page. */
const KEPT_ELEMENTS = new Set(["pre", "textarea"]);

/** Elements that the next of these siblings closes, such as a `<li>` without `</li>`. */
const CLOSED_BY: Record<string, readonly string[]> = {
	li: ["li"],
	dt: ["dt", "dd"],
	dd: ["dt", "dd"],
	p: ["p"],
	option: ["option"],
	tr: ["tr"],
	td: ["td", "th"],
	th: ["td", "th"],
	thead: ["tbody", "tfoot"],
	tbody: ["tbody", "tfoot"],
};

/** Block tags that hold a body, and so indent what follows. */
const BLOCK_TAGS = new Set([
	"if",
	"for",
	"set",
	"block",
	"component",
	"fill",
	"slot",
	"macro",
	"with",
	"cache",
	"add",
	"apply",
	"autoescape",
	"verbatim",
]);

/** What a tag does to indentation: opens a body, starts another branch of one, closes one, or nothing. */
const roleOf = (
	part: DelimitedPart,
): { kind: "open" | "close"; name: string } | { kind: "branch" } | null => {
	const name = part.tokens[1];
	if (name?.type !== "name") return null;
	if (BLOCK_TAGS.has(name.value)) {
		if (
			name.value === "set" &&
			part.tokens.some((token) => token.type === "punct" && token.value === "=")
		) {
			return null;
		}
		// `{% block title page.title %}` is the short form, with no body.
		if (name.value === "block" && part.tokens.length > 4) return null;
		return { kind: "open", name: name.value };
	}
	if (name.value === "else" || name.value === "elseif")
		return { kind: "branch" };
	if (name.value.startsWith("end")) {
		return { kind: "close", name: name.value.slice(3) };
	}
	return null;
};

const isLetter = (char: string | undefined) =>
	char !== undefined && /[A-Za-z]/.test(char);

const isTest = (name: string) => Object.hasOwn(builtinTests, name);

/** The start offset of every line. */
const lineStarts = (text: string): number[] => {
	const starts = [0];
	for (let index = text.indexOf("\n"); index !== -1;) {
		starts.push(index + 1);
		index = text.indexOf("\n", index + 1);
	}
	return starts;
};

/**
 * Walks the template once, tracking open block tags and HTML elements, and decides how to treat each line.
 *
 * Returns the lines, which lines may lose trailing whitespace, and the outputs and tags to print.
 */
const planLines = (text: string, parts: readonly Part[]) => {
	const starts = lineStarts(text);
	const lines: Line[] = [];
	const trimEnd: boolean[] = [];
	const stack: Frame[] = [];
	let mode: Mode = { kind: "data" };
	let atLineStart = true;
	// A line that starts where the next part does, recorded when that part begins.
	let pendingLine = -1;

	const lineText = (index: number) =>
		text.slice(starts[index], starts[index + 1] ?? text.length);
	const current = () => lines.length - 1;

	/** Lowers the current line's level when a closing tag comes before anything else on it. */
	const outdent = (line: number, level: number, first: boolean) => {
		const info = lines[line];
		if (first && info?.kind === "indent") {
			info.level = Math.min(info.level, level);
		}
	};

	const levelOf = (line: number): number => {
		const info = lines[line];
		return info?.kind === "indent" ? info.level : stack.length;
	};

	/** Records how to treat the line that starts at `start`, from the current state. */
	const beginLine = (start: number) => {
		const index = lines.length;
		const trimmed = lineText(index).trimStart();
		atLineStart = true;
		switch (mode.kind) {
			case "data":
				lines.push({ kind: "indent", start, level: stack.length });
				return;
			case "tag": {
				if (mode.quote !== null) {
					lines.push({ kind: "keep", start });
					return;
				}
				const base = levelOf(mode.line);
				const level =
					trimmed.startsWith(">") || trimmed.startsWith("/>")
						? base
						: base + 1 + mode.inner;
				lines.push({ kind: "indent", start, level });
				return;
			}
			case "comment":
				lines.push(
					trimmed.startsWith("-->")
						? { kind: "indent", start, level: mode.level }
						: { kind: "shift", start, anchor: mode.anchor },
				);
				return;
			case "raw":
				if (mode.keep) lines.push({ kind: "keep", start });
				else if (trimmed.toLowerCase().startsWith(`</${mode.name}`)) {
					lines.push({ kind: "indent", start, level: mode.level });
				} else lines.push({ kind: "shift", start, anchor: mode.anchor });
				return;
			case "verbatim":
				// Kiln drops the `endverbatim` line, but the text before it is output as written.
				lines.push(
					/^\{%-?\s*endverbatim\b/.test(trimmed)
						? { kind: "indent", start, level: mode.level }
						: { kind: "keep", start },
				);
		}
	};

	/** Whether trailing whitespace on a line ending here can go. Not inside attribute values or kept elements. */
	const canTrimHere = () =>
		!(mode.kind === "tag" && mode.quote !== null) &&
		!(mode.kind === "raw" && mode.keep) &&
		mode.kind !== "verbatim";

	const finishTag = (
		tag: Extract<Mode, { kind: "tag" }>,
		selfClosing: boolean,
	) => {
		mode = { kind: "data" };
		const name = tag.name;
		if (tag.closing) {
			// Close the nearest open element of this name, without crossing a block tag.
			for (let index = stack.length - 1; index >= 0; index--) {
				const frame = stack[index] as Frame;
				if (frame.kind === "kiln") break;
				if (frame.name === name) {
					stack.length = index;
					outdent(tag.line, index, tag.atLineStart);
					break;
				}
			}
			return;
		}
		if (name.startsWith("!") || selfClosing || VOID_ELEMENTS.has(name)) return;
		if (RAW_ELEMENTS.has(name) || KEPT_ELEMENTS.has(name)) {
			mode = {
				kind: "raw",
				name,
				keep: KEPT_ELEMENTS.has(name),
				anchor: tag.line,
				level: stack.length,
			};
			return;
		}
		const top = stack[stack.length - 1];
		if (top?.kind === "html" && CLOSED_BY[top.name]?.includes(name)) {
			stack.pop();
			outdent(tag.line, stack.length, tag.atLineStart);
		}
		stack.push({ kind: "html", name });
	};

	/** Starts a tag at `index` if one starts there, and returns where scanning continues. */
	const startTag = (index: number, closing: boolean): number => {
		const nameStart = index + (closing ? 2 : 1);
		let nameEnd = nameStart;
		while (
			nameEnd < text.length &&
			/[A-Za-z0-9:!_-]/.test(text[nameEnd] as string)
		) {
			nameEnd++;
		}
		mode = {
			kind: "tag",
			name: text.slice(nameStart, nameEnd).toLowerCase(),
			closing,
			quote: null,
			line: current(),
			atLineStart,
			inner: 0,
		};
		atLineStart = false;
		return nameEnd;
	};

	/** Moves through a text part one character at a time. */
	const scanText = (start: number, end: number) => {
		for (let index = start; index < end; index++) {
			const char = text[index] as string;
			if (char === "\n") {
				trimEnd[current()] = canTrimHere();
				if (index + 1 < end) beginLine(index + 1);
				else if (index + 1 === text.length) {
					// The file ends with a line break: there is no further line.
				} else pendingLine = index + 1;
				continue;
			}
			switch (mode.kind) {
				case "data":
					if (char === " " || char === "\t" || char === "\r") break;
					if (char === "<") {
						if (text.startsWith("<!--", index)) {
							mode = {
								kind: "comment",
								anchor: current(),
								level: levelOf(current()),
							};
							atLineStart = false;
							index += 3;
						} else if (text[index + 1] === "/" && isLetter(text[index + 2])) {
							index = startTag(index, true) - 1;
						} else if (isLetter(text[index + 1]) || text[index + 1] === "!") {
							index = startTag(index, false) - 1;
						} else atLineStart = false;
					} else atLineStart = false;
					break;
				case "tag":
					if (mode.quote !== null) {
						if (char === mode.quote) mode.quote = null;
					} else if (char === '"' || char === "'") mode.quote = char;
					else if (char === ">") finishTag(mode, text[index - 1] === "/");
					else if (char !== " " && char !== "\t" && char !== "\r") {
						atLineStart = false;
					}
					break;
				case "comment":
					if (text.startsWith("-->", index)) {
						mode = { kind: "data" };
						index += 2;
					}
					break;
				case "raw":
					if (
						char === "<" &&
						text.slice(index, index + 2 + mode.name.length).toLowerCase() ===
							`</${mode.name}`
					) {
						index = startTag(index, true) - 1;
					}
					break;
				case "verbatim":
					break;
			}
		}
	};

	/** Applies a block tag to the stack, or to the count of block tags open inside an HTML tag. */
	const applyTag = (part: DelimitedPart) => {
		const role = roleOf(part);
		const first = atLineStart;
		atLineStart = false;
		if (!role) return;
		if (mode.kind === "tag") {
			const base = levelOf(mode.line) + 1;
			if (role.kind === "open") mode.inner++;
			else if (role.kind === "close") {
				mode.inner = Math.max(0, mode.inner - 1);
				outdent(current(), base + mode.inner, first);
			} else outdent(current(), base + mode.inner - 1, first);
			return;
		}
		if (mode.kind === "verbatim") {
			if (role.kind === "close" && role.name === "verbatim") {
				const index = stack.findLastIndex((frame) => frame.kind === "kiln");
				if (index !== -1) stack.length = index;
				mode = { kind: "data" };
			}
			return;
		}
		if (mode.kind !== "data") return;
		if (role.kind === "open") {
			stack.push({ kind: "kiln", name: role.name });
			if (role.name === "verbatim") {
				mode = { kind: "verbatim", level: stack.length - 1 };
			}
			return;
		}
		const index =
			role.kind === "branch"
				? stack.findLastIndex((frame) => frame.kind === "kiln")
				: stack.findLastIndex(
						(frame) => frame.kind === "kiln" && frame.name === role.name,
					);
		if (index === -1) return;
		// Elements opened in this body or branch end with it.
		stack.length = role.kind === "branch" ? index + 1 : index;
		outdent(current(), index, first);
	};

	beginLine(0);
	const delimiters: { part: DelimitedPart; line: number }[] = [];

	for (const part of parts) {
		if (pendingLine !== -1) {
			beginLine(pendingLine);
			pendingLine = -1;
		}
		if (part.kind === "text") {
			scanText(part.start, part.end);
			continue;
		}
		const line = current();
		if (part.kind === "comment") atLineStart = false;
		else {
			delimiters.push({ part, line });
			if (part.kind === "tag") applyTag(part);
			else atLineStart = false;
		}
		// Lines that start inside this delimiter.
		for (
			let index = text.indexOf("\n", part.start);
			index !== -1 && index < part.end;
			index = text.indexOf("\n", index + 1)
		) {
			trimEnd[current()] = part.kind === "comment";
			lines.push(
				part.kind === "comment"
					? { kind: "shift", start: index + 1, anchor: line }
					: { kind: "inside", start: index + 1 },
			);
		}
	}
	trimEnd[current()] ??= canTrimHere();
	return { lines, trimEnd, delimiters };
};

const widthOf = (whitespace: string, tabWidth: number): number => {
	let width = 0;
	for (const char of whitespace) width += char === "\t" ? tabWidth : 1;
	return width;
};

/**
 * Works out the edits that format a template, without checking them. See `formatEdits`.
 */
const planEdits = (
	text: string,
	parts: readonly Part[],
	options: Required<Omit<FormatOptions, "range">>,
): FormatEdit[] => {
	const { useTabs, tabWidth } = options;
	const unit = useTabs ? "\t" : " ".repeat(tabWidth);
	const indentOfWidth = (width: number) =>
		useTabs
			? "\t".repeat(Math.floor(width / tabWidth)) + " ".repeat(width % tabWidth)
			: " ".repeat(width);
	const { lines, trimEnd, delimiters } = planLines(text, parts);

	const oldIndent = (line: number) => {
		const start = lines[line]?.start ?? 0;
		return /^[ \t]*/.exec(text.slice(start, start + 200))?.[0] ?? "";
	};
	const newIndents = new Map<number, string | null>();
	const newIndent = (line: number): string | null => {
		if (newIndents.has(line)) return newIndents.get(line) ?? null;
		const info = lines[line];
		let indent: string | null = null;
		if (info?.kind === "indent") indent = unit.repeat(info.level);
		else if (info?.kind === "shift") {
			const anchor = newIndent(info.anchor);
			const moved =
				anchor === null
					? 0
					: widthOf(anchor, tabWidth) -
						widthOf(oldIndent(info.anchor), tabWidth);
			indent = indentOfWidth(
				Math.max(0, widthOf(oldIndent(line), tabWidth) + moved),
			);
		}
		newIndents.set(line, indent);
		return indent;
	};

	const edits: FormatEdit[] = [];
	/** Where a line's content ends: at its line break, or the end of the file. */
	const lineEnd = (line: number) => {
		const next = lines[line + 1]?.start;
		if (next !== undefined) return next - 1;
		return text.endsWith("\n") ? text.length - 1 : text.length;
	};
	const isBlank = (line: number) => {
		const info = lines[line] as Line;
		return (
			info.kind !== "keep" &&
			info.kind !== "inside" &&
			text.slice(info.start, lineEnd(line)).trim() === ""
		);
	};

	let lastContent = lines.length - 1;
	while (lastContent >= 0 && isBlank(lastContent)) lastContent--;
	// Blank lines go where the line before is blank too, so runs become one and leading blank lines go.
	let previousBlank = true;

	for (const [index, info] of lines.entries()) {
		if (index > lastContent) break;
		const start = info.start;
		const end = lineEnd(index);
		if (isBlank(index)) {
			if (info.kind === "indent" && previousBlank) {
				edits.push({ start, end: end + 1, text: "" });
			} else if (end > start) edits.push({ start, end, text: "" });
			previousBlank = true;
			continue;
		}
		previousBlank = false;

		const indent = newIndent(index);
		if (indent !== null) {
			const current = oldIndent(index);
			if (current !== indent) {
				edits.push({ start, end: start + current.length, text: indent });
			}
		}
		if (trimEnd[index] && info.kind !== "keep") {
			let from = end;
			while (from > start && /[ \t\r]/.test(text[from - 1] as string)) from--;
			if (from < end && !insideDelimiter(delimiters, from)) {
				edits.push({ start: from, end, text: "" });
			}
		}
	}

	// The file ends with exactly one line break, or is empty.
	const tail = lastContent < 0 ? 0 : lineEnd(lastContent);
	const ending = lastContent < 0 ? "" : "\n";
	if (text.slice(tail) !== ending) {
		edits.push({ start: tail, end: text.length, text: ending });
	}

	for (const { part, line } of delimiters) {
		const indent = newIndent(line) ?? oldIndent(line);
		const printed = printDelimiter(text, part, indent, unit);
		if (printed !== null && printed !== text.slice(part.start, part.end)) {
			edits.push({ start: part.start, end: part.end, text: printed });
		}
	}

	return edits.sort((a, b) => a.start - b.start || a.end - b.end);
};

const insideDelimiter = (
	delimiters: readonly { part: DelimitedPart }[],
	offset: number,
) => delimiters.some(({ part }) => offset > part.start && offset < part.end);

const applyEdits = (text: string, edits: readonly FormatEdit[]): string => {
	let out = "";
	let position = 0;
	for (const edit of edits) {
		out += text.slice(position, edit.start) + edit.text;
		position = edit.end;
	}
	return out + text.slice(position);
};

/** Removes whitespace at the start and end of lines, and blank lines, which the formatter may change. */
const normaliseText = (value: string) =>
	value
		.replace(/[ \t\r\f\v]+$/gm, "")
		.replace(/^[ \t\f\v]+/gm, "")
		.replace(/\n{2,}/g, "\n")
		.replace(/^\n|\n$/g, "");

/** A copy of a syntax tree without positions or layout, with text normalised and text left empty by that removed. */
const normaliseTree = (value: unknown): unknown => {
	if (Array.isArray(value)) {
		return value
			.map(normaliseTree)
			.filter(
				(item) =>
					!(
						typeof item === "object" &&
						item !== null &&
						(item as { type?: unknown }).type === "Text" &&
						(item as { value?: unknown }).value === ""
					),
			);
	}
	if (typeof value !== "object" || value === null) return value;
	const copy: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) {
		if (
			key === "span" ||
			key === "nameSpan" ||
			key === "lines" ||
			key === "indent"
		)
			continue;
		copy[key] =
			key === "value" && (value as { type?: unknown }).type === "Text"
				? normaliseText(item as string)
				: normaliseTree(item);
	}
	return copy;
};

/** The syntax tree as JSON, without the whitespace the formatter may change, so two trees can be compared. */
const shape = (text: string): string =>
	JSON.stringify(normaliseTree(parse(text, { isTest }).ast));

/**
 * Works out the edits that format a template, in source order and never overlapping. Editors apply these so the cursor and undo history stay put. See `format` for what it throws.
 */
export const formatEdits = (
	text: string,
	options: FormatOptions = {},
): FormatEdit[] => {
	const parsed = parse(text, { isTest });
	if (parsed.problems.length > 0) {
		const source = new Source("template.kiln", text);
		throw new KilnSyntaxError(
			parsed.problems.map((problem) =>
				createDiagnostic(source, problem.code, problem.message, problem.span),
			),
			source,
		);
	}

	let edits = planEdits(text, scanParts(text).parts, {
		useTabs: options.useTabs ?? true,
		tabWidth: options.tabWidth ?? 4,
	});
	const range = options.range;
	if (range) {
		edits = edits.filter(
			(edit) => edit.end >= range.start && edit.start <= range.end,
		);
	}

	const formatted = applyEdits(text, edits);
	const changed = parse(formatted, { isTest });
	if (changed.problems.length > 0 || shape(formatted) !== shape(text)) {
		throw new KilnFormatError(
			"Formatting would have changed what this template renders, so nothing was changed. This is a bug in Kiln's formatter.",
		);
	}
	return edits;
};

/**
 * Formats a template: indents it to match its structure, and tidies spacing inside outputs and tags. Never changes what it renders.
 *
 * Throws `KilnSyntaxError` when the template has syntax errors, and `KilnFormatError` if the safety check fails.
 *
 * ```ts
 * const formatted = format(source, { useTabs: false, tabWidth: 2 });
 * ```
 */
export const format = (text: string, options: FormatOptions = {}): string =>
	applyEdits(text, formatEdits(text, options));
