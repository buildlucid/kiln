import { issue } from "../errors.js";
import { getAttr, readableNames } from "../runtime/access.js";
import { Markup } from "../runtime/markup.js";
import {
	hashKeys,
	isPlainObject,
	MISSING,
	templateFunctions,
	typeName,
} from "../runtime/values.js";

/** Iterables from the host are read up to this many items, so an endless generator cannot hang a filter. */
const MAX_ITERABLE_ITEMS = 1_000_000;

/** Values and keys of anything a filter can treat as a list. Hashes keep their keys. */
export const entriesOf = (
	value: unknown,
	what: string,
	limit = MAX_ITERABLE_ITEMS,
): { values: unknown[]; keys: unknown[]; isHash: boolean } => {
	if (value === null || value === undefined) {
		return { values: [], keys: [], isHash: false };
	}
	if (Array.isArray(value)) {
		return {
			values: value,
			keys: value.map((_, index) => index),
			isHash: false,
		};
	}
	if (isPlainObject(value)) {
		const keys = hashKeys(value);
		return { values: keys.map((key) => value[key]), keys, isHash: true };
	}
	if (value instanceof Map) {
		const keys = [...value.keys()].filter((key) => typeof key === "string");
		return { values: keys.map((key) => value.get(key)), keys, isHash: true };
	}
	if (
		typeof value === "object" &&
		!(value instanceof Markup) &&
		typeof (value as { [Symbol.iterator]?: unknown })[Symbol.iterator] ===
			"function"
	) {
		const values: unknown[] = [];
		for (const item of value as Iterable<unknown>) {
			values.push(item);
			if (values.length > limit) {
				return issue(
					"limit-steps",
					`"${what}" got an iterable with more than ${limit} items`,
				);
			}
		}
		return { values, keys: values.map((_, index) => index), isHash: false };
	}
	return issue(
		"type-error",
		`"${what}" needs an array or hash, but got a ${typeName(value)}`,
	);
};

/** Items of an array, set or other iterable, as an array. */
export const listOf = (value: unknown, what: string): unknown[] => {
	if (Array.isArray(value)) return value;
	return entriesOf(value, what).values;
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

/**
 * Converts a value into plain JSON data, following the safety model: hashes by own keys, class instances by exposed members only.
 *
 * `onCycle` decides what a repeated object becomes. `charge` is called with the number of items in each list or hash
 * before they are copied, so a value that shares one object in many places can't make unlimited work.
 */
export const toPlainData = (
	value: unknown,
	onCycle: () => unknown,
	charge: (count: number) => void = () => {},
): unknown => {
	const seen = new Set<object>();
	const convert = (value: unknown): unknown => {
		if (value === null || value === undefined) return null;
		switch (typeof value) {
			case "string":
			case "boolean":
				return value;
			case "number":
				return Number.isFinite(value) ? value : null;
			case "bigint":
				return value.toString();
			case "function":
			case "symbol":
				return undefined;
		}
		if (value instanceof Markup) return value.value;
		if (value instanceof Date) {
			return Number.isNaN(value.getTime()) ? null : value.toISOString();
		}
		const object = value as object;
		if (seen.has(object)) return onCycle();
		seen.add(object);
		try {
			if (Array.isArray(object)) {
				charge(object.length);
				return object.map((item) => convert(item) ?? null);
			}
			if (object instanceof Set) {
				charge(object.size);
				return [...object].map((item) => convert(item) ?? null);
			}
			const result: Record<string, unknown> = {};
			const names =
				object instanceof Map
					? [...object.keys()].filter(
							(key): key is string => typeof key === "string",
						)
					: readableNames(object);
			charge(names.length);
			for (const name of names) {
				const item = convert(getAttr(object, name));
				if (item !== undefined && item !== MISSING) {
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
	return convert(value);
};
