import { issue } from "../errors.js";
import type { EscapeStrategy } from "../parser/ast.js";

const HTML_CHARACTERS = /[&<>"']/;
const HTML_REPLACEMENTS: Record<string, string> = {
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
	"'": "&#39;",
};

/** Escapes text for element content and quoted attribute values. */
export const escapeHtml = (value: string): string =>
	HTML_CHARACTERS.test(value)
		? value.replace(/[&<>"']/g, (char) => HTML_REPLACEMENTS[char] as string)
		: value;

const isAlphanumeric = (code: number) =>
	(code >= 48 && code <= 57) ||
	(code >= 65 && code <= 90) ||
	(code >= 97 && code <= 122);

/** Escapes everything except letters, digits, `,`, `.`, `-` and `_` as character references, so values are safe even unquoted. */
const escapeAttr = (value: string): string => {
	let result = "";
	for (const char of value) {
		const code = char.codePointAt(0) as number;
		if (
			isAlphanumeric(code) ||
			code === 44 ||
			code === 46 ||
			code === 45 ||
			code === 95
		) {
			result += char;
		} else if (char === "&") result += "&amp;";
		else if (char === "<") result += "&lt;";
		else if (char === ">") result += "&gt;";
		else if (char === '"') result += "&quot;";
		else if (
			(code < 0x20 && code !== 9 && code !== 10 && code !== 13) ||
			(code >= 0x7f && code <= 0x9f) ||
			(code >= 0xd800 && code <= 0xdfff)
		) {
			// Control characters and lone surrogates are not allowed in HTML.
			result += "&#xFFFD;";
		} else {
			result += `&#x${code.toString(16).toUpperCase()};`;
		}
	}
	return result;
};

/** Escapes for a JavaScript string literal, using `\uXXXX` for everything except letters, digits, `,`, `.` and `_`. */
const escapeJs = (value: string): string => {
	let result = "";
	for (let i = 0; i < value.length; i++) {
		const code = value.charCodeAt(i);
		if (isAlphanumeric(code) || code === 44 || code === 46 || code === 95) {
			result += value[i];
		} else {
			result += `\\u${code.toString(16).toUpperCase().padStart(4, "0")}`;
		}
	}
	return result;
};

/** Escapes for CSS values, using `\HEX ` for everything except letters and digits. */
const escapeCss = (value: string): string => {
	let result = "";
	for (const char of value) {
		const code = char.codePointAt(0) as number;
		result += isAlphanumeric(code)
			? char
			: `\\${code.toString(16).toUpperCase()} `;
	}
	return result;
};

/** Percent-encodes everything outside RFC 3986's unreserved characters. */
export const escapeUrl = (value: string): string => {
	try {
		return encodeURIComponent(value).replace(
			/[!'()*]/g,
			(char) => `%${(char.charCodeAt(0) as number).toString(16).toUpperCase()}`,
		);
	} catch {
		return issue(
			"invalid-argument",
			"Cannot URL-encode a string with lone surrogates",
		);
	}
};

const ESCAPERS: Record<EscapeStrategy, (value: string) => string> = {
	html: escapeHtml,
	attr: escapeAttr,
	js: escapeJs,
	css: escapeCss,
	url: escapeUrl,
};

/** Escapes a string with a strategy. */
export const escapeWith = (value: string, strategy: EscapeStrategy): string =>
	ESCAPERS[strategy](value);
