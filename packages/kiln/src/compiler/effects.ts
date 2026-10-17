import type { Statement } from "../parser/ast.js";
import type { Plan } from "../runtime/ahead.js";
import type { EnvironmentCore } from "../runtime/types.js";

/**
 * What statements may do to the variables around them, and whether they may wait for a promise, found from their
 * syntax. Kiln uses it to start the statements after one that waits straight away, when they don't depend on it; see
 * `runtime/ahead.ts`.
 */
export type Effects = {
	/** Variables the statements may read, or null when they may read any, as content from elsewhere may. */
	readonly reads: ReadonlySet<string> | null;
	/** Variables the statements set themselves. */
	readonly sets: ReadonlySet<string>;
	/**
	 * They place content from elsewhere: a block, whose content may come from another template, `block()`, `parent()`
	 * or a slot, whose content comes from the caller. It reads any variable, and when it sets variables itself, it may
	 * set any that exists. See `contentSets`.
	 */
	readonly elsewhere: boolean;
	/** Whether the statements may wait for a promise. */
	readonly waits: boolean;
};

/** Tags that load another template or call your code, so they may wait. */
const LOADS = new Set([
	"Include",
	"Component",
	"Island",
	"Slot",
	"Block",
	"Cache",
	"Extends",
]);

/** The effects of statements, at any depth. Macros and imports do nothing where they stand. */
export const effectsOf = (
	statements: readonly Statement[],
	env: EnvironmentCore,
): Effects => {
	const reads = new Set<string>();
	const sets = new Set<string>();
	let elsewhere = false;
	let waits = false;
	// Iterative, because long expression chains can be thousands of levels deep.
	const stack: object[] = [statements];
	while (stack.length > 0) {
		const current = stack.pop() as object;
		if (Array.isArray(current)) {
			for (const item of current as unknown[]) {
				if (typeof item === "object" && item !== null) stack.push(item);
			}
			continue;
		}
		const node = current as Record<string, unknown> & { type?: string };
		switch (node.type) {
			case "Macro":
			case "Import":
			case "FromImport":
				continue;
			case "Name":
				reads.add(node.name as string);
				break;
			case "Set":
			case "SetBlock":
				sets.add(node.name as string);
				break;
			case "Props": {
				for (const prop of node.props as { name: string }[])
					sets.add(prop.name);
				if (node.rest !== null) sets.add(node.rest as string);
				break;
			}
			case "Block":
			case "Slot":
				elsewhere = true;
				break;
			case "Call": {
				const callee = node.callee as { type: string; name?: string };
				if (callee.type !== "Name") waits = true;
				else if (callee.name === "block" || callee.name === "parent") {
					elsewhere = true;
					waits = true;
				} else if (
					env.functions.get(callee.name as string)?.kind !== "builtin"
				) {
					// One of your functions, or a macro.
					waits = true;
				}
				break;
			}
			case "Filter":
				if (env.filters.get(node.name as string)?.kind === "host") waits = true;
				break;
			case "Test":
				if (env.tests.get(node.name as string)?.kind === "host") waits = true;
				break;
			case "Apply":
				for (const filter of node.filters as { name: string }[]) {
					if (env.filters.get(filter.name)?.kind === "host") waits = true;
				}
				break;
		}
		if (node.type !== undefined && LOADS.has(node.type)) waits = true;
		for (const key in node) {
			if (key === "span" || key === "nameSpan") continue;
			const value = node[key];
			if (typeof value === "object" && value !== null) stack.push(value);
		}
	}
	return { reads: elsewhere ? null : reads, sets, elsewhere, waits };
};

/**
 * Whether variables `sets` may set touch `names`. Null stands for any variable: content from elsewhere may read any,
 * and may set any.
 */
const touches = (
	sets: ReadonlySet<string> | null,
	names: ReadonlySet<string> | null,
): boolean => {
	if (sets === null) return names === null || names.size > 0;
	if (sets.size === 0) return false;
	if (names === null) return true;
	for (const name of sets) if (names.has(name)) return true;
	return false;
};

/**
 * Whether two parts can run in either order: neither sets a variable the other reads or sets. With `strict`, content
 * from elsewhere counts as setting any variable.
 */
export const independent = (
	a: Effects,
	b: Effects,
	strict: boolean,
): boolean => {
	const aSets = strict && a.elsewhere ? null : a.sets;
	const bSets = strict && b.elsewhere ? null : b.sets;
	return (
		!touches(aSets, b.reads) &&
		!touches(aSets, bSets) &&
		!touches(bSets, a.reads)
	);
};

/** Parts a waiting part looks past for ones that can start early. Compiling stays linear in long lists. */
const MAX_REACH = 256;

/** Parts a waiting part may hold back to let the ones after them start early. */
const MAX_GROUP = 64;

const merge = (a: Effects, b: Effects): Effects => ({
	reads:
		a.reads === null || b.reads === null
			? null
			: new Set([...a.reads, ...b.reads]),
	sets: new Set([...a.sets, ...b.sets]),
	elsewhere: a.elsewhere || b.elsewhere,
	waits: a.waits || b.waits,
});

/**
 * The plan for a list of parts, from each part's effects. See `Plan`. With `strict`, content from elsewhere counts as
 * setting any variable, for renders where it may; see `contentSets`. For a part that waits, the parts held back are
 * the fewest that leave a part that waits among the independent parts after them: holding back one part more can only
 * help when a later part depends on it.
 */
export const planOf = (effects: readonly Effects[], strict: boolean): Plan => {
	const after: number[] = [];
	const reach: number[] = [];
	effects.forEach((part, index) => {
		after.push(index);
		reach.push(index);
		if (!part.waits) return;
		const last = Math.min(effects.length - 1, index + MAX_REACH);
		const most = Math.min(last - 1, index + MAX_GROUP);
		let waiting = part;
		for (let group = index; group <= most; group++) {
			if (group > index) waiting = merge(waiting, effects[group] as Effects);
			let end = group;
			let waits = false;
			for (let next = group + 1; next <= last; next++) {
				const ahead = effects[next] as Effects;
				if (!independent(waiting, ahead, strict)) break;
				end = next;
				if (ahead.waits) waits = true;
			}
			if (waits) {
				after[index] = group;
				reach[index] = end;
				return;
			}
			// Everything after is independent, and none of it waits, so holding more back gains nothing.
			if (end === last) return;
		}
	});
	return { after, reach };
};
