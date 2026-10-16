import type { IslandEntry, JsonValue } from "./islands.js";
import type { Addition } from "./outlets.js";
import { isPlainObject } from "./values.js";

/*
 * The value the `cache` tag gives a store to save. It is Kiln's own string, so what a saved copy holds can change
 * without stores changing: the HTML, what the section added to outlets, the islands it deferred, and whether it holds
 * the `<kiln-island>` script. A value from another version of the format reads as missing, so the section renders
 * again and the copy is replaced.
 */

const VERSION = 2;

export type Saved = {
	html: string;
	additions: Addition[];
	islands: IslandEntry[];
	islandScript: boolean;
};

/** Makes the value a store saves. */
export const packSaved = ({
	html,
	additions,
	islands,
	islandScript,
}: Saved): string =>
	JSON.stringify({
		v: VERSION,
		html,
		add: additions.map((addition) => [
			addition.outlet,
			addition.html,
			addition.once,
		]),
		isl: islands.map((island) => [island.template, island.props]),
		scr: islandScript,
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
	const { v, html, add, isl, scr } = parsed as Record<string, unknown>;
	if (
		v !== VERSION ||
		typeof html !== "string" ||
		!Array.isArray(add) ||
		!Array.isArray(isl) ||
		typeof scr !== "boolean"
	) {
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
	const islands: IslandEntry[] = [];
	for (const item of isl) {
		if (!Array.isArray(item)) return null;
		const [template, props] = item as unknown[];
		if (typeof template !== "string" || !isPlainObject(props)) return null;
		// Parsed JSON holds only JSON values.
		islands.push({ template, props: props as Record<string, JsonValue> });
	}
	return { html, additions, islands, islandScript: scr };
};
