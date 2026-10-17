import { issue } from "../errors.js";
import type { EscapeStrategy } from "../parser/ast.js";
import { getAttr, readableNames } from "../runtime/access.js";
import { escapeWith } from "../runtime/escape.js";
import { Markup } from "../runtime/markup.js";
import { checkLength, consume } from "../runtime/render.js";
import type { Run } from "../runtime/types.js";
import {
	BLOCKED_NAMES,
	hashKeys,
	isPlainObject,
	MISSING,
	templateFunctions,
	toStringArgument,
	typeName,
} from "../runtime/values.js";

/** Iterables from the host are read up to this many items, so an endless generator cannot hang a filter. */
const MAX_ITERABLE_ITEMS = 1_000_000;

/** Lists and hashes nested deeper than this are refused by `json`, `dump` and `urlEncode`, so they can't overflow the stack. */
export const MAX_DATA_DEPTH = 1000;

/** Refuses data nested deeper than `MAX_DATA_DEPTH`. */
export const checkDepth = (depth: number, what: string): void => {
	if (depth > MAX_DATA_DEPTH) {
		issue(
			"too-deep",
			`"${what}" cannot convert data nested more than ${MAX_DATA_DEPTH} levels deep`,
		);
	}
};

/**
 * The keys and values of a `Map` that templates can read, as loops see them: every entry except those under a
 * blocked name such as `__proto__`, whatever the type of its key.
 */
export const mapContents = (
	map: Map<unknown, unknown>,
): { keys: unknown[]; values: unknown[] } => {
	const keys: unknown[] = [];
	const values: unknown[] = [];
	for (const [key, item] of map) {
		if (typeof key === "string" && BLOCKED_NAMES.has(key)) continue;
		keys.push(key);
		values.push(item);
	}
	return { keys, values };
};

/**
 * Values and keys of anything a filter can treat as a list. Hashes keep their keys.
 *
 * Every item is charged against `maxSteps`: arrays and hashes before they are read, and iterables such as generators
 * as each item is read.
 */
export const entriesOf = (
	run: Run,
	value: unknown,
	what: string,
): { values: unknown[]; keys: unknown[]; isHash: boolean } => {
	if (value === null || value === undefined) {
		return { values: [], keys: [], isHash: false };
	}
	if (Array.isArray(value)) {
		consume(run, value.length);
		return {
			values: value,
			keys: value.map((_, index) => index),
			isHash: false,
		};
	}
	if (isPlainObject(value)) {
		const keys = hashKeys(value);
		consume(run, keys.length);
		return { values: keys.map((key) => value[key]), keys, isHash: true };
	}
	if (value instanceof Map) {
		consume(run, value.size);
		return { ...mapContents(value), isHash: true };
	}
	if (
		typeof value === "object" &&
		!(value instanceof Markup) &&
		typeof (value as { [Symbol.iterator]?: unknown })[Symbol.iterator] ===
			"function"
	) {
		const values: unknown[] = [];
		for (const item of value as Iterable<unknown>) {
			if (values.length === MAX_ITERABLE_ITEMS) {
				return issue(
					"limit-steps",
					`"${what}" got an iterable with more than ${MAX_ITERABLE_ITEMS} items`,
				);
			}
			consume(run, 1);
			values.push(item);
		}
		return { values, keys: values.map((_, index) => index), isHash: false };
	}
	return issue(
		"type-error",
		`"${what}" needs an array or hash, but got a ${typeName(value)}`,
	);
};

/** Items of an array, set or other iterable, as an array. Arrays are returned as they are. */
export const listOf = (run: Run, value: unknown, what: string): unknown[] => {
	if (Array.isArray(value)) return value;
	return entriesOf(run, value, what).values;
};

/** Requires an integer argument. */
export const integerArgument = (value: unknown, what: string): number => {
	if (typeof value === "number" && Number.isInteger(value)) return value;
	return issue(
		"type-error",
		`${what} must be an integer, but got ${typeName(value)}`,
	);
};

/** Requires an arrow function written in the template. Functions found in data are refused. */
export const functionArgument = (
	value: unknown,
	what: string,
): ((...args: unknown[]) => unknown) => {
	const fn =
		typeof value === "function" ? templateFunctions.get(value) : undefined;
	if (fn) return fn;
	return issue(
		"type-error",
		`"${what}" needs an arrow function such as "item => item.title", but got a ${typeName(value)}`,
	);
};

const ISO_DATE =
	/^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

/** Reads `count` digits from `at`, or returns -1 if any is not a digit. */
const readDigits = (text: string, at: number, count: number): number => {
	let number = 0;
	for (let i = at; i < at + count; i++) {
		const digit = text.charCodeAt(i) - 48;
		if (digit < 0 || digit > 9) return -1;
		number = number * 10 + digit;
	}
	return number;
};

const daysInMonth = (year: number, month: number): number =>
	month === 2
		? year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
			? 29
			: 28
		: month === 4 || month === 6 || month === 9 || month === 11
			? 30
			: 31;

/**
 * Reads the two commonest ISO 8601 forms, `2026-10-15` and `2026-10-15T09:30:00.000Z`, as milliseconds since the
 * epoch, without parsing a string as a date. Returns null for anything else, including out of range parts, which
 * `toDate` then reads in full.
 */
const quickTime = (text: string): number | null => {
	const length = text.length;
	if (length !== 10 && length !== 24) return null;
	const year = readDigits(text, 0, 4);
	const month = readDigits(text, 5, 2);
	const day = readDigits(text, 8, 2);
	if (
		year < 100 ||
		month < 1 ||
		month > 12 ||
		day < 1 ||
		day > daysInMonth(year, month) ||
		text[4] !== "-" ||
		text[7] !== "-"
	) {
		return null;
	}
	let time = 0;
	if (length === 24) {
		const hour = readDigits(text, 11, 2);
		const minute = readDigits(text, 14, 2);
		const second = readDigits(text, 17, 2);
		const millisecond = readDigits(text, 20, 3);
		if (
			text[10] !== "T" ||
			text[13] !== ":" ||
			text[16] !== ":" ||
			text[19] !== "." ||
			text[23] !== "Z" ||
			hour < 0 ||
			hour > 23 ||
			minute < 0 ||
			minute > 59 ||
			second < 0 ||
			second > 59 ||
			millisecond < 0
		) {
			return null;
		}
		time = ((hour * 60 + minute) * 60 + second) * 1000 + millisecond;
	}
	return Date.UTC(year, month - 1, day) + time;
};

/** `toDate` as milliseconds since the epoch, which formatters take without making a `Date`. */
export const toTime = (value: unknown, what: string): number => {
	if (typeof value === "string") {
		const time = quickTime(value);
		if (time !== null) return time;
	}
	return toDate(value, what).getTime();
};

/** Converts a date, ISO 8601 string or milliseconds since the epoch into a valid `Date`. */
export const toDate = (value: unknown, what: string): Date => {
	let date: Date | undefined;
	const quick = typeof value === "string" ? quickTime(value) : null;
	if (value instanceof Date) date = value;
	else if (typeof value === "number") date = new Date(value);
	else if (quick !== null) date = new Date(quick);
	else if (value instanceof Markup || typeof value === "string") {
		const text = String(value).trim();
		if (!ISO_DATE.test(text)) {
			return issue(
				"invalid-argument",
				`${what} needs an ISO 8601 date such as "2026-10-15", but got "${text}"`,
			);
		}
		// `Date` would roll a day past the end of its month into the next month.
		const year = readDigits(text, 0, 4);
		const month = readDigits(text, 5, 2);
		const day = readDigits(text, 8, 2);
		if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
			return issue("invalid-argument", `${what} got an invalid date "${text}"`);
		}
		// A date-time without an offset is read as UTC, so output never depends on the server's time zone.
		const normalised = text.replace(" ", "T");
		const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(normalised);
		date = new Date(
			normalised.length > 10 && !hasZone ? `${normalised}Z` : normalised,
		);
	}
	if (!date) {
		return issue(
			"type-error",
			`${what} needs a date, ISO 8601 string or milliseconds, but got a ${typeName(value)}`,
		);
	}
	if (Number.isNaN(date.getTime())) {
		return issue("invalid-argument", `${what} got an invalid date`);
	}
	return date;
};

/** Reads one property of an item for `column` and `sort`, or null when missing. */
export const readProperty = (item: unknown, name: string | number): unknown => {
	const value = getAttr(item, name);
	return value === MISSING || value === undefined || typeof value === "function"
		? null
		: value;
};

/** How `toPlainData` charges for and limits its work. */
export type PlainDataOptions = {
	/** The filter or function converting, for error messages. */
	what: string;
	/** Called with the number of items in each list or hash before they are copied. */
	charge?: (count: number) => void;
	/** Refuses data whose JSON would be longer than this many characters. */
	maxLength?: number;
	/** The spaces each level of the JSON is indented by, which `maxLength` counts. */
	indent?: number;
};

/**
 * Converts a value into plain JSON data, following the safety model: hashes by own keys, class instances by exposed
 * members only, and sets, generators and other iterables as lists.
 *
 * `onCycle` decides what a repeated object becomes. While it converts, it counts the shortest JSON the data could
 * make, and stops at `maxLength`, so a value that shares one long string in many places can't make a huge string.
 */
export const toPlainData = (
	value: unknown,
	onCycle: () => unknown,
	{
		what,
		charge = () => {},
		maxLength = Infinity,
		indent = 0,
	}: PlainDataOptions,
): unknown => {
	const seen = new Set<object>();
	let size = 0;
	const grow = (amount: number) => {
		size += amount;
		if (size > maxLength) {
			issue(
				"limit-output",
				`"${what}" would build a string longer than the output limit of ${maxLength}`,
			);
		}
	};
	const convertItems = (items: Iterable<unknown>, depth: number): unknown[] => {
		const result: unknown[] = [];
		for (const item of items) {
			grow(indent === 0 ? 1 : 2 + depth * indent);
			result.push(convert(item, depth) ?? null);
		}
		return result;
	};
	const convert = (value: unknown, depth: number): unknown => {
		if (value === null || value === undefined) {
			grow(4);
			return null;
		}
		switch (typeof value) {
			case "string":
				grow(value.length + 2);
				return value;
			case "boolean":
				grow(value ? 4 : 5);
				return value;
			case "number":
				if (!Number.isFinite(value)) {
					grow(4);
					return null;
				}
				grow(String(value).length);
				return value;
			case "bigint": {
				const text = value.toString();
				grow(text.length + 2);
				return text;
			}
			case "function":
			case "symbol":
				return undefined;
		}
		if (value instanceof Markup) return convert(value.value, depth);
		if (value instanceof Date) {
			return convert(
				Number.isNaN(value.getTime()) ? null : value.toISOString(),
				depth,
			);
		}
		const object = value as object;
		if (seen.has(object)) return onCycle();
		checkDepth(depth + 1, what);
		seen.add(object);
		grow(2);
		try {
			if (Array.isArray(object)) {
				charge(object.length);
				return convertItems(object, depth + 1);
			}
			if (object instanceof Set) {
				charge(object.size);
				return convertItems(object, depth + 1);
			}
			if (
				!isPlainObject(object) &&
				!(object instanceof Map) &&
				typeof (object as { [Symbol.iterator]?: unknown })[Symbol.iterator] ===
					"function"
			) {
				const items: unknown[] = [];
				for (const item of object as Iterable<unknown>) {
					if (items.length === MAX_ITERABLE_ITEMS) {
						return issue(
							"limit-steps",
							`"${what}" got an iterable with more than ${MAX_ITERABLE_ITEMS} items`,
						);
					}
					charge(1);
					items.push(item);
				}
				return convertItems(items, depth + 1);
			}
			const result: Record<string, unknown> = {};
			const { keys, values } =
				object instanceof Map
					? mapContents(object)
					: { keys: readableNames(object), values: null };
			charge(keys.length);
			for (let i = 0; i < keys.length; i++) {
				const name = String(keys[i]);
				const item = convert(
					values ? values[i] : getAttr(object, name),
					depth + 1,
				);
				if (item !== undefined && item !== MISSING) {
					grow(name.length + (indent === 0 ? 4 : 6 + (depth + 1) * indent));
					Object.defineProperty(result, name, {
						value: item,
						enumerable: true,
						writable: true,
						configurable: true,
					});
				}
			}
			return result;
		} finally {
			seen.delete(object);
		}
	};
	return convert(value, 0);
};

const isAsciiLetter = (code: number): boolean =>
	(code >= 65 && code <= 90) || (code >= 97 && code <= 122);

const isSpace = (char: string | undefined): boolean =>
	char === " " ||
	char === "\t" ||
	char === "\n" ||
	char === "\r" ||
	char === "\f";

/**
 * Finds the `>` that ends a tag, or -1 when the tag never ends. A quote starts a value only straight after `=`, as in
 * HTML, and only when the same quote appears again later, so an unclosed quote can't hide the rest of the text.
 */
const tagEnd = (
	html: string,
	from: number,
	lastDouble: number,
	lastSingle: number,
): number => {
	let quote = "";
	let afterEquals = false;
	for (let i = from; i < html.length; i++) {
		const char = html[i];
		if (quote) {
			if (char === quote) quote = "";
		} else if (char === ">") return i;
		else if (char === "=") afterEquals = true;
		else if (
			afterEquals &&
			((char === '"' && i < lastDouble) || (char === "'" && i < lastSingle))
		) {
			quote = char;
			afterEquals = false;
		} else if (!isSpace(char)) afterEquals = false;
	}
	return -1;
};

/**
 * Splits HTML into tags and comments, given to `onTag`, and the text between them, given to `onText`, in one linear
 * pass. A `<` that doesn't start a tag that closes is text.
 */
export const scanHtml = (
	html: string,
	onText: (text: string) => void,
	onTag: (tag: string) => void,
): void => {
	const lastDouble = html.lastIndexOf('"');
	const lastSingle = html.lastIndexOf("'");
	let index = 0;
	let textStart = 0;
	let commentsCanClose = true;
	let tagsCanClose = true;
	const tag = (open: number, end: number) => {
		if (textStart < open) onText(html.slice(textStart, open));
		onTag(html.slice(open, end));
		index = textStart = end;
	};
	for (;;) {
		const open = html.indexOf("<", index);
		if (open === -1) break;
		if (commentsCanClose && html.startsWith("<!--", open)) {
			// `<!-->` and `<!--->` are empty comments.
			const close = html.startsWith("<!-->", open)
				? open + 2
				: html.startsWith("<!--->", open)
					? open + 3
					: html.indexOf("-->", open + 4);
			if (close !== -1) {
				tag(open, close + 3);
				continue;
			}
			// No later comment can close either.
			commentsCanClose = false;
		}
		let nameStart = open + 1;
		const marker = html[nameStart];
		if (marker === "!" || marker === "?" || marker === "/") nameStart++;
		if (tagsCanClose && isAsciiLetter(html.charCodeAt(nameStart))) {
			const close = tagEnd(html, nameStart, lastDouble, lastSingle);
			if (close !== -1) {
				tag(open, close + 1);
				continue;
			}
			tagsCanClose = false;
		}
		index = open + 1;
	}
	if (textStart < html.length) onText(html.slice(textStart));
};

/** A piece of markup that string filters keep as it is: a tag, a comment, or an entity they don't decode. */
export class Kept {
	constructor(readonly html: string) {}
}

/** Markup's text, decoded, between the pieces string filters keep. Plain text is one string. */
export type Pieces = (string | Kept)[];

/** Strategies whose markup is HTML, with tags and entities. The others only use escape sequences. */
export const isHtmlStrategy = (strategy: EscapeStrategy): boolean =>
	strategy === "html" || strategy === "attr";

const ENTITY =
	/&(?:#(\d{1,7})|#[xX]([\da-fA-F]{1,6})|([a-zA-Z][\da-zA-Z]{0,31}));/g;

/** The named entities the escapers write. Other names, such as `&nbsp;`, are kept as they are. */
const NAMED_ENTITIES: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
};

const pushText = (pieces: Pieces, text: string) => {
	if (text === "") return;
	const last = pieces.length - 1;
	if (typeof pieces[last] === "string") pieces[last] += text;
	else pieces.push(text);
};

/** Decodes entities in HTML text into `pieces`, keeping entities it doesn't know. */
const decodeEntities = (text: string, pieces: Pieces) => {
	let last = 0;
	for (const match of text.matchAll(ENTITY)) {
		const [entity, decimal, hex, name] = match;
		const code =
			decimal !== undefined
				? Number(decimal)
				: hex !== undefined
					? Number.parseInt(hex, 16)
					: -1;
		const char =
			name !== undefined
				? NAMED_ENTITIES[name]
				: code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff)
					? String.fromCodePoint(code)
					: undefined;
		pushText(pieces, text.slice(last, match.index));
		if (char === undefined) pieces.push(new Kept(entity));
		else pushText(pieces, char);
		last = match.index + entity.length;
	}
	pushText(pieces, text.slice(last));
};

const JS_ESCAPES: Record<string, string> = {
	n: "\n",
	r: "\r",
	t: "\t",
	b: "\b",
	f: "\f",
	v: "\v",
	"0": "\0",
};

/** Decodes the escape sequences of JavaScript, CSS or URL markup into its text. */
const decodeSequences = (text: string, strategy: EscapeStrategy): string => {
	switch (strategy) {
		case "js":
			return text.replace(
				/\\(?:u([\da-fA-F]{4})|x([\da-fA-F]{2})|(.))/gs,
				(_match, unit?: string, byte?: string, char?: string) =>
					unit !== undefined || byte !== undefined
						? String.fromCharCode(Number.parseInt(unit ?? byte ?? "", 16))
						: (JS_ESCAPES[char ?? ""] ?? char ?? ""),
			);
		case "css":
			return text.replace(
				/\\(?:([\da-fA-F]{1,6}) ?|(.))/gs,
				(_match, hex?: string, char?: string) => {
					const code = hex === undefined ? -1 : Number.parseInt(hex, 16);
					return hex === undefined
						? (char ?? "")
						: code > 0 && code <= 0x10ffff
							? String.fromCodePoint(code)
							: "�";
				},
			);
		default:
			return text.replace(/(?:%[\da-fA-F]{2})+/g, (run) => {
				try {
					return decodeURIComponent(run);
				} catch {
					return run;
				}
			});
	}
};

/**
 * Splits markup into its decoded text and the pieces string filters keep as they are. HTML markup keeps its tags,
 * comments and the entities the escapers don't write. Other markup is all text.
 */
export const toPieces = (markup: Markup): Pieces => {
	if (!isHtmlStrategy(markup.strategy)) {
		return [decodeSequences(markup.value, markup.strategy)];
	}
	const pieces: Pieces = [];
	scanHtml(
		markup.value,
		(text) => decodeEntities(text, pieces),
		(tag) => pieces.push(new Kept(tag)),
	);
	return pieces;
};

/** Joins pieces back into markup, escaping the text with the markup's strategy. */
export const fromPieces = (
	run: Run,
	pieces: Pieces,
	strategy: EscapeStrategy,
): Markup => {
	let html = "";
	for (const piece of pieces) {
		html = checkLength(
			run,
			html +
				(typeof piece === "string" ? escapeWith(piece, strategy) : piece.html),
		);
	}
	return new Markup(html, strategy);
};

/**
 * A text argument a string filter inserts into markup, such as `replace`'s replacement: markup of the same strategy
 * is kept as it is, and anything else is text, escaped when the pieces are joined.
 */
export const insertedPiece = (
	value: unknown,
	strategy: EscapeStrategy,
	what: string,
): string | Kept =>
	value instanceof Markup && value.strategy === strategy
		? new Kept(value.value)
		: value instanceof Markup
			? markupText(value)
			: toStringArgument(value, what);

/** Markup's decoded text, with the pieces string filters keep left as they are. */
export const markupText = (markup: Markup): string =>
	toPieces(markup)
		.map((piece) => (typeof piece === "string" ? piece : piece.html))
		.join("");
