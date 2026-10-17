import type { Span } from "../source.js";
import { fail } from "./render.js";
import { additionLog, Capture, type RenderState, type Run } from "./types.js";

/*
 * Outlets and `add to`.
 *
 * An outlet marks a place in the render's output, and `add to` records content for an outlet by name. Nothing is
 * written at an outlet until it closes, at `flush` or when the render ends, so content added after the outlet still
 * reaches it.
 *
 * Additions are a log rather than text written into place, so a cached section can save the ones it made and replay
 * them, and so a streamed render can send output as soon as it is final: everything before the first open outlet.
 */

/**
 * Stands for the outlet's indentation in added content, which is rendered before the outlet may be reached. The
 * outlet puts its own indentation in place when it closes, so content lines up the same whichever runs first, and a
 * cached section's additions line up wherever they are replayed. A Unicode noncharacter, meant for uses like this.
 *
 * Indentation only starts lines, so only a marker at the start of an addition or after a line break is replaced. The
 * same character elsewhere, in your data, is left alone.
 */
export const OUTLET_INDENT = "\uFDD0";

const INDENT_MARKERS = /(?:^|\n)\uFDD0/g;

/** Where an outlet stands in the render's output, and the indentation its content takes. */
export type OutletMark = {
	readonly offset: number;
	readonly indent: string;
	/** The outlet shares its line, so the content's first line gets no indentation. */
	readonly inline: boolean;
	/** The outlet's content once it is closed, or null while content can still be added. */
	content: string | null;
};

/** One `add to` that ran. `once` names the tag when it has `once`, or is null. */
export type Addition = {
	readonly outlet: string;
	readonly html: string;
	readonly once: string | null;
};

/** The additions in a log, in order, with each capture's in its place. See `Capture`. */
export const additionsIn = (
	log: readonly (Addition | Capture)[],
	into: Addition[] = [],
): Addition[] => {
	for (const entry of log) {
		if (entry instanceof Capture) {
			if (entry.additions !== null) additionsIn(entry.additions, into);
		} else into.push(entry);
	}
	return into;
};

/**
 * Records an addition in the log of the capture `run` is in, or the render's. A `once` tag that already added keeps
 * its first content. New content for a closed outlet is an error, since the outlet's part of the page may have been
 * sent.
 */
export const recordAddition = (
	run: Run,
	span: Span,
	addition: Addition,
): void => {
	const state = run.state;
	if (addition.once !== null) {
		const first = state.once?.get(addition.once);
		// A repeat adds nothing new, so it is fine after the outlet closed.
		if (first !== undefined) {
			const repeat =
				first === addition.html ? addition : { ...addition, html: first };
			additionLog(run).push(repeat);
			return;
		}
	}
	const mark = state.outlets?.get(addition.outlet);
	if (mark !== undefined && mark.content !== null) {
		throw fail(
			run,
			span,
			"outlet-closed",
			`Outlet "${addition.outlet}" was closed by "flush", so content can't be added to it any more`,
		);
	}
	if (addition.once !== null) {
		(state.once ??= new Map()).set(addition.once, addition.html);
	}
	additionLog(run).push(addition);
};

/** Closes every outlet reached so far, fixing its content. */
export const closeOutlets = (state: RenderState): void => {
	if (state.outlets === null) return;
	for (const [name, mark] of state.outlets) {
		if (mark.content === null) mark.content = contentFor(state, name, mark);
	}
};

/** An outlet's content: what was added to it, in order, without repeats of `once` tags. */
const contentFor = (
	state: RenderState,
	name: string,
	mark: OutletMark,
): string => {
	const seen = new Set<string>();
	let content = "";
	for (const addition of additionsIn(state.additions ?? [])) {
		if (addition.outlet !== name) continue;
		if (addition.once !== null) {
			if (seen.has(addition.once)) continue;
			seen.add(addition.once);
		}
		// The outlet shares its line, so the first line of its content needs no indentation.
		const html =
			content === "" && mark.inline && addition.html.startsWith(OUTLET_INDENT)
				? addition.html.slice(OUTLET_INDENT.length)
				: addition.html;
		content += html.replace(INDENT_MARKERS, (marker) =>
			marker === OUTLET_INDENT ? mark.indent : `\n${mark.indent}`,
		);
	}
	return content;
};

/**
 * Takes the part of the render's output that is final and not yet taken: up to the first open outlet, with each
 * closed outlet's content in place. Close the outlets first to take the rest of the output.
 */
export const takeOutput = (state: RenderState, output: string): string => {
	if (state.outlets === null) {
		const text = state.taken === 0 ? output : output.slice(state.taken);
		state.taken = output.length;
		return text;
	}
	let text = "";
	let index = 0;
	// Outlets are marked in the order they are reached, which is their order in the output.
	for (const mark of state.outlets.values()) {
		if (index++ < state.takenOutlets) continue;
		text += output.slice(state.taken, mark.offset);
		state.taken = mark.offset;
		if (mark.content === null) return text;
		text += mark.content;
		state.takenOutlets++;
	}
	text += output.slice(state.taken);
	state.taken = output.length;
	return text;
};
