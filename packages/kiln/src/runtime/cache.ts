import type { Addition } from "./outlets.js";

/*
 * The value the `cache` tag gives a store to save. It is Kiln's own string, so what a saved copy holds can change
 * without stores changing: the HTML, and what the section added to outlets. A value from another version of the format
 * reads as missing, so the section renders again and the copy is replaced.
 */

const VERSION = 1;

type Saved = { html: string; additions: Addition[] };

/** Makes the value a store saves. */
export const packSaved = (
	html: string,
	additions: readonly Addition[],
): string =>
	JSON.stringify({
		v: VERSION,
		html,
		add: additions.map((addition) => [
			addition.outlet,
			addition.html,
			addition.once,
		]),
	});

/** Reads a value a store returned, or returns null when it isn't one `packSaved` made. */
export const unpackSaved = (value: string): Saved | null => {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null) return null;
	const { v, html, add } = parsed as Record<string, unknown>;
	if (v !== VERSION || typeof html !== "string" || !Array.isArray(add)) {
		return null;
	}
	const additions: Addition[] = [];
	for (const item of add) {
		if (!Array.isArray(item)) return null;
		const [outlet, text, once] = item as unknown[];
		if (
			typeof outlet !== "string" ||
			typeof text !== "string" ||
			(once !== null && typeof once !== "string")
		) {
			return null;
		}
		additions.push({ outlet, html: text, once });
	}
	return { html, additions };
};
