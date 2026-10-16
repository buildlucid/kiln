import type { RenderState } from "./types.js";

/*
 * Outlets and `add to`.
 *
 * An outlet marks a place in the render's output, and `add to` records content for an outlet by name. Nothing is
 * written at an outlet until the render ends, when `fillOutlets` puts each outlet's content in place, so content
 * added after the outlet still reaches it.
 *
 * Additions are a log rather than text written into place, so a cached section can save the ones it made and replay
 * them, and so streaming can decide when an outlet's content is final: output before the first outlet can be sent
 * at once, and the rest once that outlet is filled.
 */

/** Where an outlet stands in the render's output, and the indentation its content takes. */
export type OutletMark = {
	readonly offset: number;
	readonly indent: string;
	/** The outlet shares its line, so the content's first line gets no indentation. */
	readonly inline: boolean;
};

/** One `add to` that ran. `once` names the tag when it has `once`, or is null. */
export type Addition = {
	readonly outlet: string;
	readonly html: string;
	readonly once: string | null;
};

/** Records an addition. A `once` tag that already added keeps its first content. */
export const recordAddition = (
	state: RenderState,
	addition: Addition,
): void => {
	if (addition.once !== null) {
		state.once ??= new Map();
		const first = state.once.get(addition.once);
		if (first === undefined) state.once.set(addition.once, addition.html);
		else if (first !== addition.html) addition = { ...addition, html: first };
	}
	(state.additions ??= []).push(addition);
};

/** Puts each outlet's content into the render's output, skipping repeats of `once` tags. */
export const fillOutlets = (state: RenderState, output: string): string => {
	if (state.outlets === null) return output;
	const additions = state.additions ?? [];
	const seen = new Set<string>();
	let result = "";
	let from = 0;
	// Outlets are marked in the order they are reached, which is their order in the output.
	for (const [name, mark] of state.outlets) {
		let content = "";
		for (const addition of additions) {
			if (addition.outlet !== name) continue;
			if (addition.once !== null) {
				if (seen.has(addition.once)) continue;
				seen.add(addition.once);
			}
			content += addition.html;
		}
		if (mark.inline && content.startsWith(mark.indent)) {
			content = content.slice(mark.indent.length);
		}
		result += output.slice(from, mark.offset) + content;
		from = mark.offset;
	}
	return result + output.slice(from);
};
