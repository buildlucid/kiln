import type { Span } from "../source.js";

export type TokenType =
	| "text"
	| "outputOpen"
	| "outputClose"
	| "tagOpen"
	| "tagClose"
	| "name"
	| "number"
	| "string"
	| "punct"
	| "stringStart"
	| "stringEnd"
	| "interpOpen"
	| "interpClose"
	| "eof";

/**
 * One token. `value` is the decoded string for `string` and `text`, the digits without `_` for `number`, and the raw text otherwise.
 */
export type Token = {
	type: TokenType;
	value: string;
	start: number;
	end: number;
};

export type LexProblem = { code: string; message: string; span: Span };

export type LexResult = {
	tokens: Token[];
	problems: LexProblem[];
	/** Tags and comments on lines that hold nothing else, which the lexer removed, as start offset to end offset. */
	standalone: Map<number, number>;
	/** Lines of template text that hold content, in source order. See `TextLine`. */
	lines: TextLine[];
};

/**
 * A line of template text that holds content, from its start to the end of its spaces and tabs. Leaves out blank lines, lines the lexer removed, lines whose start a `-` marker trimmed, and lines inside tags, outputs and comments.
 */
export type TextLine = { start: number; indentEnd: number };

export type TextPart = {
	kind: "text";
	start: number;
	end: number;
	/** Output range after whitespace control. Starts equal to `start` and `end`. */
	from: number;
	to: number;
};

export type DelimitedPart = {
	kind: "output" | "tag" | "comment";
	start: number;
	end: number;
	trimBefore: boolean;
	trimAfter: boolean;
	tokens: Token[];
};

export type Part = TextPart | DelimitedPart;

type ExpressionMode = "output" | "tag" | "interp";

/** Deepest nesting of tags, expressions and string interpolations the lexer and parser accept. */
export const MAX_NESTING = 200;

// Longest first, so `...` wins over `..` and `.`.
const PUNCTUATORS = [
	"...",
	"?.",
	"??",
	"?:",
	"**",
	"//",
	"==",
	"!=",
	"<=",
	">=",
	"=>",
	"..",
	"+",
	"-",
	"*",
	"/",
	"%",
	"~",
	"<",
	">",
	"=",
	"(",
	")",
	"[",
	"]",
	"{",
	"}",
	",",
	":",
	".",
	"|",
	"?",
];

/** Punctuators by their first character's code, longest first as in `PUNCTUATORS`, so lexing tries only a few. */
const PUNCTUATORS_BY_CHARACTER = new Map<number, string[]>();
for (const punct of PUNCTUATORS) {
	const code = punct.charCodeAt(0);
	const list = PUNCTUATORS_BY_CHARACTER.get(code);
	if (list) list.push(punct);
	else PUNCTUATORS_BY_CHARACTER.set(code, [punct]);
}

/**
 * The punctuator at `pos`, whose first two character codes are `code` and `next`, or null. Longest first, so `...` wins
 * over `..` and `.`, as in `PUNCTUATORS`.
 */
const punctuatorAt = (
	text: string,
	pos: number,
	code: number,
	next: number,
): string | null => {
	switch (code) {
		case 46: // .
			if (next === 46) return text.charCodeAt(pos + 2) === 46 ? "..." : "..";
			return ".";
		case 63: // ?
			return next === 46 ? "?." : next === 63 ? "??" : next === 58 ? "?:" : "?";
		case 42: // *
			return next === 42 ? "**" : "*";
		case 47: // /
			return next === 47 ? "//" : "/";
		case 61: // =
			return next === 61 ? "==" : next === 62 ? "=>" : "=";
		case 33: // !
			return next === 61 ? "!=" : null;
		case 60: // <
			return next === 61 ? "<=" : "<";
		case 62: // >
			return next === 61 ? ">=" : ">";
		default: {
			const single = SINGLE_PUNCTUATORS[code];
			return single === undefined ? null : single;
		}
	}
};

/** Punctuators of one character that start no longer one, by character code. */
const SINGLE_PUNCTUATORS: (string | undefined)[] = [];
for (const punct of PUNCTUATORS) {
	const code = punct.charCodeAt(0);
	if ((PUNCTUATORS_BY_CHARACTER.get(code) as string[]).length === 1) {
		SINGLE_PUNCTUATORS[code] = punct;
	}
}

const CLOSED = { closed: true, trim: false } as const;
const CLOSED_TRIM = { closed: true, trim: true } as const;
const NOT_CLOSED = { closed: false, trim: false } as const;

const ESCAPES: Record<string, string> = {
	n: "\n",
	r: "\r",
	t: "\t",
	"\\": "\\",
	"'": "'",
	'"': '"',
};

const VERBATIM_END = /\{%(-?)\s*endverbatim\s*(-?)%\}/g;

const isInlineSpace = (code: number) =>
	code === 32 || code === 9 || code === 13 || code === 11 || code === 12;
const isSpace = (code: number) => code === 10 || isInlineSpace(code);
const isNameStart = (code: number) =>
	(code >= 97 && code <= 122) || (code >= 65 && code <= 90) || code === 95;
const isDigit = (code: number) => code >= 48 && code <= 57;
const isNamePart = (code: number) => isNameStart(code) || isDigit(code);

/**
 * Turns template source into tokens in one pass, then applies whitespace control.
 *
 * Text outside delimiters becomes `text` tokens. Comments produce no tokens. Lines holding only block tags and comments are removed, and `-` markers trim neighbouring whitespace.
 */
export const lex = (text: string): LexResult => new Lexer(text).run();

/**
 * Splits source into text, outputs, tags and comments as written, before whitespace control. Tools such as the formatter use it. Comments have no tokens.
 */
export const scanParts = (
	text: string,
): { parts: Part[]; problems: LexProblem[] } => new Lexer(text).scan();

/** Where a template's content starts: after a byte order mark, which is never content. */
export const contentStart = (text: string): number =>
	text.charCodeAt(0) === 0xfeff ? 1 : 0;

class Lexer {
	readonly #text: string;
	#pos: number;
	/** How many string interpolations the lexer is inside. */
	#interpolations = 0;
	#tokens: Token[] = [];
	readonly #problems: LexProblem[] = [];

	constructor(text: string) {
		this.#text = text;
		this.#pos = contentStart(text);
	}

	scan(): { parts: Part[]; problems: LexProblem[] } {
		return { parts: this.#scanParts(), problems: this.#problems };
	}

	run(): LexResult {
		const parts = this.#scanParts();
		applyTrimMarkers(this.#text, parts);
		const standalone = applyStandaloneLines(this.#text, parts);
		const lines = textLines(this.#text, parts, standalone);

		const tokens: Token[] = [];
		// A line that starts with a tag or output still gets a text token, empty, to mark where the line starts.
		let line = 0;
		for (const part of parts) {
			const text = part.kind === "text";
			const at = text ? part.from : part.start;
			if (text && part.from < part.to) {
				tokens.push({
					type: "text",
					value: this.#text.slice(part.from, part.to),
					start: part.from,
					end: part.to,
				});
			} else if (lines[line]?.start === at) {
				tokens.push({ type: "text", value: "", start: at, end: at });
			}
			if (!text && part.kind !== "comment") {
				for (const token of part.tokens) tokens.push(token);
			}
			const end = text ? part.to : part.start;
			while ((lines[line]?.start ?? Infinity) <= end) line++;
		}
		tokens.push({
			type: "eof",
			value: "",
			start: this.#text.length,
			end: this.#text.length,
		});
		return { tokens, problems: this.#problems, standalone, lines };
	}

	#scanParts(): Part[] {
		const text = this.#text;
		const parts: Part[] = [];
		const pushText = (start: number, end: number) => {
			if (end > start) {
				parts.push({ kind: "text", start, end, from: start, to: end });
			}
		};

		while (this.#pos < text.length) {
			const open = this.#findOpen(this.#pos);
			if (open === -1) {
				pushText(this.#pos, text.length);
				break;
			}
			pushText(this.#pos, open);

			const kind = text[open + 1];
			if (kind === "#") {
				parts.push(this.#scanComment(open));
				continue;
			}

			const part = this.#scanDelimited(open, kind === "{" ? "output" : "tag");
			parts.push(part);

			const inner = part.tokens;
			if (
				part.kind === "tag" &&
				inner.length === 3 &&
				inner[1]?.type === "name" &&
				inner[1].value === "verbatim"
			) {
				this.#scanVerbatim(part, parts);
			}
		}
		return parts;
	}

	#findOpen(from: number): number {
		const text = this.#text;
		let index = text.indexOf("{", from);
		while (index !== -1) {
			const next = text.charCodeAt(index + 1);
			// {{ {% {#
			if (next === 123 || next === 37 || next === 35) return index;
			index = text.indexOf("{", index + 1);
		}
		return -1;
	}

	#scanComment(open: number): DelimitedPart {
		const text = this.#text;
		const close = text.indexOf("#}", open + 2);
		const trimBefore = text[open + 2] === "-";
		if (close === -1) {
			this.#problem(
				"unclosed-comment",
				'Comment is missing its closing "#}"',
				open,
				open + 2,
			);
			this.#pos = text.length;
			return {
				kind: "comment",
				start: open,
				end: text.length,
				trimBefore,
				trimAfter: false,
				tokens: [],
			};
		}
		this.#pos = close + 2;
		return {
			kind: "comment",
			start: open,
			end: close + 2,
			trimBefore,
			trimAfter: close > open + 2 && text[close - 1] === "-",
			tokens: [],
		};
	}

	#scanDelimited(open: number, kind: "output" | "tag"): DelimitedPart {
		const text = this.#text;
		const trimBefore = text[open + 2] === "-";
		this.#tokens = [
			{
				type: kind === "output" ? "outputOpen" : "tagOpen",
				value: text.slice(open, open + (trimBefore ? 3 : 2)),
				start: open,
				end: open + 2,
			},
		];
		this.#pos = open + (trimBefore ? 3 : 2);

		const closeStart = this.#pos;
		const { trim, closed } = this.#lexExpression(kind);
		const end = this.#pos;
		if (!closed) {
			this.#problem(
				"unclosed-tag",
				kind === "output"
					? 'Output is missing its closing "}}"'
					: 'Tag is missing its closing "%}"',
				open,
				open + 2,
			);
		}
		this.#tokens.push({
			type: kind === "output" ? "outputClose" : "tagClose",
			value: closed ? text.slice(trim ? end - 3 : end - 2, end) : "",
			start: closed ? end - 2 : Math.max(closeStart, end),
			end,
		});
		return {
			kind,
			start: open,
			end,
			trimBefore,
			trimAfter: trim,
			tokens: this.#tokens,
		};
	}

	/** Treats everything up to `{% endverbatim %}` as text. */
	#scanVerbatim(tag: DelimitedPart, parts: Part[]): void {
		const text = this.#text;
		VERBATIM_END.lastIndex = this.#pos;
		const match = VERBATIM_END.exec(text);
		if (!match) {
			this.#problem(
				"unclosed-block",
				'"verbatim" is missing its "endverbatim" tag',
				tag.start,
				tag.end,
			);
			parts.push({
				kind: "text",
				start: this.#pos,
				end: text.length,
				from: this.#pos,
				to: text.length,
			});
			this.#pos = text.length;
			return;
		}

		const start = match.index;
		const end = start + match[0].length;
		if (start > this.#pos) {
			parts.push({
				kind: "text",
				start: this.#pos,
				end: start,
				from: this.#pos,
				to: start,
			});
		}
		const nameStart = text.indexOf("endverbatim", start);
		const trimBefore = match[1] === "-";
		const trimAfter = match[2] === "-";
		parts.push({
			kind: "tag",
			start,
			end,
			trimBefore,
			trimAfter,
			// Token values include trim markers, as `#scanDelimited` writes them.
			tokens: [
				{
					type: "tagOpen",
					value: trimBefore ? "{%-" : "{%",
					start,
					end: start + 2,
				},
				{
					type: "name",
					value: "endverbatim",
					start: nameStart,
					end: nameStart + 11,
				},
				{
					type: "tagClose",
					value: trimAfter ? "-%}" : "%}",
					start: end - 2,
					end,
				},
			],
		});
		this.#pos = end;
	}

	/**
	 * Lexes expression tokens until the closing delimiter for `mode`.
	 *
	 * `closed` is false when the source ended, or a new tag started, before the delimiter.
	 */
	#lexExpression(mode: ExpressionMode): { closed: boolean; trim: boolean } {
		const text = this.#text;
		const length = text.length;
		const tokens = this.#tokens;
		let depth = 0;
		// The position lives in a local while lexing names and punctuators, and in `#pos` around everything else.
		let pos = this.#pos;

		for (;;) {
			while (pos < length && isSpace(text.charCodeAt(pos))) pos++;
			if (pos >= length) {
				this.#pos = pos;
				return NOT_CLOSED;
			}

			const code = text.charCodeAt(pos);
			const next = text.charCodeAt(pos + 1);

			if (mode === "tag") {
				// -%} or %}
				if (code === 45 && next === 37 && text.charCodeAt(pos + 2) === 125) {
					this.#pos = pos + 3;
					return CLOSED_TRIM;
				}
				if (code === 37 && next === 125) {
					this.#pos = pos + 2;
					return CLOSED;
				}
			} else if (mode === "output" && depth === 0) {
				// -}} or }}
				if (code === 45 && next === 125 && text.charCodeAt(pos + 2) === 125) {
					this.#pos = pos + 3;
					return CLOSED_TRIM;
				}
				if (code === 125 && next === 125) {
					this.#pos = pos + 2;
					return CLOSED;
				}
			} else if (mode === "interp" && depth === 0 && code === 125) {
				tokens.push({
					type: "interpClose",
					value: "}",
					start: pos,
					end: pos + 1,
				});
				this.#pos = pos + 1;
				return CLOSED;
			}

			// A new delimiter means this one was never closed. None of these pairs is valid inside an expression.
			if (code === 123 && (next === 123 || next === 37 || next === 35)) {
				this.#pos = pos;
				return NOT_CLOSED;
			}
			if (mode === "interp" && code === 37 && next === 125) {
				this.#pos = pos;
				return NOT_CLOSED;
			}

			if (isNameStart(code)) {
				let end = pos + 1;
				while (end < length && isNamePart(text.charCodeAt(end))) end++;
				tokens.push({
					type: "name",
					value: text.slice(pos, end),
					start: pos,
					end,
				});
				pos = end;
				continue;
			}
			if (isDigit(code)) {
				this.#pos = pos;
				this.#lexNumber();
				pos = this.#pos;
				continue;
			}
			if (code === 34 || code === 39) {
				this.#pos = pos;
				this.#lexString();
				pos = this.#pos;
				continue;
			}

			const punct = punctuatorAt(text, pos, code, next);
			if (punct !== null) {
				if (code === 123) depth++;
				else if (code === 125 && depth > 0) depth--;
				tokens.push({
					type: "punct",
					value: punct,
					start: pos,
					end: pos + punct.length,
				});
				pos += punct.length;
				continue;
			}

			// A whole code point, so a character outside the Basic Multilingual Plane is one problem, not two halves.
			const character = String.fromCodePoint(text.codePointAt(pos) as number);
			this.#problem(
				"unexpected-character",
				`Unexpected character "${character}"`,
				pos,
				pos + character.length,
			);
			pos += character.length;
		}
	}

	#lexNumber(): void {
		const text = this.#text;
		const start = this.#pos;
		const previous = this.#tokens[this.#tokens.length - 1];
		// After `.` or `?.`, only an integer can follow, so `items.0.1` reads two indexes.
		const integerOnly =
			previous?.type === "punct" &&
			(previous.value === "." || previous.value === "?.");

		const readDigits = () => {
			while (this.#pos < text.length) {
				const code = text.charCodeAt(this.#pos);
				if (isDigit(code)) this.#pos++;
				else if (code === 95 && isDigit(text.charCodeAt(this.#pos + 1))) {
					this.#pos++;
				} else break;
			}
		};

		readDigits();
		if (
			!integerOnly &&
			text[this.#pos] === "." &&
			isDigit(text.charCodeAt(this.#pos + 1))
		) {
			this.#pos++;
			readDigits();
		}
		const raw = text.slice(start, this.#pos);
		this.#push("number", raw.replaceAll("_", ""), start, this.#pos);
	}

	#lexString(): void {
		const text = this.#text;
		const start = this.#pos;
		const quote = text[start];
		let value = "";
		let segmentStart = start;
		let interpolated = false;
		this.#pos++;

		while (this.#pos < text.length) {
			const char = text[this.#pos] as string;

			if (char === quote) {
				this.#pos++;
				if (interpolated) {
					if (value !== "") {
						this.#push("string", value, segmentStart, this.#pos - 1);
					}
					this.#push("stringEnd", quote, this.#pos - 1, this.#pos);
				} else {
					this.#push("string", value, start, this.#pos);
				}
				return;
			}

			if (char === "\\") {
				value += this.#readEscape(quote as string);
				continue;
			}

			if (quote === '"' && char === "#" && text[this.#pos + 1] === "{") {
				if (!interpolated) {
					interpolated = true;
					this.#push("stringStart", quote, start, start + 1);
				}
				if (value !== "") {
					this.#push("string", value, segmentStart, this.#pos);
					value = "";
				}
				this.#push("interpOpen", "#{", this.#pos, this.#pos + 2);
				this.#pos += 2;
				const interpStart = this.#pos;
				// Each level of interpolation recurses, so stop before deeply nested strings overflow the stack.
				if (this.#interpolations === MAX_NESTING) {
					this.#problem(
						"too-deep",
						`Template is nested more than ${MAX_NESTING} levels deep`,
						interpStart - 2,
						interpStart,
					);
					this.#skipInterpolation();
					segmentStart = this.#pos;
					continue;
				}
				this.#interpolations++;
				const { closed } = this.#lexExpression("interp");
				this.#interpolations--;
				if (!closed) {
					this.#problem(
						"unclosed-interpolation",
						'Interpolation is missing its closing "}"',
						interpStart - 2,
						interpStart,
					);
					this.#push("interpClose", "", this.#pos, this.#pos);
					this.#push("stringEnd", "", this.#pos, this.#pos);
					return;
				}
				segmentStart = this.#pos;
				continue;
			}

			value += char;
			this.#pos++;
		}

		this.#problem(
			"unclosed-string",
			"String is missing its closing quote",
			start,
			start + 1,
		);
		if (interpolated) {
			if (value !== "") this.#push("string", value, segmentStart, this.#pos);
			this.#push("stringEnd", "", this.#pos, this.#pos);
		} else {
			this.#push("string", value, start, this.#pos);
		}
	}

	/** Skips the rest of an interpolation without lexing it, up to the `}` that balances its `#{`. */
	#skipInterpolation(): void {
		const text = this.#text;
		let depth = 0;
		while (this.#pos < text.length) {
			const char = text[this.#pos++];
			if (char === "{") depth++;
			else if (char === "}" && depth-- === 0) {
				this.#push("interpClose", "}", this.#pos - 1, this.#pos);
				return;
			}
		}
	}

	/** Reads a backslash escape. `\#{` is only an escape in double-quoted strings, where `#{` would start interpolation. */
	#readEscape(quote: string): string {
		const text = this.#text;
		const start = this.#pos;
		const next = text[start + 1];
		if (next === undefined) {
			this.#pos++;
			return "";
		}
		if (next === "#" && quote === '"' && text[start + 2] === "{") {
			this.#pos += 2;
			return "#";
		}
		const simple = ESCAPES[next];
		if (simple !== undefined) {
			this.#pos += 2;
			return simple;
		}
		if (next === "u" && text[start + 2] === "{") {
			// Six hex digits at most, so look no further than the seventh character for the brace.
			const brace = text.slice(start + 3, start + 10).indexOf("}");
			const close = brace === -1 ? -1 : start + 3 + brace;
			const hex = close === -1 ? "" : text.slice(start + 3, close);
			if (/^[0-9a-fA-F]{1,6}$/.test(hex)) {
				const code = Number.parseInt(hex, 16);
				if (code <= 0x10ffff) {
					this.#pos = close + 1;
					return String.fromCodePoint(code);
				}
			}
		}
		this.#problem(
			"invalid-escape",
			`Unknown escape sequence "\\${next}"`,
			start,
			start + 2,
		);
		this.#pos += 2;
		return next;
	}

	#push(type: TokenType, value: string, start: number, end: number): void {
		this.#tokens.push({ type, value, start, end });
	}

	#problem(code: string, message: string, start: number, end: number): void {
		this.#problems.push({ code, message, span: { start, end } });
	}
}

/** Applies `-` markers, which remove all whitespace on their side. */
const applyTrimMarkers = (text: string, parts: Part[]): void => {
	for (let i = 0; i < parts.length; i++) {
		const part = parts[i] as Part;
		if (part.kind === "text") continue;

		const previous = parts[i - 1];
		if (part.trimBefore && previous?.kind === "text") {
			let end = previous.end;
			while (end > previous.start && isSpace(text.charCodeAt(end - 1))) end--;
			previous.to = Math.min(previous.to, end);
		}
		const next = parts[i + 1];
		if (part.trimAfter && next?.kind === "text") {
			let start = next.start;
			while (start < next.end && isSpace(text.charCodeAt(start))) start++;
			next.from = Math.max(next.from, start);
		}
	}
};

const isInlineBlank = (text: string, start: number, end: number): boolean => {
	for (let i = start; i < end; i++) {
		if (!isInlineSpace(text.charCodeAt(i))) return false;
	}
	return true;
};

/**
 * The first line feed from `start` up to `end`, or -1. The search stops at `end`, unlike `indexOf`, so a template with
 * many tags on one long line stays linear.
 */
const newlineIn = (text: string, start: number, end: number): number => {
	for (let i = start; i < end; i++) {
		if (text.charCodeAt(i) === 10) return i;
	}
	return -1;
};

/** The last line feed from `start` up to `end`, or -1. Stops at `start`, as `newlineIn` stops at `end`. */
const lastNewlineIn = (text: string, start: number, end: number): number => {
	for (let i = end - 1; i >= start; i--) {
		if (text.charCodeAt(i) === 10) return i;
	}
	return -1;
};

/**
 * Removes lines that hold only block tags and comments, including their indentation and line ending.
 *
 * Decisions use the original text, so they do not depend on what trim markers removed. Returns the start of each tag and comment it removed.
 */
const applyStandaloneLines = (
	text: string,
	parts: Part[],
): Map<number, number> => {
	const removed = new Map<number, number>();
	const isBlockLike = (part: Part | undefined) =>
		part !== undefined && (part.kind === "tag" || part.kind === "comment");

	let i = 0;
	while (i < parts.length) {
		if (!isBlockLike(parts[i])) {
			i++;
			continue;
		}

		// Group tags on the same line, separated only by spaces.
		let last = i;
		for (;;) {
			const next = parts[last + 1];
			if (isBlockLike(next)) {
				last++;
				continue;
			}
			if (
				next?.kind === "text" &&
				isInlineBlank(text, next.start, next.end) &&
				isBlockLike(parts[last + 2])
			) {
				last += 2;
				continue;
			}
			break;
		}

		let standalone = true;
		let cutBefore = -1;
		const previous = parts[i - 1];
		if (previous) {
			if (previous.kind !== "text") standalone = false;
			else {
				const newline = lastNewlineIn(text, previous.start, previous.end);
				if (newline !== -1) {
					if (isInlineBlank(text, newline + 1, previous.end)) {
						cutBefore = newline + 1;
					} else standalone = false;
				} else if (
					i - 1 === 0 &&
					isInlineBlank(text, previous.start, previous.end)
				) {
					cutBefore = previous.start;
				} else standalone = false;
			}
		}

		let cutAfter = -1;
		const next = parts[last + 1];
		if (standalone && next) {
			if (next.kind !== "text") standalone = false;
			else {
				const newline = newlineIn(text, next.start, next.end);
				if (newline !== -1) {
					if (isInlineBlank(text, next.start, newline)) {
						cutAfter = newline + 1;
					} else standalone = false;
				} else if (
					last + 1 === parts.length - 1 &&
					isInlineBlank(text, next.start, next.end)
				) {
					cutAfter = next.end;
				} else standalone = false;
			}
		}

		if (standalone) {
			if (previous?.kind === "text") {
				previous.to = Math.min(previous.to, cutBefore);
			}
			for (let k = i; k <= last; k++) {
				const part = parts[k] as Part;
				if (part.kind === "text") part.from = part.to;
				else removed.set(part.start, part.end);
			}
			if (next?.kind === "text") next.from = Math.max(next.from, cutAfter);
		}
		i = last + 1;
	}
	return removed;
};

/** Finds the lines of text that hold content. See `TextLine`. */
const textLines = (
	text: string,
	parts: Part[],
	removed: ReadonlyMap<number, number>,
): TextLine[] => {
	const lines: TextLine[] = [];
	const add = (start: number) => {
		let indentEnd = start;
		while (text[indentEnd] === " " || text[indentEnd] === "\t") indentEnd++;
		const next = text[indentEnd];
		if (next === undefined || next === "\n" || next === "\r") return;
		if (removed.has(indentEnd)) return;
		lines.push({ start, indentEnd });
	};
	const first = parts[0];
	const start = contentStart(text);
	if (first && (first.kind !== "text" || first.from === start)) add(start);
	for (const part of parts) {
		if (part.kind !== "text") continue;
		for (
			let newline = newlineIn(text, part.start, part.end);
			newline !== -1;
			newline = newlineIn(text, newline + 1, part.end)
		) {
			const start = newline + 1;
			// A `-` marker trimmed the line break or the whole line.
			if (start < part.from || start > part.to) continue;
			add(start);
		}
	}
	return lines;
};
