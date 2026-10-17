import { scanParts } from "../lexer/lexer.js";
import type { Span } from "../source.js";
import { FOREIGN, RAW_TEXT } from "./data.js";

export type Attribute = {
	name: string;
	/** From the start of the name to the end of the value. */
	span: Span;
	nameSpan: Span;
	/** The written-out value, or null when it has none or is built at render time. */
	value: string | null;
	/** Where `value` starts in the source. */
	valueStart: number;
};

export type StartTag = {
	type: "start";
	name: string;
	/** From `<` to the end of the name. */
	span: Span;
	/** Just past the tag's `>`. */
	end: number;
	attributes: Attribute[];
	/** False when a tag or output among the attributes may add more, as `attrs(...)` does. */
	complete: boolean;
	selfClosing: boolean;
};

export type EndTag = { type: "end"; name: string; start: number; end: number };

export type Tag = StartTag | EndTag;

/** What each character of the source is, besides Kiln tags, which are 0: template text, an output such as `{{ x }}`, or a comment. */
const TEXT = 1;
const OUTPUT = 2;
const COMMENT = 3;

/** Marks each character of the source as `TEXT`, `OUTPUT` or `COMMENT`, leaving Kiln tags and verbatim content at 0. */
const sourceMask = (source: string): Uint8Array => {
	const mask = new Uint8Array(source.length);
	let verbatim = false;
	for (const part of scanParts(source).parts) {
		if (part.kind === "text" && !verbatim) {
			mask.fill(TEXT, part.start, part.end);
		} else if (part.kind === "output") {
			mask.fill(OUTPUT, part.start, part.end);
		} else if (part.kind === "comment") {
			mask.fill(COMMENT, part.start, part.end);
		}
		verbatim =
			part.kind === "tag" &&
			part.tokens.length === 3 &&
			part.tokens[1]?.value === "verbatim";
	}
	return mask;
};

/**
 * A template's source with every Kiln tag, output and comment, and verbatim content, replaced by spaces. Line breaks
 * stay, so offsets, lines and columns match the source. For HTML tools that should only see the markup.
 */
export const templateText = (source: string): string => {
	const mask = sourceMask(source);
	let text = "";
	let start = 0;
	for (let at = 0; at <= source.length; at++) {
		if (at < source.length && mask[at] === TEXT) continue;
		text += source.slice(start, at);
		if (at < source.length) {
			const char = source[at];
			text += char === "\n" || char === "\r" ? char : " ";
		}
		start = at + 1;
	}
	return text;
};

const isSpace = (char: string | undefined) =>
	char === " " ||
	char === "\t" ||
	char === "\n" ||
	char === "\r" ||
	char === "\f";

/**
 * Reads the HTML tags in a template's text. Kiln syntax and outputs are holes whose content is unknown. It only reads
 * tags, never a tree of elements, so HTML split across `if` branches or templates never confuses it.
 */
class Scanner {
	#pos = 0;

	constructor(
		readonly source: string,
		readonly mask: Uint8Array,
	) {}

	#text(at: number) {
		return this.mask[at] === TEXT;
	}

	#output(at: number) {
		return this.mask[at] === OUTPUT;
	}

	/** The character at `at` when it is template text, or undefined at a hole or the end. */
	#char(at: number): string | undefined {
		return this.#text(at) ? this.source[at] : undefined;
	}

	#atHole() {
		return this.#pos < this.source.length && !this.#text(this.#pos);
	}

	#skipHole() {
		while (this.#atHole() && this.mask[this.#pos] !== COMMENT) this.#pos++;
	}

	#skipSpace() {
		while (isSpace(this.#char(this.#pos))) this.#pos++;
	}

	/** Moves past the next `needle` written in the text, or to the end. */
	#skipPast(needle: string) {
		while (this.#pos < this.source.length) {
			if (this.#matches(this.#pos, needle)) {
				this.#pos += needle.length;
				return;
			}
			this.#pos++;
		}
	}

	/** Whether `needle`, in lower case, is written in the text at `at`, in any case. */
	#matches(at: number, needle: string) {
		for (let i = 0; i < needle.length; i++) {
			if (this.#char(at + i)?.toLowerCase() !== needle[i]) return false;
		}
		return true;
	}

	/** Whether the first text is an XML declaration, as in a feed or a sitemap. */
	startsWithXml(): boolean {
		for (let at = 0; at < this.source.length; at++) {
			const char = this.#char(at);
			if (char === undefined || isSpace(char) || char === "﻿") continue;
			return this.#matches(at, "<?xml");
		}
		return false;
	}

	/** Reads characters up to whitespace, `/`, `>`, `stop` or a hole. */
	#word(stop?: string): string {
		const start = this.#pos;
		for (;;) {
			const char = this.#char(this.#pos);
			if (
				char === undefined ||
				isSpace(char) ||
				char === "/" ||
				char === ">" ||
				char === stop
			) {
				return this.source.slice(start, this.#pos);
			}
			this.#pos++;
		}
	}

	/** Moves past a raw text element's content, to its end tag. */
	skipRawText(name: string) {
		while (this.#pos < this.source.length) {
			if (this.#matches(this.#pos, `</${name}`)) {
				const after = this.#char(this.#pos + name.length + 2);
				if (
					after === undefined ||
					isSpace(after) ||
					after === "/" ||
					after === ">"
				) {
					return;
				}
			}
			this.#pos++;
		}
	}

	/** The next start or end tag, or null at the end of the source. Skips comments, doctypes and other text. */
	next(): StartTag | EndTag | null {
		while (this.#pos < this.source.length) {
			if (this.#char(this.#pos) !== "<") {
				this.#pos++;
				continue;
			}
			const next = this.#char(this.#pos + 1);
			if (this.#matches(this.#pos, "<!--")) {
				this.#pos += 4;
				this.#skipPast("-->");
			} else if (next === "!" || next === "?") {
				this.#skipPast(">");
			} else if (next === "/") {
				const start = this.#pos;
				this.#pos += 2;
				const name = this.#word().toLowerCase();
				this.#skipPast(">");
				if (name) return { type: "end", name, start, end: this.#pos };
			} else if (next !== undefined && /[a-z]/i.test(next)) {
				return this.#startTag();
			} else {
				this.#pos++;
			}
		}
		return null;
	}

	#startTag(): StartTag {
		const start = this.#pos;
		this.#pos++;
		const name = this.#word().toLowerCase();
		const tag: StartTag = {
			type: "start",
			name,
			span: { start, end: this.#pos },
			end: this.source.length,
			attributes: [],
			complete: true,
			selfClosing: false,
		};
		while (this.#pos < this.source.length) {
			// A comment adds nothing, but a tag or output may add attributes.
			if (this.mask[this.#pos] === COMMENT) {
				this.#pos++;
				continue;
			}
			if (this.#atHole()) {
				this.#skipHole();
				tag.complete = false;
				continue;
			}
			const char = this.#char(this.#pos);
			if (char === ">") {
				this.#pos++;
				tag.end = this.#pos;
				break;
			}
			if (isSpace(char)) {
				this.#pos++;
			} else if (char === "/") {
				this.#pos++;
				if (this.#char(this.#pos) === ">") tag.selfClosing = true;
			} else {
				const attribute = this.#attribute();
				if (attribute) tag.attributes.push(attribute);
				else tag.complete = false;
			}
		}
		return tag;
	}

	/** Reads one attribute, or returns null when its name is built at render time. */
	#attribute(): Attribute | null {
		const start = this.#pos;
		// A name touching an output, such as `aria-{{ x }}`, is only partly known.
		let known = !this.#output(start - 1);
		this.#pos++;
		this.#word("=");
		while (this.#output(this.#pos)) {
			known = false;
			while (this.#output(this.#pos)) this.#pos++;
			this.#word("=");
		}
		const nameSpan = { start, end: this.#pos };
		const name = this.source.slice(start, this.#pos).toLowerCase();

		let value: string | null = null;
		let valueStart = this.#pos;
		const beforeEquals = this.#pos;
		this.#skipSpace();
		if (this.#char(this.#pos) === "=") {
			this.#pos++;
			this.#skipSpace();
			const quote = this.#char(this.#pos);
			if (quote === '"' || quote === "'") {
				this.#pos++;
				valueStart = this.#pos;
				let written = true;
				while (
					this.#pos < this.source.length &&
					this.#char(this.#pos) !== quote
				) {
					if (this.#atHole()) written = false;
					this.#pos++;
				}
				if (written) value = this.source.slice(valueStart, this.#pos);
				this.#pos++;
			} else {
				valueStart = this.#pos;
				let written = true;
				for (;;) {
					if (this.mask[this.#pos] === COMMENT) break;
					if (this.#atHole()) {
						written = false;
						this.#skipHole();
						continue;
					}
					const char = this.#char(this.#pos);
					if (char === undefined || isSpace(char) || char === ">") break;
					this.#pos++;
				}
				if (written) value = this.source.slice(valueStart, this.#pos);
			}
		} else {
			this.#pos = beforeEquals;
		}
		if (!known) return null;
		return {
			name,
			span: { start, end: Math.min(this.#pos, this.source.length) },
			nameSpan,
			value,
			valueStart,
		};
	}
}

/**
 * The HTML start and end tags written in a template's text, in source order. Leaves out what is inside `<svg>`,
 * `<math>` and elements whose content is text, such as `<script>`, and the end tags of `<svg>` and `<math>`. Returns
 * nothing for a template that starts with an XML declaration, such as a feed.
 */
export const scanTags = (source: string): Tag[] => {
	const scanner = new Scanner(source, sourceMask(source));
	if (scanner.startsWithXml()) return [];
	const tags: Tag[] = [];
	/** The open `svg` or `math` element, and how many of the same name are open inside it. */
	let foreign: { name: string; depth: number } | null = null;

	for (let tag = scanner.next(); tag; tag = scanner.next()) {
		if (foreign) {
			if (tag.name !== foreign.name) continue;
			if (tag.type === "end") {
				if (--foreign.depth === 0) foreign = null;
			} else if (!tag.selfClosing) foreign.depth++;
			continue;
		}
		tags.push(tag);
		if (tag.type === "end") continue;
		// The HTML parser ignores `/>` here, so `<script />` still holds text up to `</script>`.
		if (RAW_TEXT.has(tag.name)) scanner.skipRawText(tag.name);
		else if (FOREIGN.has(tag.name) && !tag.selfClosing) {
			foreign = { name: tag.name, depth: 1 };
		}
	}
	return tags;
};
