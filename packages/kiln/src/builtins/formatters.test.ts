import { describe, expect, test } from "vite-plus/test";
import { dateFormat, numberFormat } from "./formatters.js";

/** A seeded pseudo-random number generator, so every run checks the same values. */
const random = (seed: number) => () => {
	seed = (seed + 0x6d2b79f5) | 0;
	let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
	t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
	return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/** Counts calls to a formatter's `format` from now on. */
const countCalls = (intl: Intl.NumberFormat | Intl.DateTimeFormat) => {
	const calls = { count: 0 };
	const format = intl.format.bind(intl);
	Object.defineProperty(intl, "format", {
		value: (value: number) => {
			calls.count++;
			return format(value);
		},
	});
	return calls;
};

const LOCALES = [
	"en-GB",
	"en-US",
	"en-IN",
	"de-DE",
	"de-CH",
	"fr-FR",
	"es-ES",
	"it-IT",
	"nl-NL",
	"pl-PL",
	"pt-BR",
	"sv-SE",
	"ru-RU",
	"ja-JP",
	"zh-CN",
	"hi-IN",
	"ar-EG",
];

const numbers = (): number[] => {
	const next = random(1);
	const values: number[] = [];
	for (let i = 0; i < 1500; i++) {
		const magnitude = 10 ** Math.floor(next() * 16 - 3);
		let value = next() * magnitude;
		// Values on a rounding boundary, such as 2.675 and 12.5.
		if (i % 5 === 0) value = Math.round(value * 1000) / 1000 + 0.0005;
		if (i % 7 === 0) value = Math.round(value) + 0.5;
		values.push(i % 3 === 0 ? -value : value);
	}
	return values;
};

describe("numberFormat", () => {
	const values = numbers();
	const settings: Intl.NumberFormatOptions[] = [
		{},
		{ maximumFractionDigits: 0 },
		{ minimumFractionDigits: 2 },
		{ maximumFractionDigits: 5 },
		{ style: "currency", currency: "GBP" },
		{ style: "currency", currency: "EUR" },
		{ style: "currency", currency: "JPY" },
		{ style: "currency", currency: "USD", currencyDisplay: "code" },
		{ useGrouping: false },
		{ style: "percent" },
		{ notation: "compact" },
		{ maximumSignificantDigits: 3 },
		{ style: "currency", currency: "USD", currencySign: "accounting" },
	];

	test.each(LOCALES)("formats as Intl does in %s", (locale) => {
		for (const options of settings) {
			const intl = new Intl.NumberFormat(locale, options);
			const format = numberFormat(intl);
			for (const value of values) {
				if (format(value) !== intl.format(value)) {
					expect([locale, options, value, format(value)]).toEqual([
						locale,
						options,
						value,
						intl.format(value),
					]);
				}
			}
		}
	});

	test("formats common settings without calling Intl", () => {
		for (const options of settings.slice(0, 9)) {
			const intl = new Intl.NumberFormat("en-GB", options);
			const format = numberFormat(intl);
			const calls = countCalls(intl);
			format(1234.5);
			format(-0.25);
			expect([options, calls.count]).toEqual([options, 0]);
		}
	});
});

describe("dateFormat", () => {
	const next = random(2);
	const times: number[] = [];
	for (let i = 0; i < 800; i++) {
		// Mostly recent years, with some from anywhere between 1000 and 9999.
		const span = i % 4 === 0 ? 2.5e14 : 4e12;
		times.push(
			Math.floor((next() - 0.5) * span + (i % 4 === 0 ? 7e13 : 1.7e12)),
		);
	}
	const settings: Intl.DateTimeFormatOptions[] = [
		{ dateStyle: "medium" },
		{ dateStyle: "short" },
		{ dateStyle: "long" },
		{ dateStyle: "full" },
		{ dateStyle: "medium", timeStyle: "short" },
		{ timeStyle: "medium" },
		{ year: "numeric", month: "2-digit", day: "2-digit" },
		{ year: "2-digit", month: "numeric", day: "numeric" },
		{ weekday: "long", day: "numeric", month: "long" },
		{ hour: "numeric", minute: "2-digit", hour12: true },
		{ hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false },
		{ month: "short", year: "numeric" },
		{ year: "numeric", month: "short", day: "numeric", era: "short" },
	];

	test.each(LOCALES)("formats as Intl does in %s", (locale) => {
		for (const options of settings) {
			for (const timeZone of ["UTC", "Europe/London"]) {
				const intl = new Intl.DateTimeFormat(locale, { ...options, timeZone });
				const format = dateFormat(intl);
				for (const time of times) {
					if (format(time) !== intl.format(time)) {
						expect([locale, options, timeZone, time, format(time)]).toEqual([
							locale,
							options,
							timeZone,
							time,
							intl.format(time),
						]);
					}
				}
			}
		}
	});

	test("formats common settings without calling Intl", () => {
		for (const options of settings.slice(0, 7)) {
			const intl = new Intl.DateTimeFormat("en-GB", {
				...options,
				timeZone: "UTC",
			});
			const format = dateFormat(intl);
			const calls = countCalls(intl);
			format(Date.UTC(2026, 9, 17, 9, 30));
			expect([options, calls.count]).toEqual([options, 0]);
		}
	});
});
