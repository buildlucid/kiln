/*
 * Formatting numbers and dates as `Intl` does, faster.
 *
 * An `Intl` formatter takes a few hundred nanoseconds a call, which adds up on a page of prices and dates. For the usual
 * settings, the pattern a formatter follows can be read from its own output once: the text around the digits, the
 * separators and how digits group, or for dates the order of the fields and the names of months and weekdays. Each value
 * then only needs string work.
 *
 * A pattern is only used once it formats a set of samples exactly as the formatter does. Settings it can't follow, and
 * values outside the range it handles, go to the formatter itself, so the output is always the formatter's.
 */

/** Formats a number or a time in milliseconds since the epoch. */
export type Format = (value: number) => string;

// Numbers

type NumberPattern = {
	readonly prefix: string;
	readonly suffix: string;
	readonly negativePrefix: string;
	readonly negativeSuffix: string;
	readonly decimal: string;
	readonly group: string;
	/** Digits in the group next to the decimal point, and in each group before it. */
	readonly primary: number;
	readonly secondary: number;
	/** Integer digits a number needs before it is grouped. */
	readonly grouping: number;
	readonly minimumFraction: number;
	readonly maximumFraction: number;
};

/** The parts of a formatted number around its digits. */
type NumberParts = {
	prefix: string;
	suffix: string;
	integers: string[];
	group: string;
	decimal: string;
};

const DIGIT_PARTS = new Set(["integer", "group", "decimal", "fraction"]);

const readNumber = (
	intl: Intl.NumberFormat,
	value: number,
): NumberParts | null => {
	const parts = intl.formatToParts(value);
	const first = parts.findIndex((part) => part.type === "integer");
	if (first === -1) return null;
	let last = first;
	for (let i = first; i < parts.length; i++) {
		if (DIGIT_PARTS.has((parts[i] as Intl.NumberFormatPart).type)) last = i;
	}
	const result: NumberParts = {
		prefix: "",
		suffix: "",
		integers: [],
		group: "",
		decimal: "",
	};
	for (let i = 0; i < parts.length; i++) {
		const { type, value: text } = parts[i] as Intl.NumberFormatPart;
		if (i < first) result.prefix += text;
		else if (i > last) result.suffix += text;
		else if (type === "integer") result.integers.push(text);
		else if (type === "group") result.group = text;
		else if (type === "decimal") result.decimal = text;
		else if (type !== "fraction") return null;
	}
	return result;
};

const readNumberPattern = (intl: Intl.NumberFormat): NumberPattern | null => {
	const options = intl.resolvedOptions() as unknown as Record<string, unknown>;
	if (
		options.numberingSystem !== "latn" ||
		options.notation !== "standard" ||
		(options.style !== "decimal" && options.style !== "currency") ||
		(options.currencyDisplay !== undefined &&
			options.currencyDisplay !== "symbol" &&
			options.currencyDisplay !== "narrowSymbol" &&
			options.currencyDisplay !== "code") ||
		(options.currencySign !== undefined &&
			options.currencySign !== "standard") ||
		options.signDisplay !== "auto" ||
		options.roundingMode !== "halfExpand" ||
		options.roundingIncrement !== 1 ||
		options.roundingPriority !== "auto" ||
		options.trailingZeroDisplay !== "auto" ||
		options.minimumIntegerDigits !== 1 ||
		options.minimumSignificantDigits !== undefined ||
		options.maximumSignificantDigits !== undefined ||
		typeof options.minimumFractionDigits !== "number" ||
		typeof options.maximumFractionDigits !== "number"
	) {
		return null;
	}
	const positive = readNumber(intl, 123456789012.5);
	const negative = readNumber(intl, -123456789012.5);
	if (positive === null || negative === null) return null;
	const sizes = positive.integers.map((digits) => digits.length);
	const primary = sizes.at(-1) as number;
	const secondary = sizes.length > 2 ? (sizes.at(-2) as number) : primary;
	let grouping = Infinity;
	if (sizes.length > 1) {
		if ((readNumber(intl, 10 ** primary)?.integers.length ?? 0) > 1) {
			grouping = primary + 1;
		} else if (
			(readNumber(intl, 10 ** (primary + 1))?.integers.length ?? 0) > 1
		) {
			grouping = primary + 2;
		} else return null;
	}
	return {
		prefix: positive.prefix,
		suffix: positive.suffix,
		negativePrefix: negative.prefix,
		negativeSuffix: negative.suffix,
		decimal: positive.decimal,
		group: positive.group,
		primary,
		secondary,
		grouping,
		minimumFraction: options.minimumFractionDigits as number,
		maximumFraction: options.maximumFractionDigits as number,
	};
};

/** Adds one to the last digit of a string of digits. */
const increment = (digits: string): string => {
	let i = digits.length - 1;
	while (i >= 0 && digits.charCodeAt(i) === 57) i--;
	if (i < 0) return `1${"0".repeat(digits.length)}`;
	return (
		digits.slice(0, i) +
		String.fromCharCode(digits.charCodeAt(i) + 1) +
		"0".repeat(digits.length - i - 1)
	);
};

/**
 * Formats with a number pattern, or returns null for values it doesn't handle. `Intl` rounds the shortest decimal
 * that reads back as the number, half away from zero, which is what `String` gives here: `1.005` rounds to `1.01`.
 */
const formatNumber = (pattern: NumberPattern, value: number): string | null => {
	if (!(value > -1e15 && value < 1e15)) return null;
	const negative = value < 0 || Object.is(value, -0);
	const magnitude = negative ? -value : value;
	if (magnitude !== 0 && magnitude < 1e-6) return null;
	const text = String(magnitude);
	const dot = text.indexOf(".");
	let integer = dot === -1 ? text : text.slice(0, dot);
	let fraction = dot === -1 ? "" : text.slice(dot + 1);
	const { minimumFraction, maximumFraction } = pattern;
	if (fraction.length > maximumFraction) {
		const up = fraction.charCodeAt(maximumFraction) >= 53;
		fraction = fraction.slice(0, maximumFraction);
		if (up) {
			const digits = increment(integer + fraction);
			integer = digits.slice(0, digits.length - maximumFraction);
			fraction = digits.slice(digits.length - maximumFraction);
		}
	}
	let end = fraction.length;
	while (end > minimumFraction && fraction.charCodeAt(end - 1) === 48) end--;
	if (end < fraction.length) fraction = fraction.slice(0, end);
	while (fraction.length < minimumFraction) fraction += "0";
	if (integer.length >= pattern.grouping) {
		const { primary, secondary, group } = pattern;
		let grouped = integer.slice(-primary);
		let rest = integer.slice(0, -primary);
		while (rest.length > secondary) {
			grouped = rest.slice(-secondary) + group + grouped;
			rest = rest.slice(0, -secondary);
		}
		integer = rest + group + grouped;
	}
	const digits =
		fraction === "" ? integer : integer + pattern.decimal + fraction;
	return negative
		? pattern.negativePrefix + digits + pattern.negativeSuffix
		: pattern.prefix + digits + pattern.suffix;
};

/** Numbers a number pattern must format as its formatter does: rounding, grouping, signs and sizes. */
const NUMBER_SAMPLES = [
	0,
	-0,
	1,
	-1,
	0.5,
	1.5,
	2.5,
	-2.5,
	0.125,
	0.375,
	1.005,
	2.675,
	9.995,
	99.995,
	999.995,
	1.45,
	0.05,
	0.0049,
	0.00051,
	0.000001,
	7,
	12,
	123,
	999,
	1000,
	1234,
	9999,
	10000,
	12345,
	99999,
	123456,
	1234567,
	12345678.9,
	123456789.123,
	9999999.995,
	0.1 + 0.2,
	314159.26535,
	-1234.5678,
	-0.001,
	1e10 + 0.5,
	1e14 + 0.25,
	123456789012345,
	5.5555555,
	1 / 3,
	2 / 3,
	1e-6,
	42.000001,
];

/** A function that formats numbers as `intl` does, without calling it when its settings allow. */
export const numberFormat = (intl: Intl.NumberFormat): Format => {
	const format: Format = (value) => intl.format(value);
	const pattern = readNumberPattern(intl);
	if (pattern === null) return format;
	const fast: Format = (value) => formatNumber(pattern, value) ?? format(value);
	for (const sample of NUMBER_SAMPLES) {
		if (fast(sample) !== format(sample)) return format;
	}
	return fast;
};

// Dates

/** One field or literal of a date pattern. */
type DatePart =
	| { kind: "text"; text: string }
	| { kind: "year"; twoDigit: boolean }
	| { kind: "month"; names: readonly string[] | null; twoDigit: boolean }
	| { kind: "day"; twoDigit: boolean }
	| { kind: "weekday"; names: readonly string[] }
	| { kind: "hour"; twoDigit: boolean; twelve: boolean }
	| { kind: "minute"; twoDigit: boolean }
	| { kind: "second"; twoDigit: boolean }
	| { kind: "dayPeriod"; names: readonly [string, string] };

const DAY = 86_400_000;

/** Times a date pattern handles, the years 1000 to 9999. Others go to the formatter. */
const EARLIEST = Date.UTC(1000, 0, 1);
const LATEST = Date.UTC(9999, 11, 31, 23, 59, 59, 999);

/** A sample time: 5 March 2026, 13:07:09 UTC, a Thursday. */
const SAMPLE = Date.UTC(2026, 2, 5, 13, 7, 9);

const partOf = (
	intl: Intl.DateTimeFormat,
	time: number,
	type: Intl.DateTimeFormatPartTypes,
): string | null =>
	intl.formatToParts(time).find((part) => part.type === type)?.value ?? null;

const readDatePattern = (
	intl: Intl.DateTimeFormat,
): readonly DatePart[] | null => {
	const options = intl.resolvedOptions() as unknown as Record<string, unknown>;
	if (
		options.calendar !== "gregory" ||
		options.numberingSystem !== "latn" ||
		options.timeZone !== "UTC" ||
		options.dayPeriod !== undefined ||
		options.era !== undefined ||
		options.fractionalSecondDigits !== undefined ||
		(options.hourCycle !== undefined &&
			options.hourCycle !== "h23" &&
			options.hourCycle !== "h12")
	) {
		return null;
	}
	const parts: DatePart[] = [];
	for (const { type, value } of intl.formatToParts(SAMPLE)) {
		switch (type) {
			case "literal":
			case "timeZoneName":
				parts.push({ kind: "text", text: value });
				break;
			case "year":
				if (value !== "2026" && value !== "26") return null;
				parts.push({ kind: "year", twoDigit: value === "26" });
				break;
			case "month": {
				if (value === "3" || value === "03") {
					parts.push({ kind: "month", names: null, twoDigit: value === "03" });
					break;
				}
				const names: string[] = [];
				for (let month = 0; month < 12; month++) {
					const name = partOf(intl, Date.UTC(2026, month, 5), "month");
					if (name === null) return null;
					names.push(name);
				}
				parts.push({ kind: "month", names, twoDigit: false });
				break;
			}
			case "day":
				if (value !== "5" && value !== "05") return null;
				parts.push({ kind: "day", twoDigit: value === "05" });
				break;
			case "weekday": {
				// 1 March 2026 is a Sunday, so day k of March is weekday k - 1.
				const names: string[] = [];
				for (let day = 1; day <= 7; day++) {
					const name = partOf(intl, Date.UTC(2026, 2, day), "weekday");
					if (name === null) return null;
					names.push(name);
				}
				parts.push({ kind: "weekday", names });
				break;
			}
			case "hour": {
				const twelve = options.hourCycle === "h12";
				const early = partOf(intl, Date.UTC(2026, 2, 5, 5), "hour");
				if (early !== "5" && early !== "05") return null;
				parts.push({ kind: "hour", twoDigit: early === "05", twelve });
				break;
			}
			case "minute":
				if (value !== "7" && value !== "07") return null;
				parts.push({ kind: "minute", twoDigit: value === "07" });
				break;
			case "second":
				if (value !== "9" && value !== "09") return null;
				parts.push({ kind: "second", twoDigit: value === "09" });
				break;
			case "dayPeriod": {
				const am = partOf(intl, Date.UTC(2026, 2, 5, 1), "dayPeriod");
				const pm = partOf(intl, Date.UTC(2026, 2, 5, 13), "dayPeriod");
				if (am === null || pm === null) return null;
				parts.push({ kind: "dayPeriod", names: [am, pm] });
				break;
			}
			default:
				return null;
		}
	}
	return parts;
};

const pad = (value: number, twoDigit: boolean): string =>
	twoDigit && value < 10 ? `0${value}` : String(value);

/** Formats a time with a date pattern, working out the UTC date the way `Date` does without making one. */
const formatDate = (
	parts: readonly DatePart[],
	value: number,
): string | null => {
	if (!(value >= EARLIEST && value <= LATEST)) return null;
	const time = Math.trunc(value);
	const days = Math.floor(time / DAY);
	const ms = time - days * DAY;
	// Civil date from days since 1970-01-01, after Howard Hinnant's `civil_from_days`.
	const shifted = days + 719_468;
	const era = Math.floor(shifted / 146_097);
	const dayOfEra = shifted - era * 146_097;
	const yearOfEra = Math.floor(
		(dayOfEra -
			Math.floor(dayOfEra / 1460) +
			Math.floor(dayOfEra / 36_524) -
			Math.floor(dayOfEra / 146_096)) /
			365,
	);
	const dayOfYear =
		dayOfEra -
		(365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
	const shiftedMonth = Math.floor((5 * dayOfYear + 2) / 153);
	const day = dayOfYear - Math.floor((153 * shiftedMonth + 2) / 5) + 1;
	const month = shiftedMonth < 10 ? shiftedMonth + 3 : shiftedMonth - 9;
	const year = yearOfEra + era * 400 + (month <= 2 ? 1 : 0);
	// 1970-01-01 was a Thursday.
	const weekday = (((days + 4) % 7) + 7) % 7;
	const hour = Math.floor(ms / 3_600_000);
	const minute = Math.floor(ms / 60_000) % 60;
	const second = Math.floor(ms / 1000) % 60;
	let text = "";
	for (const part of parts) {
		switch (part.kind) {
			case "text":
				text += part.text;
				break;
			case "year":
				text += part.twoDigit ? pad(year % 100, true) : String(year);
				break;
			case "month":
				text +=
					part.names === null
						? pad(month, part.twoDigit)
						: (part.names[month - 1] as string);
				break;
			case "day":
				text += pad(day, part.twoDigit);
				break;
			case "weekday":
				text += part.names[weekday] as string;
				break;
			case "hour":
				text += pad(part.twelve ? hour % 12 || 12 : hour, part.twoDigit);
				break;
			case "minute":
				text += pad(minute, part.twoDigit);
				break;
			case "second":
				text += pad(second, part.twoDigit);
				break;
			case "dayPeriod":
				text += part.names[hour < 12 ? 0 : 1];
				break;
		}
	}
	return text;
};

/** Times a date pattern must format as its formatter does: every month and weekday, hours, leap days and centuries. */
const dateSamples = (): number[] => {
	const samples: number[] = [EARLIEST, LATEST, 0, -1];
	for (let month = 0; month < 12; month++) {
		for (const day of [1, 9, 10, 28]) {
			samples.push(Date.UTC(2026, month, day, (month * 2) % 24, day, month));
		}
	}
	for (let hour = 0; hour < 24; hour++) {
		samples.push(Date.UTC(1999, 11, 31, hour, 59, 59, 999));
	}
	for (const year of [1000, 1600, 1900, 1969, 2000, 2024, 2100, 9999]) {
		samples.push(Date.UTC(year, 1, 28), Date.UTC(year, 2, 1, 12));
	}
	samples.push(Date.UTC(2024, 1, 29, 0, 0, 1));
	return samples;
};

const DATE_SAMPLES = dateSamples();

/** A function that formats times as `intl` does, without calling it when its settings allow. */
export const dateFormat = (intl: Intl.DateTimeFormat): Format => {
	const format: Format = (value) => intl.format(value);
	const parts = readDatePattern(intl);
	if (parts === null) return format;
	const fast: Format = (value) => formatDate(parts, value) ?? format(value);
	for (const sample of DATE_SAMPLES) {
		if (fast(sample) !== format(sample)) return format;
	}
	return fast;
};
