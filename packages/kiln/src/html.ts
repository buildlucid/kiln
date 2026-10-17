import { createDiagnostic, type Diagnostic } from "./errors.js";
import { scanParts } from "./lexer/lexer.js";
import type { CompiledTemplate } from "./runtime/types.js";
import { isPlainObject } from "./runtime/values.js";
import type { Span } from "./source.js";
import { suggest } from "./suggest.js";

export const HTML_CHECKS = [
	"html-obsolete-element",
	"html-img-alt",
	"html-button-type",
	"html-lang",
	"html-tabindex",
	"html-aria-attribute",
	"html-role",
] as const;

export type HtmlCheck = (typeof HTML_CHECKS)[number];
export type HtmlCheckLevel = "off" | "warning" | "error";
/** The `htmlChecks` option: every rule on or off, or a level for some rules. Rules left out are warnings. */
export type HtmlChecks = boolean | Partial<Record<HtmlCheck, HtmlCheckLevel>>;
export type HtmlCheckLevels = Readonly<Record<HtmlCheck, HtmlCheckLevel>>;

const LEVELS: readonly unknown[] = ["off", "warning", "error"];

const isHtmlCheck = (code: string): code is HtmlCheck =>
	(HTML_CHECKS as readonly string[]).includes(code);

const isLevel = (level: unknown): level is HtmlCheckLevel =>
	LEVELS.includes(level);

const allAt = (level: HtmlCheckLevel): Record<HtmlCheck, HtmlCheckLevel> => {
	const levels = {} as Record<HtmlCheck, HtmlCheckLevel>;
	for (const code of HTML_CHECKS) levels[code] = level;
	return levels;
};

/** Validates the `htmlChecks` option and gives every rule its level. Throws a `TypeError` for an invalid option. */
export const resolveHtmlChecks = (
	option: HtmlChecks | undefined,
): HtmlCheckLevels => {
	if (option === undefined || option === true) return allAt("warning");
	if (option === false) return allAt("off");
	if (!isPlainObject(option)) {
		throw new TypeError(
			"htmlChecks must be true, false or an object of rule levels",
		);
	}
	const levels = allAt("warning");
	for (const [code, level] of Object.entries(option)) {
		if (!isHtmlCheck(code)) {
			const hint = suggest(code, HTML_CHECKS);
			throw new TypeError(
				`Unknown HTML check "${code}"${hint ? `. ${hint}` : ""}`,
			);
		}
		if (!isLevel(level)) {
			throw new TypeError(
				`HTML check "${code}" must be "off", "warning" or "error"`,
			);
		}
		levels[code] = level;
	}
	return levels;
};

/** The shortest `htmlChecks` option that gives these levels, for `kiln.json`. */
export const htmlChecksOption = (levels: HtmlCheckLevels): HtmlChecks => {
	const changed: Partial<Record<HtmlCheck, HtmlCheckLevel>> = {};
	for (const code of HTML_CHECKS) {
		if (levels[code] !== "warning") changed[code] = levels[code];
	}
	const codes = Object.keys(changed);
	if (codes.length === 0) return true;
	if (
		codes.length === HTML_CHECKS.length &&
		HTML_CHECKS.every((code) => levels[code] === "off")
	) {
		return false;
	}
	return changed;
};

/** Obsolete elements in the HTML standard, by what to use instead. */
const OBSOLETE = new Map(
	Object.entries({
		"Use <abbr> instead": ["acronym"],
		"Use <object> or <embed> instead": ["applet"],
		"Use CSS instead": [
			"basefont",
			"big",
			"blink",
			"center",
			"font",
			"marquee",
			"multicol",
			"nobr",
			"spacer",
		],
		"Use <audio> instead": ["bgsound"],
		"Use <ul> instead": ["dir"],
		"Use <iframe>, or a layout with CSS, instead": [
			"frame",
			"frameset",
			"noframes",
		],
		"Use a form with a text field instead": ["isindex"],
		"Use the Web Crypto API instead": ["keygen"],
		"Use <pre> and <code> instead": ["listing", "plaintext", "xmp"],
		"Use a <button> inside <menu> instead": ["menuitem"],
		"Remove it": ["nextid"],
		"Use fallback content inside <object> instead": ["noembed"],
		"Use attributes on <object> instead": ["param"],
		"Use <ruby> with <rt> instead": ["rb", "rtc"],
		"Use <s>, or <del> for removed text, instead": ["strike"],
		"Use <code>, <kbd> or <samp> instead": ["tt"],
	}).flatMap(([advice, names]) => names.map((name) => [name, advice] as const)),
);

/** States and properties from WAI-ARIA 1.2, plus those the 1.3 draft adds. */
const ARIA_ATTRIBUTES = new Set(
	[
		"activedescendant",
		"atomic",
		"autocomplete",
		"braillelabel",
		"brailleroledescription",
		"busy",
		"checked",
		"colcount",
		"colindex",
		"colindextext",
		"colspan",
		"controls",
		"current",
		"describedby",
		"description",
		"details",
		"disabled",
		"dropeffect",
		"errormessage",
		"expanded",
		"flowto",
		"grabbed",
		"haspopup",
		"hidden",
		"invalid",
		"keyshortcuts",
		"label",
		"labelledby",
		"level",
		"live",
		"modal",
		"multiline",
		"multiselectable",
		"orientation",
		"owns",
		"placeholder",
		"posinset",
		"pressed",
		"readonly",
		"relevant",
		"required",
		"roledescription",
		"rowcount",
		"rowindex",
		"rowindextext",
		"rowspan",
		"selected",
		"setsize",
		"sort",
		"valuemax",
		"valuemin",
		"valuenow",
		"valuetext",
	].map((name) => `aria-${name}`),
);

/** Roles from WAI-ARIA 1.2, plus those the 1.3 draft adds. */
const ROLES = new Set([
	"alert",
	"alertdialog",
	"application",
	"article",
	"banner",
	"blockquote",
	"button",
	"caption",
	"cell",
	"checkbox",
	"code",
	"columnheader",
	"combobox",
	"comment",
	"complementary",
	"contentinfo",
	"definition",
	"deletion",
	"dialog",
	"directory",
	"document",
	"emphasis",
	"feed",
	"figure",
	"form",
	"generic",
	"grid",
	"gridcell",
	"group",
	"heading",
	"image",
	"img",
	"insertion",
	"link",
	"list",
	"listbox",
	"listitem",
	"log",
	"main",
	"mark",
	"marquee",
	"math",
	"menu",
	"menubar",
	"menuitem",
	"menuitemcheckbox",
	"menuitemradio",
	"meter",
	"navigation",
	"none",
	"note",
	"option",
	"paragraph",
	"presentation",
	"progressbar",
	"radio",
	"radiogroup",
	"region",
	"row",
	"rowgroup",
	"rowheader",
	"scrollbar",
	"search",
	"searchbox",
	"sectionfooter",
	"sectionheader",
	"separator",
	"slider",
	"spinbutton",
	"status",
	"strong",
	"subscript",
	"suggestion",
	"superscript",
	"switch",
	"tab",
	"table",
	"tablist",
	"tabpanel",
	"term",
	"textbox",
	"time",
	"timer",
	"toolbar",
	"tooltip",
	"tree",
	"treegrid",
	"treeitem",
]);

/** Roles that only organise the ARIA spec. Pages must not use them. */
const ABSTRACT_ROLES = new Set([
	"command",
	"composite",
	"input",
	"landmark",
	"range",
	"roletype",
	"section",
	"sectionhead",
	"select",
	"structure",
	"widget",
	"window",
]);

/** Elements whose content is text, so tags inside them aren't elements. */
const RAW_TEXT = new Set([
	"script",
	"style",
	"textarea",
	"title",
	"xmp",
	"iframe",
	"noembed",
	"noframes",
	"plaintext",
]);

/** Elements whose content follows SVG or MathML rules instead of HTML's. */
const FOREIGN = new Set(["svg", "math"]);

type Attribute = {
	name: string;
	/** From the start of the name to the end of the value. */
	span: Span;
	nameSpan: Span;
	/** The written-out value, or null when it has none or is built at render time. */
	value: string | null;
	/** Where `value` starts in the source. */
	valueStart: number;
};

type StartTag = {
	type: "start";
	name: string;
	/** From `<` to the end of the name. */
	span: Span;
	attributes: Attribute[];
	/** False when a tag or output among the attributes may add more, as `attrs(...)` does. */
	complete: boolean;
	selfClosing: boolean;
};

type EndTag = { type: "end"; name: string };

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
				this.#pos += 2;
				const name = this.#word().toLowerCase();
				this.#skipPast(">");
				if (name) return { type: "end", name };
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

const TABINDEX = /^[\t\n\f\r ]*([+-]?)(\d+)/;

/** Checks the HTML written in a template against the rules `levels` turns on. Never renders. */
export const checkHtml = (
	template: CompiledTemplate,
	levels: HtmlCheckLevels,
): Diagnostic[] => {
	const diagnostics: Diagnostic[] = [];
	if (HTML_CHECKS.every((code) => levels[code] === "off")) return diagnostics;
	const report = (code: HtmlCheck, message: string, span: Span) => {
		const level = levels[code];
		if (level === "off") return;
		diagnostics.push(
			createDiagnostic(template.source, code, message, span, level),
		);
	};
	const hint = (message: string, text: string | undefined) =>
		text ? `${message}. ${text}` : message;

	const scanner = new Scanner(
		template.source.text,
		sourceMask(template.source.text),
	);
	if (scanner.startsWithXml()) return diagnostics;

	/** The open `svg` or `math` element, and how many of the same name are open inside it. */
	let foreign: { name: string; depth: number } | null = null;

	for (let tag = scanner.next(); tag; tag = scanner.next()) {
		if (tag.type === "end") {
			if (foreign && tag.name === foreign.name && --foreign.depth === 0) {
				foreign = null;
			}
			continue;
		}
		if (RAW_TEXT.has(tag.name) && !tag.selfClosing) {
			scanner.skipRawText(tag.name);
		}
		if (foreign) {
			if (tag.name === foreign.name && !tag.selfClosing) foreign.depth++;
			continue;
		}
		if (FOREIGN.has(tag.name) && !tag.selfClosing) {
			foreign = { name: tag.name, depth: 1 };
		}

		const has = (name: string) =>
			tag.attributes.some((attribute) => attribute.name === name);
		const obsolete = OBSOLETE.get(tag.name);
		if (obsolete) {
			report(
				"html-obsolete-element",
				`<${tag.name}> is obsolete. ${obsolete}`,
				tag.span,
			);
		}
		if (tag.complete) {
			if (tag.name === "img" && !has("alt")) {
				report(
					"html-img-alt",
					'<img> has no alt attribute. Use alt="" if the image is decorative',
					tag.span,
				);
			}
			if (tag.name === "button" && !has("type")) {
				report(
					"html-button-type",
					'<button> has no type attribute, so it submits any form it is in. Add type="button" or type="submit"',
					tag.span,
				);
			}
			if (tag.name === "html" && !has("lang")) {
				report(
					"html-lang",
					'<html> has no lang attribute. Add one, such as lang="en"',
					tag.span,
				);
			}
		}

		for (const attribute of tag.attributes) {
			if (
				attribute.name.startsWith("aria-") &&
				!ARIA_ATTRIBUTES.has(attribute.name)
			) {
				report(
					"html-aria-attribute",
					hint(
						`"${attribute.name}" is not an ARIA attribute`,
						suggest(attribute.name, ARIA_ATTRIBUTES),
					),
					attribute.nameSpan,
				);
			}
			if (attribute.value === null) continue;
			if (attribute.name === "tabindex") {
				const match = TABINDEX.exec(attribute.value);
				if (match && match[1] !== "-" && Number(match[2]) > 0) {
					report(
						"html-tabindex",
						`tabindex="${attribute.value}" puts this element ahead of the rest of the page when tabbing. Use 0, or -1 to focus it only from script`,
						attribute.span,
					);
				}
			}
			if (attribute.name === "role") {
				for (const match of attribute.value.matchAll(/[^\t\n\f\r ]+/g)) {
					const role = match[0].toLowerCase();
					// DPUB-ARIA and Graphics-ARIA roles.
					if (
						ROLES.has(role) ||
						role.startsWith("doc-") ||
						role.startsWith("graphics-")
					) {
						continue;
					}
					const start = attribute.valueStart + match.index;
					const span = { start, end: start + role.length };
					if (ABSTRACT_ROLES.has(role)) {
						report(
							"html-role",
							`"${role}" is an abstract ARIA role, which pages must not use`,
							span,
						);
					} else {
						report(
							"html-role",
							hint(`"${role}" is not an ARIA role`, suggest(role, ROLES)),
							span,
						);
					}
				}
			}
		}
	}
	return diagnostics;
};
