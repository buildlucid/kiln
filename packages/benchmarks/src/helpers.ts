/**
 * Helpers for engines that lack a built-in with the same behaviour as Kiln's. An engine registers these as filters,
 * helpers or functions, the way its users would add their own. Each matches Kiln's output exactly, so the check
 * before benchmarking can compare every engine's HTML.
 */

const dates = new Intl.DateTimeFormat("en-GB", {
	dateStyle: "medium",
	timeZone: "UTC",
});
const prices = new Intl.NumberFormat("en-GB", {
	style: "currency",
	currency: "GBP",
});
const numbers = new Intl.NumberFormat("en-GB");

export const helpers = {
	/** `"2026-01-01T12:00:00.000Z"` → `"1 Jan 2026"`. */
	formatDate: (value: string) => dates.format(new Date(value)),
	/** `49.5` → `"£49.50"`. */
	formatPrice: (value: number) => prices.format(value),
	/** `18342` → `"18,342"`. */
	formatNumber: (value: number) => numbers.format(value),
	/** Cuts text to `length` characters, trims trailing spaces and adds `…` if it cut anything. */
	truncate: (value: string, length: number) =>
		value.length <= length ? value : `${value.slice(0, length).trimEnd()}…`,
	/** Encodes text for a URL query, as `encodeURIComponent` does, plus `!'()*`. */
	urlEncode: (value: string) =>
		encodeURIComponent(value).replace(
			/[!'()*]/g,
			(char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
		),
};
