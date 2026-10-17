import { issue } from "../errors.js";
import { escapeHtml, escapeUrl } from "../runtime/escape.js";
import { Markup } from "../runtime/markup.js";
import {
	all,
	checkLength,
	consume,
	hold,
	isPromise,
	silence,
	unhold,
} from "../runtime/render.js";
import type { CallableEntry, Run } from "../runtime/types.js";
import {
	BLOCKED_NAMES,
	compare,
	FORMATTERS,
	type FormatterCells,
	hashKeys,
	isHashLike,
	isPlainObject,
	setOwn,
	toNumber,
	toStr,
	toStringArgument,
	valueLabel,
	truthy,
	typeName,
	unwrap,
} from "../runtime/values.js";
import { dateFormat, type Format, numberFormat } from "./formatters.js";
import {
	checkDepth,
	entriesOf,
	fromPieces,
	functionArgument,
	insertedPiece,
	integerArgument,
	isHtmlStrategy,
	Kept,
	listOf,
	mapContents,
	markupText,
	type Pieces,
	readProperty,
	scanHtml,
	toPieces,
	toTime,
	toPlainData,
} from "./helpers.js";

type BuiltinEntry = Extract<CallableEntry, { kind: "builtin" }>;

const define = (
	call: BuiltinEntry["call"],
	params: readonly string[] = [],
	options = false,
): BuiltinEntry => ({ kind: "builtin", call, params, options });

/** Counts code points without allocating an array. A surrogate without its partner counts as one, as `split` does. */
const codePointLength = (text: string): number => {
	let count = 0;
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if (code >= 0xd800 && code <= 0xdbff) {
			const next = text.charCodeAt(i + 1);
			if (next >= 0xdc00 && next <= 0xdfff) i++;
		}
		count++;
	}
	return count;
};

const SURROGATE = /[\uD800-\uDFFF]/;

/** The UTF-16 index just after the first `count` code points, or the text's length when it has fewer. */
const codePointOffset = (text: string, count: number): number => {
	let index = 0;
	for (let n = 0; n < count && index < text.length; n++) {
		const code = text.charCodeAt(index);
		const next = text.charCodeAt(index + 1);
		index +=
			code >= 0xd800 && code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff
				? 2
				: 1;
	}
	return index;
};

/** Splits text into code points, which is how string filters count characters. */
// oxlint-disable-next-line typescript/no-misused-spread -- code points are the documented unit, not graphemes
const codePoints = (text: string): string[] => [...text];

const trimCharacters = (
	text: string,
	characters: string,
	side: string,
): string => {
	const set = new Set(characters);
	const chars = codePoints(text);
	let start = 0;
	let end = chars.length;
	if (side !== "end")
		while (start < end && set.has(chars[start] as string)) start++;
	if (side !== "start")
		while (end > start && set.has(chars[end - 1] as string)) end--;
	return chars.slice(start, end).join("");
};

/** Refuses a string a filter would build longer than `maxOutputLength`, before it builds it. */
const refuseLength = (run: Run, length: number, what: string): void => {
	if (length > run.state.maxSize) {
		issue(
			"limit-output",
			`"${what}" would build a string longer than the output limit of ${run.state.maxSize}`,
		);
	}
};

/**
 * Runs a string filter over markup's text. Tags, comments and entities stay as they are, and the result is markup of
 * the same strategy, so it isn't escaped again.
 */
const changeMarkup = (
	run: Run,
	markup: Markup,
	change: (pieces: Pieces) => Pieces,
): Markup => {
	checkLength(run, markup.value);
	return fromPieces(run, change(toPieces(markup)), markup.strategy);
};

const mapText = (pieces: Pieces, change: (text: string) => string): Pieces =>
	pieces.map((piece) => (typeof piece === "string" ? change(piece) : piece));

/** Joins the pieces of plain text, which never holds kept pieces. */
const joinText = (pieces: Pieces): string =>
	pieces
		.map((piece) => (typeof piece === "string" ? piece : piece.html))
		.join("");

const upperFirst = (text: string): string => {
	const head = String.fromCodePoint(text.codePointAt(0) as number);
	return head.toUpperCase() + text.slice(head.length);
};

/** Upper-cases the first character of the text and lower-cases the rest. */
const capitalizeText = (text: string): string => {
	const first = text.codePointAt(0);
	if (first === undefined) return "";
	const head = String.fromCodePoint(first);
	return head.toUpperCase() + text.slice(head.length).toLowerCase();
};

/** `capitalizeText` over pieces: the first character of the first text that has one. */
const capitalizePieces = (pieces: Pieces): Pieces => {
	let first = true;
	return mapText(pieces, (text) => {
		if (!first || text === "") return text.toLowerCase();
		first = false;
		return capitalizeText(text);
	});
};

/** Letters, marks, digits and apostrophes, so neither a combining accent nor the apostrophe in "o'neil" starts a word. */
const WORD = /[\p{L}\p{M}\p{N}'’]+/gu;
const STARTS_WITH_LETTER = /^\p{L}/u;
const ENDS_IN_WORD = /[\p{L}\p{M}\p{N}'’]$/u;

/** Starts each word with an upper-case letter and lower-cases the rest. The first word only when `boundary` is true. */
const titleText = (text: string, boundary: boolean): string =>
	text
		.toLowerCase()
		.replace(WORD, (word, offset: number) =>
			(offset > 0 || boundary) && STARTS_WITH_LETTER.test(word)
				? upperFirst(word)
				: word,
		);

/** `titleText` over pieces. Tags don't end a word, but kept entities do. */
const titlePieces = (pieces: Pieces): Pieces => {
	let boundary = true;
	return pieces.map((piece) => {
		if (typeof piece !== "string") {
			if (!piece.html.startsWith("<")) boundary = true;
			return piece;
		}
		const text = titleText(piece, boundary);
		boundary = !ENDS_IN_WORD.test(piece);
		return text;
	});
};

/** Trims the text at each end of the pieces, stopping at a kept piece such as a tag. */
const trimPieces = (
	pieces: Pieces,
	side: string,
	trimText: (text: string, side: "start" | "end") => string,
): Pieces => {
	const result = [...pieces];
	if (side !== "end") {
		for (let i = 0; i < result.length; i++) {
			const piece = result[i];
			if (typeof piece !== "string") break;
			result[i] = trimText(piece, "start");
			if (result[i] !== "") break;
		}
	}
	if (side !== "start") {
		for (let i = result.length - 1; i >= 0; i--) {
			const piece = result[i];
			if (typeof piece !== "string") break;
			result[i] = trimText(piece, "end");
			if (result[i] !== "") break;
		}
	}
	return result;
};

/** Text a filter inserts: plain text, or markup kept as it is. */
type Insert = string | Kept;

const insertLength = (insert: Insert): number =>
	typeof insert === "string" ? insert.length : insert.html.length;

/**
 * Replaces several strings at once, preferring the longest match at each position. Candidates are looked up by their
 * first character, and the characters compared are charged against `maxSteps`, 256 to a step. The result is checked
 * against `maxOutputLength` as it grows, before it is joined.
 */
const replacePairs = (
	run: Run,
	text: string,
	pairs: [string, Insert][],
): Pieces => {
	const byFirst = new Map<string, [string, Insert][]>();
	for (const pair of pairs) {
		const first = pair[0][0];
		if (first === undefined) continue;
		const list = byFirst.get(first);
		if (list) list.push(pair);
		else byFirst.set(first, [pair]);
	}
	for (const list of byFirst.values()) {
		list.sort((a, b) => b[0].length - a[0].length);
	}
	const pieces: Pieces = [];
	let start = 0;
	let i = 0;
	let length = 0;
	let compared = 0;
	while (i < text.length) {
		const candidates = byFirst.get(text[i] as string);
		let match: [string, Insert] | undefined;
		if (candidates) {
			for (const pair of candidates) {
				compared += pair[0].length;
				if (text.startsWith(pair[0], i)) {
					match = pair;
					break;
				}
			}
			if (compared >= 256) {
				consume(run, compared >> 8);
				compared &= 255;
			}
		}
		if (!match) {
			i++;
			continue;
		}
		length += i - start + insertLength(match[1]);
		refuseLength(run, length, "replace");
		if (i > start) pieces.push(text.slice(start, i));
		pieces.push(match[1]);
		i += match[0].length;
		start = i;
	}
	refuseLength(run, length + text.length - start, "replace");
	if (start < text.length) pieces.push(text.slice(start));
	return pieces;
};

/** Elements that have no closing tag. */
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

const TAG_NAME = /^<(\/?)([a-zA-Z][^\s/>]*)/;

/**
 * Cuts markup's text after `max` characters, counting a kept entity as one, and adds `ending`. The tags still open at
 * the cut are closed, so the HTML stays balanced.
 */
const truncatePieces = (
	pieces: Pieces,
	max: number,
	ending: Insert,
): Pieces => {
	const result: Pieces = [];
	const open: string[] = [];
	let remaining = max;
	for (const piece of pieces) {
		if (typeof piece !== "string" && piece.html.startsWith("<")) {
			result.push(piece);
			const [, closing, name] = TAG_NAME.exec(piece.html) ?? [];
			const tag = name?.toLowerCase();
			if (tag === undefined || VOID_ELEMENTS.has(tag)) continue;
			if (closing) {
				const index = open.lastIndexOf(tag);
				if (index !== -1) open.length = index;
			} else if (!piece.html.endsWith("/>")) open.push(tag);
			continue;
		}
		const length = typeof piece === "string" ? codePointLength(piece) : 1;
		if (length <= remaining) {
			result.push(piece);
			remaining -= length;
			continue;
		}
		if (typeof piece === "string" && remaining > 0) {
			result.push(piece.slice(0, codePointOffset(piece, remaining)));
		}
		const last = result[result.length - 1];
		if (typeof last === "string") result[result.length - 1] = last.trimEnd();
		result.push(ending);
		for (let i = open.length - 1; i >= 0; i--) {
			result.push(new Kept(`</${open[i] as string}>`));
		}
		return result;
	}
	return result;
};

const roundNumber = (
	value: number,
	precision: number,
	method: string,
): number => {
	if (method !== "common" && method !== "ceil" && method !== "floor") {
		return issue(
			"invalid-argument",
			`"round" method must be "common", "ceil" or "floor", but got "${method}"`,
		);
	}
	const shift = (number: number, exponent: number) => {
		const [mantissa, power = "0"] = String(number).split("e");
		return Number(`${mantissa}e${Number(power) + exponent}`);
	};
	const scaled = shift(
		method === "common" ? Math.abs(value) : value,
		precision,
	);
	// Infinity, NaN and numbers with fewer decimal places than `precision` can hold are already rounded.
	if (!Number.isFinite(scaled)) return value;
	const rounded = shift(
		method === "ceil"
			? Math.ceil(scaled)
			: method === "floor"
				? Math.floor(scaled)
				: Math.round(scaled),
		-precision,
	);
	return method === "common" && value < 0 ? -rounded : rounded;
};

/**
 * Builds `urlEncode`'s query string from a hash. Each list and hash is charged against `maxSteps` before it is read,
 * and the text stops at `maxOutputLength` before each part is encoded, so a value that shares one object in many
 * places can't make unlimited work.
 */
const queryString = (run: Run, hash: object): string => {
	const parts: string[] = [];
	const seen = new Set<object>();
	let length = 0;
	const add = (value: object, prefix: string | null, depth: number) => {
		checkDepth(depth, "urlEncode");
		const { values, keys } = entriesOf(run, value, "urlEncode");
		seen.add(value);
		for (let i = 0; i < values.length; i++) {
			const item = values[i];
			if (item === null || item === undefined) continue;
			const key =
				prefix === null ? String(keys[i]) : `${prefix}[${String(keys[i])}]`;
			if (
				Array.isArray(item) ||
				isPlainObject(item) ||
				item instanceof Map ||
				item instanceof Set
			) {
				if (seen.has(item)) {
					issue(
						"invalid-argument",
						'"urlEncode" cannot encode a value that contains itself',
					);
				}
				add(item, key, depth + 1);
				continue;
			}
			const text = toStr(item);
			// Encoding never makes text shorter, so check before encoding, and again after.
			refuseLength(run, length + key.length + text.length, "urlEncode");
			const part = `${escapeUrl(key)}=${escapeUrl(text)}`;
			length += part.length + 1;
			refuseLength(run, length - 1, "urlEncode");
			parts.push(part);
		}
		seen.delete(value);
	};
	add(hash, null, 1);
	return parts.join("&");
};

const formatterCache = new Map<string, Formatter>();

/** Longer cache keys aren't cached, so templates can't fill the cache with large strings. */
const MAX_FORMATTER_KEY = 512;

const NUMBER_OPTIONS = new Set([
	"localeMatcher",
	"style",
	"currency",
	"currencyDisplay",
	"currencySign",
	"unit",
	"unitDisplay",
	"minimumIntegerDigits",
	"minimumFractionDigits",
	"maximumFractionDigits",
	"minimumSignificantDigits",
	"maximumSignificantDigits",
	"roundingPriority",
	"roundingIncrement",
	"roundingMode",
	"trailingZeroDisplay",
	"notation",
	"compactDisplay",
	"useGrouping",
	"signDisplay",
	"numberingSystem",
]);

/** `plural` options configure both its plural rules and the number `#` becomes. */
const PLURAL_OPTIONS = new Set([...NUMBER_OPTIONS, "type"]);

/** Date options that choose what to show. Without one, `formatDate` uses `dateStyle: "medium"`. */
const DATE_STYLE_OPTIONS = new Set([
	"dateStyle",
	"timeStyle",
	"weekday",
	"era",
	"year",
	"month",
	"day",
	"dayPeriod",
	"hour",
	"minute",
	"second",
	"fractionalSecondDigits",
	"timeZoneName",
]);

const DATE_OPTIONS = new Set([
	...DATE_STYLE_OPTIONS,
	"localeMatcher",
	"calendar",
	"numberingSystem",
	"hour12",
	"hourCycle",
	"timeZone",
	"formatMatcher",
]);

/** Keys of frozen options hashes, which the compiler builds once for literal named arguments. */
const optionsKeys = new WeakMap<object, string>();

/**
 * The part of a formatter's cache key its options make. Option names must be ones `Intl` knows, from `names`. Option
 * values must be strings, markup, numbers, booleans or null: `JSON.stringify` and `Intl` would call methods such as
 * `toJSON` and `toString` on anything else.
 */
const optionsKey = (
	options: Record<string, unknown>,
	names: ReadonlySet<string>,
): string => {
	const frozen = Object.isFrozen(options);
	let key = frozen ? optionsKeys.get(options) : undefined;
	if (key !== undefined) return key;
	key = "";
	for (const name of hashKeys(options)) {
		if (name === "locale") continue;
		if (!names.has(name)) {
			return issue("invalid-argument", `Unknown formatting option "${name}"`);
		}
		const value = unwrap(options[name]);
		if (
			(typeof value === "object" && value !== null) ||
			typeof value === "function"
		) {
			return issue(
				"type-error",
				`Formatting option "${name}" must be a string, number or boolean, but got ${valueLabel(value)}`,
			);
		}
		key += `|${name}=${JSON.stringify(value)}`;
	}
	if (frozen) optionsKeys.set(options, key);
	return key;
};

type Formatter = Format | Intl.PluralRules;

/** Formatters that calls without options last resolved to. */
const NO_OPTIONS: FormatterCells = {};

/**
 * Splits `locale` out of filter options and caches the formatter by its settings. `names` are the options allowed, and
 * `defaults` gives the settings the options are merged over.
 *
 * Calls without options, or with a hash of literals such as `formatNumber(style: "currency")`'s, which
 * `literalOptions` gives a place for it, first try the formatter they used last, so a filter called in a loop skips
 * building the cache key.
 */
const cachedFormatter = <T extends Formatter>(
	kind: "number" | "date" | "plural",
	run: Run,
	options: unknown,
	names: ReadonlySet<string>,
	defaults: (options: Record<string, unknown>) => Record<string, unknown>,
	create: (locale: string, options: Record<string, unknown>) => T,
): T => {
	const { state } = run;
	const cells =
		options === undefined || options === null
			? NO_OPTIONS
			: typeof options === "object"
				? (options as { [FORMATTERS]?: FormatterCells })[FORMATTERS]
				: undefined;
	const recent = cells?.[kind];
	if (
		recent &&
		recent.locale === state.locale &&
		recent.timeZone === state.timeZone
	) {
		return recent.formatter as T;
	}
	if (options !== undefined && options !== null && !isPlainObject(options)) {
		return issue(
			"type-error",
			`Formatting options must be a hash, but got a ${typeName(options)}`,
		);
	}
	const given = (options ?? {}) as Record<string, unknown>;
	const locale = given.locale === undefined ? run.state.locale : given.locale;
	if (typeof locale !== "string") {
		return issue("type-error", '"locale" must be a string');
	}
	// The key lists defaults then options in order, which fixes the merged settings, without building them on a hit.
	const base = defaults(given);
	let key = `${kind}|${locale}`;
	for (const name in base) key += `|${name}=${JSON.stringify(base[name])}`;
	key += optionsKey(given, names);
	const cacheable = key.length <= MAX_FORMATTER_KEY;
	let formatter = cacheable
		? (formatterCache.get(key) as T | undefined)
		: undefined;
	if (!formatter) {
		const settings = { ...base };
		for (const name of hashKeys(given)) {
			if (name !== "locale") setOwn(settings, name, unwrap(given[name]));
		}
		formatter = create(locale, settings);
		if (cacheable) {
			if (formatterCache.size > 500) formatterCache.clear();
			formatterCache.set(key, formatter);
		}
	}
	if (cells) {
		cells[kind] = {
			locale: state.locale,
			timeZone: state.timeZone,
			formatter,
		};
	}
	return formatter;
};

/** Calls a template callback for each item, then gathers the results, waiting only if one was a promise. */
const mapEntries = (
	run: Run,
	value: unknown,
	callback: unknown,
	what: string,
	gather: (
		results: unknown[],
		values: unknown[],
		keys: unknown[],
		isHash: boolean,
	) => unknown,
): unknown => {
	const fn = functionArgument(callback, what);
	const { values, keys, isHash } = entriesOf(run, value, what);
	const results: unknown[] = [];
	try {
		for (let i = 0; i < values.length; i++) {
			results.push(fn(values[i], keys[i]));
		}
	} catch (error) {
		// Earlier callbacks may have started async work. Stop their rejections being reported as unhandled.
		for (const result of results) silence(result);
		throw error;
	}
	if (results.some(isPromise)) {
		return all(results).then((resolved) =>
			hold(gather(resolved, values, keys, isHash)),
		);
	}
	return gather(results, values, keys, isHash);
};

const buildCollection = (
	isHash: boolean,
	keys: unknown[],
	items: unknown[],
): unknown[] | Record<string, unknown> => {
	if (!isHash) return items;
	const result: Record<string, unknown> = {};
	items.forEach((item, index) => {
		setOwn(result, String(keys[index]), item);
	});
	return result;
};

const syncResult = (value: unknown, what: string): unknown => {
	if (isPromise(value)) {
		value.catch(() => {});
		return issue(
			"invalid-argument",
			`"${what}" callbacks must not wait for async data`,
		);
	}
	return value;
};

/**
 * Removes HTML tags and comments. Where a `<` would end up before a letter once a tag after it is removed, it is
 * dropped too, so removing tags can't make new ones.
 */
const stripTags = (html: string): string => {
	const parts: string[] = [];
	scanHtml(
		html,
		(text) => {
			const last = parts.length - 1;
			const previous = parts[last];
			if (previous?.endsWith("<") && /^[a-zA-Z!?/]/.test(text)) {
				parts[last] = previous.slice(0, -1);
			}
			parts.push(text);
		},
		() => {},
	);
	return parts.join("");
};

/** `sort`'s order: natural order without `by`, by a key with a one-parameter arrow, or with a comparator. */
const sortBy = <T>(
	items: T[],
	read: (item: T) => unknown,
	by: unknown,
): T[] => {
	if (by === undefined || by === null) {
		return items.sort((a, b) => compare(read(a), read(b)));
	}
	const fn = functionArgument(by, "sort");
	if (fn.length >= 2) {
		return items.sort((a, b) => {
			const result = syncResult(fn(read(a), read(b)), "sort");
			return typeof result === "number"
				? result
				: issue("type-error", '"sort" comparator must return a number');
		});
	}
	const keyed = items.map((item) => ({
		item,
		key: syncResult(fn(read(item)), "sort"),
	}));
	keyed.sort((a, b) => compare(a.key, b.key));
	return keyed.map((entry) => entry.item);
};

const allStrings = (items: unknown[]): items is string[] => {
	for (let i = 0; i < items.length; i++) {
		if (typeof items[i] !== "string") return false;
	}
	return true;
};

/**
 * Sorts strings by UTF-16 code units, as the default sort does, which skips calling `compare`. Short lists, such as a
 * post's tags, sort in place by insertion, which keeps the same order and is faster for them.
 */
const sortStrings = (items: string[]): string[] => {
	if (items.length > 16) return items.sort();
	for (let i = 1; i < items.length; i++) {
		const item = items[i] as string;
		let j = i - 1;
		while (j >= 0 && (items[j] as string) > item) {
			items[j + 1] = items[j] as string;
			j--;
		}
		items[j + 1] = item;
	}
	return items;
};

/** A hash of keys and values in the order given. A `Map`, so keys that look like numbers keep their place too. */
const orderedHash = (
	keys: unknown[],
	values: unknown[],
): Map<string, unknown> =>
	new Map(keys.map((key, index) => [String(key), values[index]]));

// Case changes for markup's text.
const toUpper = (text: string): string => text.toUpperCase();
const toLower = (text: string): string => text.toLowerCase();
const upperPieces = (pieces: Pieces): Pieces => mapText(pieces, toUpper);
const lowerPieces = (pieces: Pieces): Pieces => mapText(pieces, toLower);

/** Escapes characters that could end a `<script>` element or break JavaScript, inside JSON strings. */
const escapeJson = (json: string): string =>
	json.replace(
		/[<>&\u2028\u2029]/g,
		(char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
	);

export const builtinFilters: Record<string, BuiltinEntry> = {
	// Changing case makes text at most three times longer, and changing it again doesn't add more, so these leave the
	// output limit to whatever prints the result. A check here would cost the commonest filters a fifth of their speed.
	upper: define((run, value) =>
		typeof value === "string"
			? value.toUpperCase()
			: value instanceof Markup
				? changeMarkup(run, value, upperPieces)
				: toStringArgument(value, '"upper"').toUpperCase(),
	),
	lower: define((run, value) =>
		typeof value === "string"
			? value.toLowerCase()
			: value instanceof Markup
				? changeMarkup(run, value, lowerPieces)
				: toStringArgument(value, '"lower"').toLowerCase(),
	),
	capitalize: define((run, value) =>
		typeof value !== "string" && value instanceof Markup
			? changeMarkup(run, value, capitalizePieces)
			: capitalizeText(toStringArgument(value, '"capitalize"')),
	),
	title: define((run, value) =>
		value instanceof Markup
			? changeMarkup(run, value, titlePieces)
			: titleText(toStringArgument(value, '"title"'), true),
	),
	trim: define(
		(run, value, characters, side = "both") => {
			if (side !== "both" && side !== "start" && side !== "end") {
				return issue(
					"invalid-argument",
					`"trim" side must be "both", "start" or "end", but got ${valueLabel(side)}`,
				);
			}
			const set =
				characters === undefined || characters === null
					? null
					: toStringArgument(characters, '"trim"');
			if (typeof value !== "string" && value instanceof Markup) {
				const trimText = (text: string, end: "start" | "end") =>
					set !== null
						? trimCharacters(text, set, end)
						: end === "start"
							? text.trimStart()
							: text.trimEnd();
				return changeMarkup(run, value, (pieces) =>
					trimPieces(pieces, side, trimText),
				);
			}
			const text = toStringArgument(value, '"trim"');
			if (set !== null) return trimCharacters(text, set, side);
			return side === "start"
				? text.trimStart()
				: side === "end"
					? text.trimEnd()
					: text.trim();
		},
		["characters", "side"],
	),
	replace: define(
		(run, value, search, replacement) => {
			const isPairs = isPlainObject(search) || search instanceof Map;
			if (value instanceof Markup) {
				const { strategy } = value;
				const pairs: [string, Insert][] = [];
				if (isPairs) {
					const { values, keys } = entriesOf(run, search, "replace");
					keys.forEach((key, index) => {
						pairs.push([
							String(key),
							insertedPiece(values[index], strategy, '"replace"'),
						]);
					});
				} else {
					pairs.push([
						search instanceof Markup
							? markupText(search)
							: toStringArgument(search, '"replace"'),
						insertedPiece(replacement, strategy, '"replace"'),
					]);
				}
				return changeMarkup(run, value, (pieces) =>
					pieces.flatMap((piece) =>
						typeof piece === "string"
							? replacePairs(run, piece, pairs)
							: [piece],
					),
				);
			}
			const text = toStringArgument(value, '"replace"');
			if (isPairs) {
				const { values, keys } = entriesOf(run, search, "replace");
				return joinText(
					replacePairs(
						run,
						text,
						keys.map((key, index) => [String(key), toStr(values[index])]),
					),
				);
			}
			const needle = toStringArgument(search, '"replace"');
			if (needle === "") return text;
			const parts = text.split(needle);
			const glue = toStringArgument(replacement, '"replace"');
			// Each match swaps the needle for the replacement.
			refuseLength(
				run,
				text.length + (parts.length - 1) * (glue.length - needle.length),
				"replace",
			);
			return parts.join(glue);
		},
		["search", "replacement"],
	),
	split: define(
		(run, value, separator, limit) => {
			const text = toStringArgument(value, '"split"');
			const glue = toStringArgument(separator, '"split"');
			const parts = glue === "" ? codePoints(text) : text.split(glue);
			consume(run, parts.length);
			if (limit === undefined || limit === null) return parts;
			return parts.slice(
				0,
				Math.max(0, integerArgument(limit, '"split" limit')),
			);
		},
		["separator", "limit"],
	),
	truncate: define(
		(run, value, length, ellipsis = "…") => {
			const max = integerArgument(length, '"truncate" length');
			if (value instanceof Markup) {
				const ending = insertedPiece(ellipsis, value.strategy, '"truncate"');
				return changeMarkup(run, value, (pieces) =>
					truncatePieces(pieces, max, ending),
				);
			}
			const text = toStringArgument(value, '"truncate"');
			if (text.length <= max) return text;
			const end = SURROGATE.test(text)
				? codePointOffset(text, max)
				: Math.max(0, max);
			if (max >= 0 && end === text.length) return text;
			// The ending can be any string, even the text itself, so the result can be longer than the text.
			return checkLength(
				run,
				text.slice(0, end).trimEnd() + toStringArgument(ellipsis, '"truncate"'),
			);
		},
		["length", "ellipsis"],
	),
	stripTags: define((run, value) => {
		if (!(value instanceof Markup)) {
			return stripTags(toStringArgument(value, '"stripTags"'));
		}
		// HTML markup's text stays escaped. Other markup's text is decoded, stripped and escaped again.
		return isHtmlStrategy(value.strategy)
			? new Markup(stripTags(value.value), value.strategy)
			: fromPieces(run, [stripTags(markupText(value))], value.strategy);
	}),
	nl2br: define((run, value) => {
		// Markup made for any strategy is also safe in HTML.
		const html =
			value instanceof Markup
				? value.value
				: escapeHtml(checkLength(run, toStr(value)));
		let breaks = 0;
		for (let i = 0; i < html.length; i++) {
			const code = html.charCodeAt(i);
			if (code === 10 || (code === 13 && html.charCodeAt(i + 1) !== 10)) {
				breaks++;
			}
		}
		refuseLength(run, html.length + breaks * 4, "nl2br");
		return new Markup(html.replace(/\r\n|\n|\r/g, "<br>$&"), "html");
	}),
	urlEncode: define((run, value) => {
		// Encoding again makes text three times longer each time, so it stops at the output limit.
		if (typeof value === "string") return escapeUrl(value, run.state.maxSize);
		const target = unwrap(value);
		if (isPlainObject(target) || target instanceof Map) {
			return queryString(run, target);
		}
		return escapeUrl(toStr(target), run.state.maxSize);
	}),
	json: define(
		(run, value, indent) => {
			if (
				indent !== undefined &&
				indent !== null &&
				typeof indent !== "number" &&
				typeof indent !== "string"
			) {
				return issue("type-error", '"json" indent must be a number or string');
			}
			// `JSON.stringify` indents by at most 10 characters.
			const width =
				typeof indent === "number"
					? Math.max(0, Math.min(10, Math.floor(indent)))
					: typeof indent === "string"
						? Math.min(10, indent.length)
						: 0;
			const data = toPlainData(
				value,
				() =>
					issue(
						"invalid-argument",
						'"json" cannot serialise a value that contains itself',
					),
				{
					what: "json",
					charge: (count) => consume(run, count),
					maxLength: run.state.maxSize,
					indent: width,
				},
			);
			return checkLength(
				run,
				escapeJson(JSON.stringify(data ?? null, null, indent ?? undefined)),
			);
		},
		["indent"],
	),
	length: define((run, value) => {
		if (value === null || value === undefined) return 0;
		if (typeof value === "string") return codePointLength(value);
		if (value instanceof Markup) return codePointLength(value.value);
		if (Array.isArray(value)) return value.length;
		if (value instanceof Set) return value.size;
		// Counts the entries templates can read, which is what loops see.
		if (isPlainObject(value)) {
			const count = hashKeys(value).length;
			consume(run, count);
			return count;
		}
		if (value instanceof Map) {
			consume(run, value.size);
			return mapContents(value).keys.length;
		}
		if (typeof value === "object" && Symbol.iterator in value) {
			return entriesOf(run, value, "length").values.length;
		}
		return issue("type-error", `"length" cannot measure a ${typeName(value)}`);
	}),
	first: define((run, value) => {
		if (Array.isArray(value)) return value[0] ?? null;
		const target = unwrap(value);
		if (typeof target === "string") {
			const code = target.codePointAt(0);
			return code === undefined ? null : String.fromCodePoint(code);
		}
		// A hash stops at its first key that templates can read.
		if (isPlainObject(target)) {
			for (const key in target) {
				if (Object.hasOwn(target, key) && !BLOCKED_NAMES.has(key)) {
					return target[key] ?? null;
				}
			}
			return null;
		}
		if (target instanceof Map) {
			for (const [key, item] of target) {
				if (typeof key !== "string" || !BLOCKED_NAMES.has(key)) {
					return item ?? null;
				}
			}
			return null;
		}
		return listOf(run, target, "first")[0] ?? null;
	}),
	last: define((run, value) => {
		const target = unwrap(value);
		if (typeof target === "string") return codePoints(target).pop() ?? null;
		const items = listOf(run, target, "last");
		return items[items.length - 1] ?? null;
	}),
	slice: define(
		(run, value, start, end) => {
			const from = integerArgument(start, '"slice" start');
			const to =
				end === undefined || end === null
					? undefined
					: integerArgument(end, '"slice" end');
			const target = unwrap(value);
			if (typeof target === "string")
				return codePoints(target).slice(from, to).join("");
			if (isHashLike(target)) {
				return issue(
					"type-error",
					'"slice" needs an array or string, but got a hash',
				);
			}
			const result = listOf(run, target, "slice").slice(from, to);
			consume(run, result.length);
			return result;
		},
		["start", "end"],
	),
	join: define(
		(run, value, glue = "", lastGlue) => {
			// An array with a string glue joins without copying, in the same order of checks.
			if (
				Array.isArray(value) &&
				typeof glue === "string" &&
				(lastGlue === undefined || lastGlue === null)
			) {
				consume(run, value.length);
				let text = "";
				for (let i = 0; i < value.length; i++) {
					const item: unknown = value[i];
					const piece = typeof item === "string" ? item : toStr(item);
					refuseLength(
						run,
						text.length + piece.length + (i > 0 ? glue.length : 0),
						"join",
					);
					if (i > 0) text += glue;
					text += piece;
				}
				return text;
			}
			const items = entriesOf(run, value, "join").values.map((item) =>
				toStr(item),
			);
			const separator = toStringArgument(glue, '"join"');
			const last =
				lastGlue === undefined || lastGlue === null || items.length < 2
					? separator
					: toStringArgument(lastGlue, '"join"');
			let length =
				items.length < 2
					? 0
					: (items.length - 2) * separator.length + last.length;
			for (const item of items) length += item.length;
			refuseLength(run, length, "join");
			if (last === separator) return items.join(separator);
			const final = items.pop() as string;
			return `${items.join(separator)}${last}${final}`;
		},
		["glue", "lastGlue"],
	),
	keys: define((run, value) => entriesOf(run, value, "keys").keys),
	merge: define((run, value, ...others) => {
		const all = [value, ...others].filter(
			(item) => item !== null && item !== undefined,
		);
		if (all.length === 0) return [];
		if (all.every((item) => Array.isArray(item) || item instanceof Set)) {
			// Charge for every item before building, so repeated merging cannot exhaust memory.
			consume(
				run,
				all.reduce<number>(
					(total, item) =>
						total +
						(Array.isArray(item) ? item.length : (item as Set<unknown>).size),
					0,
				),
			);
			const result: unknown[] = [];
			for (const item of all) {
				for (const entry of item as Iterable<unknown>) result.push(entry);
			}
			return result;
		}
		if (all.every((item) => isPlainObject(item) || item instanceof Map)) {
			const result: Record<string, unknown> = {};
			for (const item of all) {
				const { values, keys } = entriesOf(run, item, "merge");
				keys.forEach((key, index) => {
					setOwn(result, String(key), values[index]);
				});
			}
			return result;
		}
		return issue(
			"type-error",
			'"merge" needs all arrays or all hashes, not a mix',
		);
	}),
	reverse: define((run, value) => {
		const target = unwrap(value);
		if (typeof target === "string")
			return codePoints(target).reverse().join("");
		if (isHashLike(target)) {
			const { values, keys } = entriesOf(run, target, "reverse");
			return orderedHash([...keys].reverse(), [...values].reverse());
		}
		const items = listOf(run, target, "reverse");
		consume(run, items.length);
		return [...items].reverse();
	}),
	sort: define(
		(run, value, by) => {
			if (!Array.isArray(value) && isHashLike(value)) {
				const { values, keys } = entriesOf(run, value, "sort");
				const sorted = sortBy(
					keys.map((key, index) => ({ key, item: values[index] })),
					(entry) => entry.item,
					by,
				);
				return orderedHash(
					sorted.map((entry) => entry.key),
					sorted.map((entry) => entry.item),
				);
			}
			const items = [...listOf(run, value, "sort")];
			consume(run, items.length);
			if ((by === undefined || by === null) && allStrings(items)) {
				return sortStrings(items);
			}
			return sortBy(items, (item) => item, by);
		},
		["by"],
	),
	map: define(
		(run, value, callback) =>
			mapEntries(
				run,
				value,
				callback,
				"map",
				(results, _values, keys, isHash) =>
					buildCollection(isHash, keys, results),
			),
		["callback"],
	),
	filter: define(
		(run, value, callback) =>
			mapEntries(
				run,
				value,
				callback,
				"filter",
				(results, values, keys, isHash) => {
					const keptKeys: unknown[] = [];
					const kept: unknown[] = [];
					results.forEach((result, index) => {
						if (truthy(result)) {
							kept.push(values[index]);
							keptKeys.push(keys[index]);
						}
					});
					return buildCollection(isHash, keptKeys, kept);
				},
			),
		["callback"],
	),
	reduce: define(
		(run, value, callback, initial = null) => {
			const fn = functionArgument(callback, "reduce");
			const { values, keys } = entriesOf(run, value, "reduce");
			const from = (index: number, carry: unknown): unknown => {
				let current = carry;
				for (let i = index; i < values.length; i++) {
					const result = fn(current, values[i], keys[i]);
					if (isPromise(result)) {
						return result.then((resolved) =>
							hold(from(i + 1, unhold(resolved))),
						);
					}
					current = result;
				}
				return current;
			};
			return from(0, initial);
		},
		["callback", "initial"],
	),
	find: define(
		(run, value, callback) => {
			const fn = functionArgument(callback, "find");
			const { values, keys } = entriesOf(run, value, "find");
			const from = (index: number): unknown => {
				for (let i = index; i < values.length; i++) {
					const result = fn(values[i], keys[i]);
					if (isPromise(result)) {
						return result.then((resolved) =>
							hold(
								truthy(unhold(resolved)) ? (values[i] ?? null) : from(i + 1),
							),
						);
					}
					if (truthy(result)) return values[i] ?? null;
				}
				return null;
			};
			return from(0);
		},
		["callback"],
	),
	column: define(
		(run, value, name) => {
			const key = unwrap(name);
			if (typeof key !== "string" && typeof key !== "number") {
				return issue("type-error", '"column" needs a property name');
			}
			const items = listOf(run, value, "column");
			consume(run, items.length);
			return items.map((item) => readProperty(item, key));
		},
		["name"],
	),
	batch: define(
		(run, value, size, fill) => {
			const count = integerArgument(size, '"batch" size');
			if (count < 1)
				return issue("invalid-argument", '"batch" size must be at least 1');
			const items = listOf(run, value, "batch");
			const groupCount = Math.ceil(items.length / count);
			// Padding can create far more items than went in, so charge for the output size.
			consume(run, fill === undefined ? items.length : groupCount * count);
			const groups: unknown[][] = [];
			for (let i = 0; i < items.length; i += count) {
				groups.push(items.slice(i, i + count));
			}
			const last = groups[groups.length - 1];
			if (last && fill !== undefined) {
				while (last.length < count) last.push(fill);
			}
			return groups;
		},
		["size", "fill"],
	),
	abs: define((_run, value) => Math.abs(toNumber(value, "abs"))),
	round: define(
		(_run, value, precision = 0, method = "common") =>
			roundNumber(
				toNumber(value, "round"),
				integerArgument(precision, '"round" precision'),
				toStringArgument(method, '"round" method'),
			),
		["precision", "method"],
	),
	formatNumber: define(
		(run, value, options) => {
			const formatter = cachedFormatter(
				"number",
				run,
				options,
				NUMBER_OPTIONS,
				() => ({}),
				(locale, settings) =>
					numberFormat(new Intl.NumberFormat(locale, settings)),
			);
			if (value === null || value === undefined) return "";
			return formatter(toNumber(value, "formatNumber"));
		},
		[],
		true,
	),
	plural: define(
		(run, value, one, other, zero, two, few, many, options) => {
			const rules = cachedFormatter(
				"plural",
				run,
				options,
				PLURAL_OPTIONS,
				() => ({}),
				(locale, settings) => new Intl.PluralRules(locale, settings),
			);
			if (value === null || value === undefined) return "";
			const count = toNumber(value, "plural");
			if (other === null || other === undefined) {
				return issue("invalid-argument", '"plural" needs an "other" form');
			}
			const forms = { zero, one, two, few, many, other };
			const form = toStringArgument(
				forms[rules.select(count)] ?? other,
				'"plural"',
			);
			if (!form.includes("#")) return form;
			const formatter = cachedFormatter(
				"number",
				run,
				options,
				PLURAL_OPTIONS,
				() => ({}),
				(locale, settings) =>
					numberFormat(new Intl.NumberFormat(locale, settings)),
			);
			const number = formatter(count);
			const parts = form.split("#");
			refuseLength(
				run,
				form.length + (parts.length - 1) * (number.length - 1),
				"plural",
			);
			return parts.join(number);
		},
		["one", "other", "zero", "two", "few", "many"],
		true,
	),
	formatDate: define(
		(run, value, options) => {
			const formatter = cachedFormatter(
				"date",
				run,
				options,
				DATE_OPTIONS,
				(settings) => ({
					timeZone: run.state.timeZone,
					...(Object.keys(settings).some((key) => DATE_STYLE_OPTIONS.has(key))
						? {}
						: { dateStyle: "medium" }),
				}),
				(locale, resolved) =>
					dateFormat(new Intl.DateTimeFormat(locale, resolved)),
			);
			if (value === null || value === undefined) return "";
			return formatter(toTime(value, '"formatDate"'));
		},
		[],
		true,
	),
};
