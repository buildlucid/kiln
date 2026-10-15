import { issue } from "../errors.js";
import { escapeHtml, escapeUrl } from "../runtime/escape.js";
import { Markup } from "../runtime/markup.js";
import { checkLength, consume, isPromise, silence } from "../runtime/render.js";
import type { CallableEntry, Run } from "../runtime/types.js";
import {
	compare,
	hashKeys,
	isHashLike,
	isPlainObject,
	setOwn,
	toNumber,
	toStr,
	toStringArgument,
	truthy,
	typeName,
	unwrap,
} from "../runtime/values.js";
import {
	entriesOf,
	functionArgument,
	integerArgument,
	listOf,
	readProperty,
	toDate,
	toPlainData,
} from "./helpers.js";

type BuiltinEntry = Extract<CallableEntry, { kind: "builtin" }>;

const define = (
	call: BuiltinEntry["call"],
	params: readonly string[] = [],
	options = false,
): BuiltinEntry => ({ kind: "builtin", call, params, options });

/** Counts code points without allocating an array. */
const codePointLength = (text: string): number => {
	let count = 0;
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if (code < 0xdc00 || code > 0xdfff) count++;
	}
	return count;
};

const trimCharacters = (
	text: string,
	characters: string,
	side: string,
): string => {
	const set = new Set(characters);
	const chars = [...text];
	let start = 0;
	let end = chars.length;
	if (side !== "end")
		while (start < end && set.has(chars[start] as string)) start++;
	if (side !== "start")
		while (end > start && set.has(chars[end - 1] as string)) end--;
	return chars.slice(start, end).join("");
};

/** Replaces several strings at once, preferring the longest match at each position. */
const replacePairs = (text: string, pairs: [string, string][]): string => {
	const sorted = pairs
		.filter(([search]) => search !== "")
		.sort((a, b) => b[0].length - a[0].length);
	if (sorted.length === 0) return text;
	let result = "";
	let i = 0;
	outer: while (i < text.length) {
		for (const [search, replacement] of sorted) {
			if (text.startsWith(search, i)) {
				result += replacement;
				i += search.length;
				continue outer;
			}
		}
		result += text[i];
		i++;
	}
	return result;
};

const roundNumber = (
	value: number,
	precision: number,
	method: string,
): number => {
	const shift = (number: number, exponent: number) => {
		const [mantissa, power = "0"] = String(number).split("e");
		return Number(`${mantissa}e${Number(power) + exponent}`);
	};
	switch (method) {
		case "ceil":
			return shift(Math.ceil(shift(value, precision)), -precision);
		case "floor":
			return shift(Math.floor(shift(value, precision)), -precision);
		case "common": {
			const rounded = shift(
				Math.round(shift(Math.abs(value), precision)),
				-precision,
			);
			return value < 0 ? -rounded : rounded;
		}
		default:
			return issue(
				"invalid-argument",
				`"round" method must be "common", "ceil" or "floor", but got "${method}"`,
			);
	}
};

const queryString = (value: unknown, prefix: string | null): string[] => {
	const parts: string[] = [];
	const { values, keys } = entriesOf(value, "urlEncode");
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
			parts.push(...queryString(item, key));
		} else {
			parts.push(`${escapeUrl(key)}=${escapeUrl(toStr(item))}`);
		}
	}
	return parts;
};

const formatterCache = new Map<
	string,
	Intl.NumberFormat | Intl.DateTimeFormat
>();

/** Splits `locale` out of filter options and caches the formatter by its settings. */
const cachedFormatter = <T extends Intl.NumberFormat | Intl.DateTimeFormat>(
	kind: "number" | "date",
	run: Run,
	options: unknown,
	defaults: Record<string, unknown>,
	create: (locale: string, options: Record<string, unknown>) => T,
): T => {
	if (options !== undefined && options !== null && !isPlainObject(options)) {
		return issue(
			"type-error",
			`Formatting options must be a hash, but got a ${typeName(options)}`,
		);
	}
	const { locale = run.state.locale, ...rest } = (options ?? {}) as Record<
		string,
		unknown
	>;
	if (typeof locale !== "string") {
		return issue("type-error", '"locale" must be a string');
	}
	const settings = { ...defaults, ...rest };
	const key = `${kind}|${locale}|${JSON.stringify(settings)}`;
	let formatter = formatterCache.get(key) as T | undefined;
	if (!formatter) {
		formatter = create(locale, settings);
		if (formatterCache.size > 500) formatterCache.clear();
		formatterCache.set(key, formatter);
	}
	return formatter;
};

/** Calls a template callback for each item, then gathers the results, waiting only if one was a promise. */
const mapEntries = (
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
	const { values, keys, isHash } = entriesOf(value, what);
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
		return Promise.all(results).then((resolved) =>
			gather(resolved, values, keys, isHash),
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

/** Finds the `>` that ends a tag, skipping `>` inside quoted attribute values. Returns -1 when the tag never ends. */
const tagEnd = (text: string, from: number): number => {
	let quote = "";
	for (let i = from; i < text.length; i++) {
		const char = text[i];
		if (quote) {
			if (char === quote) quote = "";
		} else if (char === '"' || char === "'") quote = char;
		else if (char === ">") return i;
	}
	return -1;
};

/**
 * Removes HTML comments and tags in one linear pass. A `<` that never closes is kept as text.
 */
const stripTags = (text: string): string => {
	let result = "";
	let index = 0;
	let commentsCanClose = true;
	let tagsCanClose = true;
	for (;;) {
		const open = text.indexOf("<", index);
		if (open === -1) return result + text.slice(index);
		if (commentsCanClose && text.startsWith("<!--", open)) {
			const close = text.indexOf("-->", open + 4);
			if (close !== -1) {
				result += text.slice(index, open);
				index = close + 3;
				continue;
			}
			// No later comment can close either.
			commentsCanClose = false;
		}
		let nameStart = open + 1;
		const marker = text[nameStart];
		if (marker === "!" || marker === "?" || marker === "/") nameStart++;
		if (tagsCanClose && /[a-zA-Z]/.test(text[nameStart] ?? "")) {
			const close = tagEnd(text, nameStart);
			if (close !== -1) {
				result += text.slice(index, open);
				index = close + 1;
				continue;
			}
			tagsCanClose = false;
		}
		result += text.slice(index, open + 1);
		index = open + 1;
	}
};

/** Escapes characters that could end a `<script>` element or break JavaScript, inside JSON strings. */
const escapeJson = (json: string): string =>
	json.replace(
		/[<>&\u2028\u2029]/g,
		(char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
	);

export const builtinFilters: Record<string, BuiltinEntry> = {
	upper: define((_run, value) =>
		toStringArgument(value, '"upper"').toUpperCase(),
	),
	lower: define((_run, value) =>
		toStringArgument(value, '"lower"').toLowerCase(),
	),
	capitalize: define((_run, value) => {
		const text = toStringArgument(value, '"capitalize"');
		const first = text.codePointAt(0);
		if (first === undefined) return "";
		const head = String.fromCodePoint(first);
		return head.toUpperCase() + text.slice(head.length).toLowerCase();
	}),
	title: define((_run, value) =>
		toStringArgument(value, '"title"')
			.toLowerCase()
			.replace(
				/(^|[^\p{L}\p{N}'’])(\p{L})/gu,
				(_match, before: string, letter: string) =>
					before + letter.toUpperCase(),
			),
	),
	trim: define(
		(_run, value, characters, side = "both") => {
			const text = toStringArgument(value, '"trim"');
			if (side !== "both" && side !== "start" && side !== "end") {
				return issue(
					"invalid-argument",
					`"trim" side must be "both", "start" or "end", but got "${String(side)}"`,
				);
			}
			if (characters === undefined || characters === null) {
				return side === "start"
					? text.trimStart()
					: side === "end"
						? text.trimEnd()
						: text.trim();
			}
			return trimCharacters(text, toStringArgument(characters, '"trim"'), side);
		},
		["characters", "side"],
	),
	replace: define(
		(run, value, search, replacement) => {
			const text = toStringArgument(value, '"replace"');
			if (isPlainObject(search) || search instanceof Map) {
				const { values, keys } = entriesOf(search, "replace");
				consume(run, keys.length);
				return checkLength(
					run,
					replacePairs(
						text,
						keys.map((key, index) => [String(key), toStr(values[index])]),
					),
				);
			}
			const needle = toStringArgument(search, '"replace"');
			if (needle === "") return text;
			const parts = text.split(needle);
			const glue = toStringArgument(replacement, '"replace"');
			if ((parts.length - 1) * glue.length + text.length > run.state.maxSize) {
				return issue(
					"limit-output",
					`"replace" would build a string longer than the output limit of ${run.state.maxSize}`,
				);
			}
			return parts.join(glue);
		},
		["search", "replacement"],
	),
	split: define(
		(run, value, separator, limit) => {
			const text = toStringArgument(value, '"split"');
			const glue = toStringArgument(separator, '"split"');
			const parts = glue === "" ? [...text] : text.split(glue);
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
		(_run, value, length, ellipsis = "…") => {
			const text = toStringArgument(value, '"truncate"');
			const max = integerArgument(length, '"truncate" length');
			if (codePointLength(text) <= max) return text;
			return (
				[...text].slice(0, Math.max(0, max)).join("").trimEnd() +
				toStringArgument(ellipsis, '"truncate"')
			);
		},
		["length", "ellipsis"],
	),
	stripTags: define((_run, value) =>
		stripTags(toStringArgument(value, '"stripTags"')),
	),
	nl2br: define((_run, value) => {
		const html =
			value instanceof Markup && value.strategy === "html"
				? value.value
				: escapeHtml(toStr(value));
		return new Markup(html.replace(/\r\n|\n|\r/g, "<br>$&"), "html");
	}),
	urlEncode: define((_run, value) => {
		const target = unwrap(value);
		if (isPlainObject(target) || target instanceof Map) {
			return queryString(target, null).join("&");
		}
		return escapeUrl(toStr(target));
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
			const data = toPlainData(value, () =>
				issue(
					"invalid-argument",
					'"json" cannot serialise a value that contains itself',
				),
			);
			return checkLength(
				run,
				escapeJson(JSON.stringify(data ?? null, null, indent ?? undefined)),
			);
		},
		["indent"],
	),
	length: define((_run, value) => {
		if (value === null || value === undefined) return 0;
		if (typeof value === "string") return codePointLength(value);
		if (value instanceof Markup) return codePointLength(value.value);
		if (Array.isArray(value)) return value.length;
		if (value instanceof Map || value instanceof Set) return value.size;
		if (isPlainObject(value)) return hashKeys(value).length;
		if (typeof value === "object" && Symbol.iterator in value) {
			return entriesOf(value, "length").values.length;
		}
		return issue("type-error", `"length" cannot measure a ${typeName(value)}`);
	}),
	first: define((_run, value) => {
		const target = unwrap(value);
		if (typeof target === "string") {
			const code = target.codePointAt(0);
			return code === undefined ? null : String.fromCodePoint(code);
		}
		return listOf(target, "first")[0] ?? null;
	}),
	last: define((_run, value) => {
		const target = unwrap(value);
		if (typeof target === "string") return [...target].pop() ?? null;
		const items = listOf(target, "last");
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
				return [...target].slice(from, to).join("");
			if (isHashLike(target)) {
				return issue(
					"type-error",
					'"slice" needs an array or string, but got a hash',
				);
			}
			const result = listOf(target, "slice").slice(from, to);
			consume(run, result.length);
			return result;
		},
		["start", "end"],
	),
	join: define(
		(run, value, glue = "", lastGlue) => {
			const items = entriesOf(value, "join").values.map((item) => toStr(item));
			consume(run, items.length);
			const separator = toStringArgument(glue, '"join"');
			if (lastGlue === undefined || lastGlue === null || items.length < 2) {
				return checkLength(run, items.join(separator));
			}
			const last = items.pop() as string;
			return checkLength(
				run,
				`${items.join(separator)}${toStringArgument(lastGlue, '"join"')}${last}`,
			);
		},
		["glue", "lastGlue"],
	),
	keys: define((run, value) => {
		const { keys } = entriesOf(value, "keys");
		consume(run, keys.length);
		return keys;
	}),
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
				const { values, keys } = entriesOf(item, "merge");
				consume(run, keys.length);
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
		if (typeof target === "string") return [...target].reverse().join("");
		const items = listOf(target, "reverse");
		consume(run, items.length);
		return [...items].reverse();
	}),
	sort: define(
		(run, value, by) => {
			const items = [...listOf(value, "sort")];
			consume(run, items.length);
			if (by === undefined || by === null) return items.sort(compare);
			const fn = functionArgument(by, "sort");
			if (fn.length >= 2) {
				return items.sort((a, b) => {
					const result = syncResult(fn(a, b), "sort");
					return typeof result === "number"
						? result
						: issue("type-error", '"sort" comparator must return a number');
				});
			}
			const keyed = items.map((item) => ({
				item,
				key: syncResult(fn(item), "sort"),
			}));
			keyed.sort((a, b) => compare(a.key, b.key));
			return keyed.map((entry) => entry.item);
		},
		["by"],
	),
	map: define(
		(_run, value, callback) =>
			mapEntries(value, callback, "map", (results, _values, keys, isHash) =>
				buildCollection(isHash, keys, results),
			),
		["callback"],
	),
	filter: define(
		(_run, value, callback) =>
			mapEntries(value, callback, "filter", (results, values, keys, isHash) => {
				const keptKeys: unknown[] = [];
				const kept: unknown[] = [];
				results.forEach((result, index) => {
					if (truthy(result)) {
						kept.push(values[index]);
						keptKeys.push(keys[index]);
					}
				});
				return buildCollection(isHash, keptKeys, kept);
			}),
		["callback"],
	),
	reduce: define(
		(_run, value, callback, initial = null) => {
			const fn = functionArgument(callback, "reduce");
			const { values, keys } = entriesOf(value, "reduce");
			const from = (index: number, carry: unknown): unknown => {
				let current = carry;
				for (let i = index; i < values.length; i++) {
					const result = fn(current, values[i], keys[i]);
					if (isPromise(result)) {
						return result.then((resolved) => from(i + 1, resolved));
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
		(_run, value, callback) => {
			const fn = functionArgument(callback, "find");
			const { values, keys } = entriesOf(value, "find");
			const from = (index: number): unknown => {
				for (let i = index; i < values.length; i++) {
					const result = fn(values[i], keys[i]);
					if (isPromise(result)) {
						return result.then((resolved) =>
							truthy(resolved) ? (values[i] ?? null) : from(i + 1),
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
			const items = listOf(value, "column");
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
			const items = listOf(value, "batch");
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
				String(method),
			),
		["precision", "method"],
	),
	formatNumber: define(
		(run, value, options) => {
			const formatter = cachedFormatter(
				"number",
				run,
				options,
				{},
				(locale, settings) => new Intl.NumberFormat(locale, settings),
			);
			if (value === null || value === undefined) return "";
			return formatter.format(toNumber(value, "formatNumber"));
		},
		[],
		true,
	),
	formatDate: define(
		(run, value, options) => {
			const settings = (isPlainObject(options) ? options : {}) as Record<
				string,
				unknown
			>;
			const hasStyle = Object.keys(settings).some(
				(key) => key !== "locale" && key !== "timeZone",
			);
			const formatter = cachedFormatter(
				"date",
				run,
				options,
				{
					timeZone: run.state.timeZone,
					...(hasStyle ? {} : { dateStyle: "medium" }),
				},
				(locale, resolved) => new Intl.DateTimeFormat(locale, resolved),
			);
			if (value === null || value === undefined) return "";
			return formatter.format(toDate(value, '"formatDate"'));
		},
		[],
		true,
	),
};
