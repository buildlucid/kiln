import type { Span } from "../source.js";
import { fail } from "./render.js";
import {
	additionLog,
	Capture,
	type Out,
	type RenderState,
	type Run,
} from "./types.js";

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
 * Where an outlet stands in the render's output. An outlet reached in output running ahead stands in that buffer until
 * it joins the render's; see `ahead.ts`.
 */
export type OutletMark = {
	out: Out;
	offset: number;
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

/** An `add to` that ran ahead of a part that waits, kept until a `flush` checks it. See `checkLate`. */
export type LateAddition = {
	readonly addition: Addition;
	readonly run: Run;
	readonly span: Span;
};

/**
 * Records an addition in the log of the capture `run` is in, or the render's. A `once` tag that already added keeps
 * its first content. New content for a closed outlet is an error, since the outlet's part of the page may have been
 * sent.
 *
 * Only parts that run ahead of nothing, or `front` ones whose parts before are all done, note a `once` tag's first
 * content: until then, a part before may still add the same tag. `add to` waits until then for a tag not added yet.
 */
export const recordAddition = (
	run: Run,
	span: Span,
	addition: Addition,
	front = false,
): void => {
	const state = run.state;
	const ahead = !front && run.capture !== null && run.capture.behind !== null;
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
		throw closedError(run, span, addition.outlet);
	}
	if (ahead) (state.late ??= []).push({ addition, run, span });
	else if (addition.once !== null) {
		(state.once ??= new Map()).set(addition.once, addition.html);
	}
	additionLog(run).push(addition);
};

/**
 * After a `flush` closes outlets, fails for content a part running ahead added to one of them before then. Every part
 * before the flush is done and in the log by now, so content outside the log comes after the flush in the template,
 * where adding to a closed outlet is an error.
 */
export const checkLate = (state: RenderState): void => {
	const late = state.late;
	if (late === null) return;
	const logged = new Set(additionsIn(state.additions ?? []));
	for (const { addition, run, span } of late) {
		if (logged.has(addition)) continue;
		const mark = state.outlets?.get(addition.outlet);
		if (mark === undefined || mark.content === null) continue;
		// A repeat of a `once` tag that added before the flush adds nothing new.
		if (addition.once !== null && state.once?.has(addition.once)) continue;
		throw closedError(run, span, addition.outlet);
	}
	state.late = late.filter(({ addition }) => !logged.has(addition));
};

const closedError = (run: Run, span: Span, outlet: string) =>
	fail(
		run,
		span,
		"outlet-closed",
		`Outlet "${outlet}" was closed by "flush", so content can't be added to it any more`,
	);

/** Closes every outlet reached so far, fixing its content. */
export const closeOutlets = (state: RenderState): void => {
	if (state.outlets === null) return;
	for (const [name, mark] of state.outlets) {
		if (mark.content === null) mark.content = contentFor(state, name);
	}
};

/** An outlet's content: what was added to it, in order, without repeats of `once` tags. */
const contentFor = (state: RenderState, name: string): string => {
	const seen = new Set<string>();
	let content = "";
	for (const addition of additionsIn(state.additions ?? [])) {
		if (addition.outlet !== name) continue;
		if (addition.once !== null) {
			if (seen.has(addition.once)) continue;
			seen.add(addition.once);
		}
		content += addition.html;
	}
	return content;
};

/** Moves the outlets reached in `from`, output that ran ahead, into `to`, which it joined at `offset`. */
export const moveOutlets = (
	state: RenderState,
	from: Out,
	to: Out,
	offset: number,
): void => {
	if (state.outlets === null) return;
	for (const mark of state.outlets.values()) {
		if (mark.out !== from) continue;
		mark.out = to;
		mark.offset += offset;
	}
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
	// Outlets are marked in the order they are reached, which is their order in the output. One in output running
	// ahead comes after all of the render's output so far.
	for (const mark of state.outlets.values()) {
		if (index++ < state.takenOutlets) continue;
		if (mark.out !== state.root) break;
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
