import { issue } from "../errors.js";
import type { EscapeStrategy } from "../parser/ast.js";

/*
 * Escaping can make text up to nine times longer, so a chain of `escape` filters could build strings far longer than
 * any render could print. Every escaper stops once its result passes the limit its caller passes: the `escape` filter
 * passes the render's `maxOutputLength`. Autoescaped output needs no limit here, as `write` checks what it prints.
 */

/** Throws a `KilnIssue`, which the call site locates. */
const tooLong = (limit: number): never =>
	issue(
		"limit-output",
		`Escaping made a string longer than the output limit of ${limit}`,
	);

/** Global, so a test leaves `lastIndex` just past the first match. */
const HTML_CHARACTERS = /[&<>"']/g;

/**
 * Escapes text for element content and quoted attribute values. Most text has nothing to escape, which one regular
 * expression test finds; the rest is copied a slice at a time, from the first character that needs escaping.
 */
export const escapeHtml = (value: string, limit?: number): string => {
	HTML_CHARACTERS.lastIndex = 0;
	if (!HTML_CHARACTERS.test(value)) return value;
	let result = "";
	let last = 0;
	for (let i = HTML_CHARACTERS.lastIndex - 1; i < value.length; i++) {
		let replacement: string;
		switch (value.charCodeAt(i)) {
			case 38:
				replacement = "&amp;";
				break;
			case 60:
				replacement = "&lt;";
				break;
			case 62:
				replacement = "&gt;";
				break;
			case 34:
				replacement = "&quot;";
				break;
			case 39:
				replacement = "&#39;";
				break;
			default:
				continue;
		}
		if (last !== i) result += value.slice(last, i);
		result += replacement;
		last = i + 1;
	}
	// Each character grows at most six times, so checking once at the end keeps the work bounded.
	const most = limit ?? Infinity;
	if (result.length + value.length - last > most) tooLong(most);
	return last < value.length ? result + value.slice(last) : result;
};

const isAlphanumeric = (code: number) =>
	(code >= 48 && code <= 57) ||
	(code >= 65 && code <= 90) ||
	(code >= 97 && code <= 122);

/** Escapes everything except letters, digits, `,`, `.`, `-` and `_` as character references, so values are safe even unquoted. */
const escapeAttr = (value: string, limit: number): string => {
	let result = "";
	for (const char of value) {
		if (result.length > limit) tooLong(limit);
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
	return result.length > limit ? tooLong(limit) : result;
};

/** Escapes for a JavaScript string literal, using `\uXXXX` for everything except letters, digits, `,`, `.` and `_`. */
const escapeJs = (value: string, limit: number): string => {
	let result = "";
	for (let i = 0; i < value.length; i++) {
		if (result.length > limit) tooLong(limit);
		const code = value.charCodeAt(i);
		if (isAlphanumeric(code) || code === 44 || code === 46 || code === 95) {
			result += value[i];
		} else {
			result += `\\u${code.toString(16).toUpperCase().padStart(4, "0")}`;
		}
	}
	return result.length > limit ? tooLong(limit) : result;
};

/** Escapes for CSS values, using `\HEX ` for everything except letters and digits. */
const escapeCss = (value: string, limit: number): string => {
	let result = "";
	for (const char of value) {
		if (result.length > limit) tooLong(limit);
		const code = char.codePointAt(0) as number;
		result += isAlphanumeric(code)
			? char
			: `\\${code.toString(16).toUpperCase()} `;
	}
	return result.length > limit ? tooLong(limit) : result;
};

const URL_RESERVED = /[!'()*]/;

/** The last value `escapeUrl` encoded, and the result. Pages often encode one value many times, such as a query. */
let lastUrlValue = "";
let lastUrlEncoded = "";

/** Percent-encodes everything outside RFC 3986's unreserved characters. */
export const escapeUrl = (value: string, limit = Infinity): string => {
	if (value === lastUrlValue) {
		return lastUrlEncoded.length > limit ? tooLong(limit) : lastUrlEncoded;
	}
	let result: string;
	try {
		const encoded = encodeURIComponent(value);
		result = URL_RESERVED.test(encoded)
			? encoded.replace(
					/[!'()*]/g,
					(char) =>
						`%${(char.charCodeAt(0) as number).toString(16).toUpperCase()}`,
				)
			: encoded;
	} catch {
		return issue(
			"invalid-argument",
			"Cannot URL-encode a string with lone surrogates",
		);
	}
	lastUrlValue = value;
	lastUrlEncoded = result;
	return result.length > limit ? tooLong(limit) : result;
};

const ESCAPERS: Record<
	EscapeStrategy,
	(value: string, limit: number) => string
> = {
	html: escapeHtml,
	attr: escapeAttr,
	js: escapeJs,
	css: escapeCss,
	url: escapeUrl,
};

/**
 * Escapes a string with a strategy. Throws a `KilnIssue` with code `limit-output` once the result passes `limit`, which
 * callers that know the render's `maxOutputLength` pass.
 */
export const escapeWith = (
	value: string,
	strategy: EscapeStrategy,
	limit = Infinity,
): string => ESCAPERS[strategy](value, limit);
